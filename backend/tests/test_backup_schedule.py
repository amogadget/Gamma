from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from conftest import login, make_user, workspace_of
from gamma import backup_schedule as tasks, ws_backup
from gamma.routers.backup_tasks import TaskInput


@pytest.fixture
def workspace(tmp_path, monkeypatch, client):
    monkeypatch.setattr(tasks.config, 'BACKUPS_DIR', tmp_path / 'backups')
    return make_user('scheduled_owner', 'schedulepass1')


def create(ws, **changes):
    data = TaskInput(name='Nightly research', workspaces=[ws], **changes).model_dump()
    return tasks.save('scheduled_owner', data)


@pytest.mark.parametrize('cron,expected', [
    ('0 3 * * *', '2026-09-22T03:00:00+00:00'),
    ('0 3 * * 1', '2026-09-28T03:00:00+00:00'),
    ('*/15 3-5 * * 1-5', '2026-09-21T03:15:00+00:00'),
    ('0 9,17 * * 1-5', '2026-09-21T09:00:00+00:00'),
    ('0 0 31 * *', '2026-10-31T00:00:00+00:00'),
    ('0 0 29 2 *', '2028-02-29T00:00:00+00:00'),
    ('0 0 * * 7', '2026-09-27T00:00:00+00:00'),
    ('0 0 1 * 3', '2026-09-23T00:00:00+00:00'),
])
def test_cron_boundaries(cron, expected):
    assert tasks.next_run(cron, datetime(2026, 9, 21, 3, tzinfo=timezone.utc)) == expected


@pytest.mark.parametrize('cron', ['* * * *', '60 * * * *', '*/0 * * * *', '0 8-2 * * *', '0 0 30 2 *', '@daily', '0 0 * * MON'])
def test_invalid_cron(cron):
    with pytest.raises(tasks.TaskError):
        tasks.next_run(cron, datetime(2026, 9, 21, tzinfo=timezone.utc))


def test_api_ownership_validation_preview_and_persistence(workspace, guest):
    owner = login('scheduled_owner', 'schedulepass1')
    make_user('task_other', 'taskotherpass1')
    other = login('task_other', 'taskotherpass1')
    url = '/api/backup-tasks'
    payload = dict(name='Research', workspaces=[workspace], cron='0 2 * * *')
    assert guest.get(url).status_code == 403
    assert guest.post(url, json=payload).status_code == 403
    assert other.post(url, json=payload).status_code == 400
    assert owner.post(url, json={**payload, 'retention_value': 0}).status_code == 422
    assert owner.post(url, json={**payload, 'cron': 'nonsense'}).status_code == 400
    preview = owner.post(url + '/preview', json={'cron': payload['cron']}).json()
    assert len(preview['runs']) == 3 and preview['timezone'] == 'UTC'
    saved = owner.post(url, json=payload).json()
    assert saved == tasks.read(saved['id'])
    assert owner.get(url).json()['tasks'] == [saved]
    assert other.get(url).json()['tasks'] == []
    for method, suffix, body in [('put', '', payload), ('post', '/run', {}), ('delete', '', None)]:
        response = getattr(other, method)(f"{url}/{saved['id']}{suffix}", **({'json': body} if body is not None else {}))
        assert response.status_code == 404
    with tasks.locked(saved['id']):
        assert owner.put(f"{url}/{saved['id']}", json=payload).status_code == 409
        assert owner.post(f"{url}/{saved['id']}/run").status_code == 409
    assert owner.put(f"{url}/{saved['id']}", json={**payload, 'enabled': False}).json()['next_run'] is None


