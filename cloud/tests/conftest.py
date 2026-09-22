import os
import tempfile
from pathlib import Path

_DATA = Path(tempfile.mkdtemp(prefix="gammacloud-test-"))
os.environ["GAMMA_CLOUD_DATA_DIR"] = str(_DATA)
os.environ["GAMMA_CLOUD_MAIL"] = "memory"
os.environ["GAMMA_CLOUD_REGISTRATION"] = "invite"
os.environ["GAMMA_CLOUD_PUBLIC_URL"] = "http://testserver"
os.environ.pop("GAMMA_CLOUD_TURNSTILE_SECRET", None)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from gammacloud import config, db, mail, ratelimit  # noqa: E402
from gammacloud.app import create_app  # noqa: E402
from gammacloud.routers.admin import make_invite  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db():
    for f in _DATA.glob("cloud.db*"):
        f.unlink()
    mail.outbox.clear()
    ratelimit.clear()
    config.REGISTRATION = "invite"
    yield


@pytest.fixture
def client():
    with TestClient(create_app(), base_url="http://testserver") as c:
        yield c


def invite(uses=1, plan="free"):
    from contextlib import closing
    with closing(db.connect()) as conn:
        row = make_invite(conn, uses=uses, plan=plan, note="", created_by="test")
        conn.commit()
    return row["code"]


def register(client, handle="alice", email=None, password="correct horse battery", code=None):
    r = client.post("/api/register", json={"email": email or f"{handle}@example.org", "handle": handle,
                                           "password": password, "invite": code or invite()})
    assert r.status_code == 201, r.text
    return r.json()["account"]


def last_link(path):
    """The token of the newest mail whose link path matches."""
    for m in reversed(mail.outbox):
        for word in m["body"].split():
            if word.startswith(f"http://testserver{path}?token="):
                return word.split("token=", 1)[1]
    raise AssertionError(f"no mail with {path} link; outbox={mail.outbox}")


def verify(client, handle="alice"):
    r = client.post("/api/verify", json={"token": last_link("/verify")})
    assert r.status_code == 200, r.text
    assert r.json()["account"]["email_verified"] is True


def make_admin(handle):
    from contextlib import closing
    from gammacloud import accounts
    with closing(db.connect()) as conn:
        account = accounts.by_handle(conn, handle)
        accounts.set_admin(conn, account["id"], True, "test")
        conn.commit()
