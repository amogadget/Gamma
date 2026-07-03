#!/bin/sh
# Gamma container entrypoint: prepare the data volume, then start the server.
set -e

# Idempotent: creates the guest account and repairs missing per-user DBs.
python manage.py setup

# Optional bootstrap admin account from env (password is re-applied on every
# start so rotating GAMMA_ADMIN_PASSWORD takes effect on restart).
if [ -n "$GAMMA_ADMIN_USER" ] && [ -n "$GAMMA_ADMIN_PASSWORD" ]; then
    python manage.py create-user "$GAMMA_ADMIN_USER" "$GAMMA_ADMIN_PASSWORD"
    python manage.py set-password "$GAMMA_ADMIN_USER" "$GAMMA_ADMIN_PASSWORD"
fi

exec uvicorn app:app --host 0.0.0.0 --port "${GAMMA_PORT:-9001}"
