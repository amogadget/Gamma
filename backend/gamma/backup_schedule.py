"""Named backup tasks with UTC cron, task-specific retention and OS locking."""
import asyncio
import hashlib
import json
import os
import re
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone

from . import config, workspaces, ws_backup
from .db import connect_users_db
from .logbuf import log


class TaskError(ValueError):
    pass


class TaskBusy(TaskError):
    pass


def now():
    return datetime.now(timezone.utc)


def cron_fields(expression):
    """Numeric cron: wildcard, list, inclusive range and positive step.

    Sunday is 0 or 7. Restricted day fields use standard cron OR semantics.
    """
    fields = expression.split()
    if len(fields) != 5 or len(expression) > 200:
        raise TaskError("Use five cron fields: minute hour day-of-month month weekday.")
    parsed = []
    for field, (low, high) in zip(fields, [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]):
        values = set()
        for item in field.split(','):
            match = re.fullmatch(r'(\*|\d+(?:-\d+)?)(?:/(\d+))?', item)
            if not match:
                raise TaskError(f"Invalid cron field: {field}")
            base, step = match.groups()
            step = int(step or 1)
            if step < 1 or step > high - low + 1:
                raise TaskError(f"Invalid step in cron field: {field}")
            if base == '*':
                start, end = low, high
            elif '-' in base:
                start, end = map(int, base.split('-'))
            else:
                start = int(base)
                end = high if match.group(2) else start
            if not low <= start <= end <= high:
                raise TaskError(f"Cron field {field} must be between {low} and {high}.")
            values.update(range(start, end + 1, step))
        parsed.append(values)
    if 7 in parsed[4]:
        parsed[4].remove(7)
        parsed[4].add(0)
    return fields, parsed


def next_run(expression, after):
    fields, (minutes, hours, days, months, weekdays) = cron_fields(expression)
    after = after.astimezone(timezone.utc)
    date = after.replace(hour=0, minute=0, second=0, microsecond=0)
    for offset in range(366 * 5):
        day = date + timedelta(days=offset)
        dom, dow = day.day in days, (day.weekday() + 1) % 7 in weekdays
        matches = dom and dow if fields[2].startswith('*') or fields[4].startswith('*') else dom or dow
        if day.month not in months or not matches:
            continue
        for hour in sorted(hours):
            for minute in sorted(minutes):
                candidate = day.replace(hour=hour, minute=minute)
                if candidate > after:
                    return candidate.isoformat()
    raise TaskError("This schedule has no run in the next five years. Check the date fields.")


def root():
    return config.BACKUPS_DIR / 'tasks'


def task_path(task_id):
    if not re.fullmatch(r'[a-f0-9]{32}', task_id):
        raise TaskError("Backup task not found.")
    return root() / f'{task_id}.json'


def read(task_id):
    path = task_path(task_id)
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        raise TaskError("Backup task not found.")


def _write(task):
    path = task_path(task['id'])
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(task), encoding='utf-8')
    temp.replace(path)


@contextmanager
def locked(key):
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', key):
        raise TaskError("Invalid lock key.")
    root().mkdir(parents=True, exist_ok=True)
    with (root() / f'{key}.lock').open('a+b') as handle:
        handle.seek(0, 2)
        if not handle.tell():
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _account(owner):
    with connect_users_db() as conn:
        row = conn.execute('SELECT is_admin, is_guest FROM users WHERE username = ?', (owner,)).fetchone()
    if not row or row[1]:
        raise TaskError("The task owner no longer has an eligible account.")
    return bool(row[0])


def targets(task):
    admin = _account(task['owner'])
    ids = task['workspaces'] if task['scope'] == 'selected' else [
        w['id'] for w in workspaces.list_for_user(task['owner']) if w['role'] == 'owner']
    if not ids:
        raise TaskError("Select at least one workspace you own.")
    for ws in ids:
        if not workspaces.get(ws) or ws == workspaces.default_workspace('guest'):
            raise TaskError("A selected workspace is unavailable. Edit the task's selection.")
        if not admin and workspaces.role_of(ws, task['owner']) != 'owner':
            raise TaskError("The task owner no longer owns every selected workspace.")
    return ids


def list_tasks(owner):
    migrate_legacy()
    result = []
    for path in root().glob('*.json'):
        try:
            task = read(path.stem)
        except TaskError:
            if not path.exists():
                continue
            raise
        if task['owner'] == owner:
            result.append(task)
    return sorted(result, key=lambda t: (t['created_at'], t['id']))


def save(owner, data, task_id=None):
    data = {**data, 'cron': ' '.join(data['cron'].split())}
    if task_id:
        task_path(task_id)
    key = task_id or 'create-' + hashlib.sha256(owner.encode()).hexdigest()
    with locked(key) as acquired:
        if not acquired:
            raise TaskBusy("This task is busy. Try again after the backup finishes.")
        if task_id:
            task = read(task_id)
            if task['owner'] != owner:
                raise TaskError("Backup task not found.")
        else:
            if len(list_tasks(owner)) >= 100:
                raise TaskError("You can keep up to 100 backup tasks.")
            task = dict(id=uuid.uuid4().hex, owner=owner, created_at=now().isoformat(),
                        last_run=None, last_success=None, last_error=None, state='pending', requested=False)
        name = data['name'].strip()
        if not name:
            raise TaskError("Give this task a name.")
        next_time = next_run(data['cron'], now())
        updated = {**task, **data, 'name': name}
        # Owners can still pause a task after losing access to a target.
        if updated['enabled'] or not task_id:
            targets(updated)  # Recheck permissions again at execution.
        changed = not task_id or any(task.get(k) != updated[k] for k in ('cron', 'enabled'))
        updated['next_run'] = (next_time if changed else task.get('next_run')) if updated['enabled'] else None
        if not updated['enabled']:
            updated['requested'] = False
        _write(updated)
        return updated


