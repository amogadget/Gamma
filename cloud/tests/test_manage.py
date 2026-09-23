from contextlib import closing

import pytest
from conftest import register

from gammacloud import accounts, db
import manage


def test_cli_roundtrip(capsys):
    manage.main(["setup"])
    manage.main(["create-account", "carol@example.org", "carol", "--password", "correct horse battery", "--admin", "--verified"])
    manage.main(["set-plan", "carol", "pro"])
    manage.main(["list-accounts"])
    out = capsys.readouterr().out
    assert "carol" in out and "pro" in out and "admin" in out and "unverified" not in out
    manage.main(["invite", "--uses", "2", "--plan", "plus"])
    code = capsys.readouterr().out.strip()
    manage.main(["invites"])
    assert code in capsys.readouterr().out
    manage.main(["create-client", "share", "share-host", "https://share.example/api/auth/cloud/callback"])
    out = capsys.readouterr().out
    assert "client_id=gc_" in out and "client_secret=" in out
    manage.main(["rotate-key"])
    manage.main(["migrate", "--status"])
    assert f"v{db.SCHEMA_VERSION}" in capsys.readouterr().out
    manage.main(["backup"])
    assert "backups" in capsys.readouterr().out
    with pytest.raises(SystemExit):
        manage.main(["set-plan", "nobody", "pro"])


def test_purge_deleted(client):
    account = register(client)
    client.post("/api/me/delete", json={"password": "correct horse battery"})
    with closing(db.connect()) as conn:
        assert accounts.purge_deleted(conn, 30) == 0  # still in the grace period
        conn.execute("UPDATE accounts SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", (account["id"],))
        assert accounts.purge_deleted(conn, 30) == 1
        assert conn.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 0
        conn.commit()


def test_newer_db_refused():
    with closing(db.connect()) as conn:
        conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION + 1}")
        conn.commit()
    with pytest.raises(db.NewerDataError):
        db.ensure_current()

