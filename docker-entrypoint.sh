#!/bin/sh
# Gamma container entrypoint: prepare the data volume, then start the server.
set -e

# Optional PUID/PGID (linuxserver.io convention): when either is set, own the
# data volume as that uid:gid and drop root before starting, so files Gamma
# creates on a bind mount belong to the host user instead of root. Unset →
# runs as root, exactly as before. setpriv ships in the base image; the
# dropped uid needs no passwd entry, so HOME moves somewhere writable.
AS_USER=""
if [ -n "${PUID}${PGID}" ]; then
    PUID="${PUID:-1000}"
    PGID="${PGID:-1000}"
    # Non-fatal: some mounts (Docker Desktop bind mounts, NFS with squash)
    # refuse chown but already present the files as the mounting user.
    chown -R "${PUID}:${PGID}" "${GAMMA_DATA_DIR:-/data}" \
        || echo "[entrypoint] warning: could not chown ${GAMMA_DATA_DIR:-/data}"
    export HOME=/tmp
    AS_USER="setpriv --reuid=${PUID} --regid=${PGID} --clear-groups"
fi

# Idempotent: creates the guest account and repairs missing per-user DBs.
# First-run accounts are the app's own job: an empty instance seeds an
# "admin" account with a random password printed once to the container log
# (override via GAMMA_ADMIN_USER/GAMMA_ADMIN_PASSWORD) at startup and
# never touches accounts again. Locked out? Use:
#   docker exec <container> python manage.py set-password <user> <new>
$AS_USER python manage.py setup

exec $AS_USER uvicorn app:app --host 0.0.0.0 --port "${GAMMA_PORT:-9001}"