def mutate(owner, task_id, action):
    task_path(task_id)
    with locked(task_id) as acquired:
        if not acquired:
            raise TaskBusy("This task is running. Try again when it finishes.")
        task = read(task_id)
        if task['owner'] != owner:
            raise TaskError("Backup task not found.")
        if action == 'delete':
            task_path(task_id).unlink()  # Keep all snapshots.
        else:
            targets(task)
            task.update(requested=True, state='queued')
            _write(task)
        return task


def _prune(task, ws, at):
    snapshots = [b for b in ws_backup.list_backups(ws) if b['task_id'] == task['id'] and b['scheduled']]
    # Filenames use local time; UTC creation times remain ordered across DST.
    snapshots.sort(key=lambda b: datetime.fromisoformat(b['created_at'].replace('Z', '+00:00'))
                   if b['created_at'] else datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    if task['retention_mode'] == 'count':
        expired = snapshots[task['retention_value']:]
    else:
        cutoff = at - timedelta(days=task['retention_value'])
        expired = [b for b in snapshots[1:] if b['created_at'] and
                   datetime.fromisoformat(b['created_at'].replace('Z', '+00:00')) < cutoff]
    for snapshot in expired:
        ws_backup.delete(ws, snapshot['name'])


def run_due(at=None):
    migrate_legacy()
    at = at or now()
    for path in root().glob('*.json'):
        try:
            with locked(path.stem) as acquired:
                if not acquired or not path.exists():
                    continue
                task = read(path.stem)
                due = task['enabled'] and task['next_run'] and datetime.fromisoformat(task['next_run']) <= at
                if not due and not task.get('requested'):
                    continue
                task.update(state='running', last_run=at.isoformat())
                _write(task)
                try:
                    ids = targets(task)
                    # Publish all selected snapshots before retention removes anything.
                    for ws in ids:
                        ws_backup.create(ws, label='task-' + task['id'][:12], uploads=task['uploads'],
                                         by=task['owner'], scheduled=True, task_id=task['id'])
                    for ws in ids:
                        _prune(task, ws, max(at, now()))
                    task.update(last_success=at.isoformat(), last_error=None, state='finished')
                    if due:
                        task['next_run'] = next_run(task['cron'], max(at, now()))
                except Exception as exc:
                    log.exception('[backups] Task %s failed', task['id'])
                    task.update(last_error=str(exc), state='failed')
                    if task['enabled']:
                        task['next_run'] = (max(at, now()) + timedelta(hours=1)).isoformat()
                task['requested'] = False
                _write(task)
        except Exception:
            log.exception('[backups] Could not process task %s', path.stem)


def migrate_legacy():
    """Import the previous per-workspace settings once; preserve old snapshots."""
    with locked('migration') as acquired:
        if not acquired:
            return
        for path in (config.BACKUPS_DIR / 'workspaces').glob('*/schedule.json'):
            ws = path.parent.name
            try:
                info = workspaces.get(ws)
                owners = [m['username'] for m in workspaces.members(ws) if m['role'] == 'owner']
                if not info or not owners or ws == workspaces.default_workspace('guest'):
                    continue
                old = json.loads(path.read_text(encoding='utf-8-sig'))
                task_id = hashlib.sha256(('legacy-backup:' + ws).encode()).hexdigest()[:32]
                if not task_path(task_id).exists():
                    _write(dict(id=task_id, owner=owners[0], name=info['name'] + ' backup',
                                scope='selected', workspaces=[ws], enabled=old['enabled'], uploads=old['uploads'],
                                cron='0 3 * * 1' if old['cadence'] == 'weekly' else '0 3 * * *',
                                retention_mode='count', retention_value=old.get('keep', 7),
                                created_at=now().isoformat(), next_run=old['next_run'],
                                last_run=old.get('last_success'), last_success=old.get('last_success'),
                                last_error=old.get('last_error'), state='pending', requested=False))
                path.rename(path.with_suffix('.migrated'))
            except Exception:
                log.exception('[backups] Could not migrate schedule for %s', ws)


@asynccontextmanager
async def lifespan():
    stop = asyncio.Event()

    async def loop():
        while not stop.is_set():
            try:
                await asyncio.to_thread(run_due)
            except Exception:
                log.exception('[backups] Scheduler round failed')
            try:
                await asyncio.wait_for(stop.wait(), timeout=30)
            except asyncio.TimeoutError:
                pass

    task = asyncio.create_task(loop())
    try:
        yield
    finally:
        stop.set()
        await task
