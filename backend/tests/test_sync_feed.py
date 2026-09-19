"""The workspace change feed (routers/sync.py): pages changed and pages
deleted since a cursor, paginated, workspace-scoped, and a hint a mirror can
consume idempotently."""

from fractional_indexing import generate_key_between

from conftest import login, make_page, make_user, workspace_of
from gamma.db import connect_pages_db
from gamma.routers import sync as sync_mod


def _feed(client, since="", limit=500):
    r = client.get(f"/api/sync/changes?since={since}&limit={limit}")
    assert r.status_code == 200, r.text
    return r.json()


def _ids(feed, key="pages"):
    return [p["id"] for p in feed[key]]


def _stamp(user, page_id, at):
    """Backdate a page (the feed reads updated_at) — a test's way to leave
    the grace window."""
    with connect_pages_db(workspace_of(user)) as conn:
        conn.execute("UPDATE unified_blocks SET updated_at = ? WHERE id = ?", (at, page_id))
        conn.commit()


def test_feed_lists_changed_and_deleted_pages_with_their_seq(guest):
    old = make_page(guest, "Old")
    _stamp("guest", old["id"], "2020-01-01T00:00:00.000000Z")
    cursor = "2021-01-01T00:00:00.000000Z"

    page = make_page(guest, "Fresh")
    before = _feed(guest, cursor)
    assert old["id"] not in _ids(before) and page["id"] in _ids(before)
    entry = next(p for p in before["pages"] if p["id"] == page["id"])
    assert entry["seq"] == 0 and entry["created_at"] == entry["updated_at"]

    r = guest.post(f"/api/pages/{page['id']}/ops", json={"client": "t", "ops": [
        {"op": "insert", "id": "sfA", "parent": page["id"],
         "position": generate_key_between(None, None), "content": "a"}]})
    assert r.status_code == 200, r.text
    after = _feed(guest, cursor)
    entry = next(p for p in after["pages"] if p["id"] == page["id"])
    assert entry["seq"] == r.json()["seq"] and entry["updated_at"] > entry["created_at"]

    guest.delete(f"/api/blocks/{page['id']}").raise_for_status()
    gone = _feed(guest, cursor)
    assert page["id"] not in _ids(gone)
    assert [(d["id"], d["actor"]) for d in gone["deleted"] if d["id"] == page["id"]] == [(page["id"], "guest")]
    assert gone["more"] is False and gone["since"] == cursor


def test_feed_paginates_with_a_strict_cursor_and_no_repeats(guest):
    base = "2019-06-01T00:00:00.00000"
    pages = [make_page(guest, f"P{i}") for i in range(5)]
    # three pages share one timestamp (what an import does), two follow
    for i, p in enumerate(pages):
        _stamp("guest", p["id"], f"{base}{0 if i < 3 else i}Z")
    since = "2019-01-01T00:00:00.000000Z"
    seen, cursor, rounds = [], since, 0
    while True:
        feed = _feed(guest, cursor, limit=2)
        seen += _ids(feed)
        rounds += 1
        if not feed["more"]:
            break
        assert "|" in feed["cursor"]  # time + id: strict, no repeats inside one walk
        cursor = feed["cursor"]
    ours = [i for i in seen if i in {p["id"] for p in pages}]
    assert ours == [p["id"] for p in sorted(pages[:3], key=lambda p: p["id"])] + [pages[3]["id"], pages[4]["id"]]
    assert len(ours) == len(set(ours)) and rounds >= 3


def test_caught_up_cursor_keeps_a_grace_window(guest, monkeypatch):
    page = make_page(guest, "Graced")
    feed = _feed(guest, "2000-01-01T00:00:00.000000Z", limit=2000)
    assert feed["more"] is False and "|" not in feed["cursor"]
    # the cursor sits GRACE_SECONDS in the past: a page written just now is listed again
    again = _feed(guest, feed["cursor"], limit=2000)
    assert page["id"] in _ids(again)
    # but never behind a cursor the caller already had
    future = "2999-01-01T00:00:00.000000Z"
    assert _feed(guest, future)["cursor"] == future


def test_feed_is_workspace_scoped_and_needs_a_session(client, guest, anon):
    make_user("feed_other", "pw")
    other = login("feed_other", "pw")
    mine = make_page(guest, "Mine")
    theirs = make_page(other, "Theirs")
    assert mine["id"] in _ids(_feed(guest)) and theirs["id"] not in _ids(_feed(guest))
    assert theirs["id"] in _ids(_feed(other)) and mine["id"] not in _ids(_feed(other))
    assert anon.get("/api/sync/changes").status_code == 401
    assert guest.get("/api/sync/changes?limit=0").status_code == 200


def test_wholesale_rewrites_reach_the_feed(guest):
    """A subtree replace on a nested block logs a reload — and stamps the
    page, so the feed lists it."""
    page = make_page(guest, "Rewritten")
    child = guest.post("/api/blocks", json={"parent_id": page["id"], "content": "c"}).json()
    _stamp("guest", page["id"], "2018-01-01T00:00:00.000000Z")
    cursor = "2018-06-01T00:00:00.000000Z"
    assert page["id"] not in _ids(_feed(guest, cursor))
    r = guest.put(f"/api/blocks/{child['id']}/children", json={"blocks": [{"content": "grandchild"}]})
    assert r.status_code == 200, r.text
    entry = next(p for p in _feed(guest, cursor)["pages"] if p["id"] == page["id"])
    assert entry["seq"] >= 2
