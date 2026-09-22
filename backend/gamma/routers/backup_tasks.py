"""Account-owned backup tasks, independent of workspace snapshots."""
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import backup_schedule as tasks
from ..auth import require_personal_user

router = APIRouter(prefix='/api/backup-tasks', tags=['backups'])


class TaskInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    enabled: bool = True
    scope: Literal['selected', 'all_owned'] = 'selected'
    workspaces: list[str] = Field(default_factory=list, max_length=100)
    cron: str = Field(default='0 3 * * *', max_length=200)
    uploads: bool = True
    retention_mode: Literal['days', 'count'] = 'days'
    retention_value: int = Field(default=30, ge=1, le=3650)


class PreviewInput(BaseModel):
    cron: str = Field(max_length=200)


def owner(request):
    return require_personal_user(request, 'Sign in to manage backup tasks.')


def call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except tasks.TaskBusy as exc:
        raise HTTPException(409, str(exc))
    except tasks.TaskError as exc:
        raise HTTPException(404 if str(exc) == 'Backup task not found.' else 400, str(exc))


@router.get('')
def list_tasks(request: Request):
    return {'tasks': call(tasks.list_tasks, owner(request))}


@router.post('/preview')
def preview(payload: PreviewInput, request: Request):
    owner(request)
    at = tasks.now()
    runs = []
    for _ in range(3):
        value = call(tasks.next_run, payload.cron, at)
        runs.append(value)
        at = datetime.fromisoformat(value)
    return {'runs': runs, 'timezone': 'UTC'}


@router.post('')
def create(payload: TaskInput, request: Request):
    data = payload.model_dump()
    data['workspaces'] = list(dict.fromkeys(data['workspaces']))
    return call(tasks.save, owner(request), data)


@router.put('/{task_id}')
def update(task_id: str, payload: TaskInput, request: Request):
    data = payload.model_dump()
    data['workspaces'] = list(dict.fromkeys(data['workspaces']))
    return call(tasks.save, owner(request), data, task_id)


@router.post('/{task_id}/run')
def run(task_id: str, request: Request):
    return call(tasks.mutate, owner(request), task_id, 'run')


@router.delete('/{task_id}')
def delete(task_id: str, request: Request):
    call(tasks.mutate, owner(request), task_id, 'delete')
    return {'ok': True}