def test_task_retention_catchup_and_manual_isolation(workspace, monkeypatch):
    at = datetime(2026, 9, 1, 4, tzinfo=timezone.utc)
    monkeypatch.setattr(tasks, 'now', lambda: at)
    monkeypatch.setattr(ws_backup, 'time', SimpleNamespace(strftime=lambda _fmt: at.strftime('%Y%m%d-%H%M%S')))
    monkeypatch.setattr(ws_backup, 'page_now', lambda: at.isoformat())
    monkeypatch.setattr(ws_backup, 'MAX_PER_WORKSPACE', 1)
    manual = ws_backup.create(workspace, label='manual')
    count = create(workspace, retention_mode='count', retention_value=2)
    age = create(workspace, retention_mode='days', retention_value=2, uploads=False)
    for _ in range(5):
        at += timedelta(days=1)
        tasks.run_due(at)
    rows = ws_backup.list_backups(workspace)
    assert len([b for b in rows if b['task_id'] == count['id']]) == 2
    assert len([b for b in rows if b['task_id'] == age['id']]) == 3
    assert not any(b['uploads'] for b in rows if b['task_id'] == age['id'])
    assert ws_backup.info(workspace, manual['name'])
    before = {b['name'] for b in rows}
    tasks.run_due(at)
    assert {b['name'] for b in ws_backup.list_backups(workspace)} == before
    at += timedelta(days=10)
    tasks.run_due(at)
    assert len({b['name'] for b in ws_backup.list_backups(workspace)} - before) == 2
    with pytest.raises(ws_backup.BackupError):
        ws_backup.create(workspace, label='manual-full')
    before = ws_backup.list_backups(workspace)
    tasks.mutate('scheduled_owner', count['id'], 'delete')
    assert ws_backup.list_backups(workspace) == before


def test_run_now_paused_and_regular_schedule_preserved(workspace, monkeypatch):
    at = datetime(2026, 9, 21, 4, tzinfo=timezone.utc)
    monkeypatch.setattr(tasks, 'now', lambda: at)
    task = create(workspace, enabled=False)
    tasks.run_due(at)
    assert ws_backup.list_backups(workspace) == []
    tasks.mutate('scheduled_owner', task['id'], 'run')
    assert tasks.read(task['id'])['state'] == 'queued'
    tasks.run_due(at)
    state = tasks.read(task['id'])
    assert state['state'] == 'finished' and state['next_run'] is None
    assert len(ws_backup.list_backups(workspace)) == 1
    enabled = create(workspace)
    tasks.mutate('scheduled_owner', enabled['id'], 'run')
    tasks.run_due(at)
    assert tasks.read(enabled['id'])['next_run'] == enabled['next_run']


def test_failure_preserves_old_snapshots_and_retries(workspace, monkeypatch):
    at = datetime(2026, 9, 21, 4, tzinfo=timezone.utc)
    monkeypatch.setattr(tasks, 'now', lambda: at)
    task = create(workspace, retention_mode='count', retention_value=1)
    existing = ws_backup.create(workspace, scheduled=True, task_id=task['id'])
    at += timedelta(days=1)
    original = ws_backup.create

    def fail(*args, **kwargs):
        raise OSError('Disk is full')

    monkeypatch.setattr(ws_backup, 'create', fail)
    tasks.run_due(at)
    state = tasks.read(task['id'])
    assert state['state'] == 'failed' and state['last_error'] == 'Disk is full'
    assert state['next_run'] == (at + timedelta(hours=1)).isoformat()
    assert state['last_success'] is None
    assert ws_backup.info(workspace, existing['name'])
    monkeypatch.setattr(ws_backup, 'create', original)
    tasks.run_due(at + timedelta(hours=1))
    assert tasks.read(task['id'])['state'] == 'finished'
    assert tasks.read(task['id'])['last_error'] is None


def test_multiple_targets_dynamic_scope_and_revocation(workspace, monkeypatch):
    owner = login('scheduled_owner', 'schedulepass1')
    at = datetime(2026, 9, 21, 4, tzinfo=timezone.utc)
    monkeypatch.setattr(tasks, 'now', lambda: at)
    task = create(workspace, scope='all_owned')
    second = owner.post('/api/workspaces', json={'name': 'New library'}).json()['id']
    tasks.run_due(at + timedelta(days=1))
    assert ws_backup.list_backups(second)[0]['task_id'] == task['id']
    assert ws_backup.list_backups(workspace)[0]['task_id'] == task['id']
    selected = create(workspace)
    monkeypatch.setattr(tasks.workspaces, 'role_of', lambda *args: 'viewer')
    tasks.run_due(at + timedelta(days=1))
    assert tasks.read(selected['id'])['state'] == 'failed'
    assert 'no longer owns' in tasks.read(selected['id'])['last_error']
    assert not any(b['task_id'] == selected['id'] for b in ws_backup.list_backups(workspace))
    data = {k: v for k, v in selected.items() if k in TaskInput.model_fields}
    assert not tasks.save('scheduled_owner', {**data, 'enabled': False}, selected['id'])['enabled']
