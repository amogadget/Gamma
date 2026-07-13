#!/bin/sh
# Gamma container entrypoint: prepare the data volume, then start the server.
set -e

# Idempotent: creates the guest account and repairs missing per-user DBs.
# First-run accounts are the app's own job: an empty instance seeds an
# "admin" account with a random password printed once to the container log
# (override via GAMMA_ADMIN_USER/GAMMA_ADMIN_PASSWORD) at startup and
# never touches accounts again. Locked out? Use:
#   docker exec <container> python manage.py set-password <user> <new>
python manage.py setup

exec uvicorn app:app --host 0.0.0.0 --port "${GAMMA_PORT:-9001}"
