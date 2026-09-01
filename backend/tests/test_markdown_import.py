"""POST /api/import/markdown: parsing, limits, and page creation.

The parser itself is pure (gamma/markdown_import.py); these tests cover the
endpoint contract — auth, bounds, filename handling, folder placement,
fractional positions, idempotency and cross-user isolation.
"""

import io
import json
import sqlite3

import bcrypt
import pytest
from fastapi.testclient import TestClient

from gamma.markdown_import import MAX_BLOCKS, md_to_blocks, split_frontmatter


def _upload(client, text, name="notes.md", folder=None):
    data = text.encode("utf-8") if isinstance(text, str) else text
    files = {"file": (name, io.BytesIO(data), "text/markdown")}
    return client.post("/api/import/markdown", files=files,
                       data={"folder": folder} if folder is not None else None)


def _children(user, block_id):
    from gamma.db import user_db_path

    with sqlite3.connect(user_db_path(user, "pages.db")) as conn:
        return conn.execute(
            "SELECT content, position FROM unified_blocks WHERE parent_id = ? ORDER BY position",
            (block_id,),
        ).fetchall()


# --- the pure parser ----------------------------------------------------------


def test_frontmatter_title_is_read_and_body_dropped():
    title, body = split_frontmatter("---\ntitle: Real Title\ntags: [a]\n---\n# Body\n")
    assert title == "Real Title"
    assert body.strip() == "# Body"
    # No front matter: text is returned untouched.
    assert split_frontmatter("# Just a heading\n") == (None, "# Just a heading\n")
    # Quoted values are unwrapped; an indented key is not a top-level title.
    assert split_frontmatter("---\ntitle: 'Quoted'\n---\nx")[0] == "Quoted"
    assert split_frontmatter("---\nmeta:\n  title: Nested\n---\nx")[0] is None


def test_headings_nest_by_level():
    tree = md_to_blocks("# One\n## Two\n### Three\n## Two Again\n")
    assert [n["content"] for n in tree] == ["# One"]
    lvl2 = tree[0]["children"]
    assert [n["content"] for n in lvl2] == ["## Two", "## Two Again"]
    assert [n["content"] for n in lvl2[0]["children"]] == ["### Three"]


def test_list_items_nest_by_indent_and_drop_bullets():
    tree = md_to_blocks("- first\n  - nested\n- second\n")
    assert [n["content"] for n in tree] == ["first", "second"]
    assert [n["content"] for n in tree[0]["children"]] == ["nested"]


def test_numbered_markers_are_kept():
    tree = md_to_blocks("1. one\n2. two\n")
    assert [n["content"] for n in tree] == ["1. one", "2. two"]


def test_paragraphs_group_and_code_fences_stay_whole():
    tree = md_to_blocks("line one\nline two\n\nsecond para\n\n```py\nx = 1\n\ny = 2\n```\n")
    contents = [n["content"] for n in tree]
    assert contents[0] == "line one\nline two"
    assert contents[1] == "second para"
    assert contents[2] == "```py\nx = 1\n\ny = 2\n```"


def test_block_cap_is_enforced_by_the_parser():
    tree = md_to_blocks("\n\n".join(f"para {i}" for i in range(MAX_BLOCKS + 500)))
    assert len(tree) == MAX_BLOCKS


# --- the endpoint -------------------------------------------------------------


def test_markdown_import_requires_auth():
    from gamma.app import app

    c = TestClient(app)
    assert _upload(c, "# hi").status_code == 401


def test_markdown_import_creates_a_nested_note_page(guest):
    r = _upload(guest, "# Chapter\n\nSome prose here.\n\n- a point\n  - a sub point\n",
                name="my-notes.md")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["title"] == "my-notes"          # filename stem, no front matter
    assert body["original_filename"] == "my-notes.md"
    assert body["imported"] == 4
    assert body["duplicate"] is False

    page = guest.get(f"/api/blocks/{body['block_id']}").json()
    assert page["content"] == "my-notes"
    assert page["properties"]["markdown_import"]
    kids = _children("guest", body["block_id"])
    assert [c for c, _ in kids] == ["# Chapter"]
    # Positions are fractional-index strings, never integers.
    assert all(isinstance(pos, str) and pos for _, pos in kids)


def test_frontmatter_title_beats_the_filename(guest):
    r = _upload(guest, "---\ntitle: From Front Matter\n---\n# Body\n", name="ignored.md")
    assert r.status_code == 200
    assert r.json()["title"] == "From Front Matter"


def test_filename_is_reduced_to_a_leaf(guest):
    """A directory picker may leak a path; traversal must never reach a title
    or the stored original_filename."""
    r = _upload(guest, "# x\n", name="../../etc/passwd/deep/notes.md")
    assert r.status_code == 200
    body = r.json()
    assert body["original_filename"] == "notes.md"
    assert body["title"] == "notes"
    r2 = _upload(guest, "# y\n", name="windows\\dir\\other.md")
    assert r2.json()["original_filename"] == "other.md"


def test_folder_is_cleaned(guest):
    r = _upload(guest, "# in a folder\n", name="filed.md", folder="  Papers // Readout , x  ")
    assert r.status_code == 200
    page = guest.get(f"/api/blocks/{r.json()['block_id']}").json()
    # Separators and commas are normalised by the shared folder-tag rules.
    assert page["properties"]["folder"] == r.json()["folder"]
    assert "," not in page["properties"]["folder"]
    assert "//" not in page["properties"]["folder"]


def test_reimporting_the_same_file_is_idempotent(guest):
    """Repeated import (a replayed folder upload) must converge on one page,
    not pile up duplicates."""
    text = "# Idempotent\n\nexactly the same bytes\n"
    first = _upload(guest, text, name="same.md")
    assert first.status_code == 200
    assert first.json()["duplicate"] is False

    second = _upload(guest, text, name="same.md")
    assert second.status_code == 200
    assert second.json()["duplicate"] is True
    assert second.json()["block_id"] == first.json()["block_id"]
    assert second.json()["imported"] == 0
    # No second subtree was created.
    assert len(_children("guest", first.json()["block_id"])) == 1

    # Different bytes are a different page.
    third = _upload(guest, text + "\nplus a line\n", name="same.md")
    assert third.json()["duplicate"] is False
    assert third.json()["block_id"] != first.json()["block_id"]


def test_oversized_markdown_is_rejected(guest):
    too_big = b"#" + b"a" * (5 * 1024 * 1024 + 10)
    r = _upload(guest, too_big, name="huge.md")
    assert r.status_code == 413


def test_non_utf8_markdown_is_rejected(guest):
    r = _upload(guest, b"\xff\xfe\x00bad bytes", name="latin.md")
    assert r.status_code == 400


def test_empty_markdown_still_creates_a_page(guest):
    r = _upload(guest, "", name="empty.md")
    assert r.status_code == 200
    assert r.json()["imported"] == 0
    assert r.json()["title"] == "empty"


def test_unicode_content_survives(guest):
    r = _upload(guest, "# 量子計算\n\nΨ = α|0⟩ + β|1⟩\n", name="unicode.md")
    assert r.status_code == 200
    kids = _children("guest", r.json()["block_id"])
    assert kids[0][0] == "# 量子計算"


def test_block_cap_bounds_a_hostile_file(guest):
    r = _upload(guest, "\n\n".join(f"p{i}" for i in range(MAX_BLOCKS + 200)), name="many.md")
    assert r.status_code == 200
    assert r.json()["imported"] == MAX_BLOCKS


@pytest.fixture(scope="module")
def frank(client):
    """A second account, for cross-user isolation."""
    from gamma.app import app
    from gamma.db import connect_users_db, page_now
    from gamma.seed import create_user_dbs

    with connect_users_db() as conn:
        if not conn.execute("SELECT 1 FROM users WHERE username = 'frank-md'").fetchone():
            conn.execute(
                "INSERT INTO users (username, password_hash, is_guest, created_at) VALUES (?, ?, 0, ?)",
                ("frank-md", bcrypt.hashpw(b"pw", bcrypt.gensalt()).decode(), page_now()),
            )
            conn.commit()
    create_user_dbs("frank-md")
    c = TestClient(app)
    assert c.post("/api/login", json={"username": "frank-md", "password": "pw"}).status_code == 200
    return c


def test_import_is_per_user(guest, frank):
    """The same bytes in two accounts are two independent pages, and neither
    can see the other's."""
    text = "# Shared bytes\n\nsame content, different owners\n"
    mine = _upload(guest, text, name="shared.md").json()
    theirs = _upload(frank, text, name="shared.md").json()
    assert theirs["duplicate"] is False
    assert theirs["block_id"] != mine["block_id"]
    # Neither block is readable from the other session.
    assert guest.get(f"/api/blocks/{theirs['block_id']}").status_code == 404
    assert frank.get(f"/api/blocks/{mine['block_id']}").status_code == 404


def test_no_file_is_written_to_disk(guest):
    """Markdown is parsed into pages.db; nothing is stored as a served upload."""
    from gamma.db import user_uploads_dir

    before = set(p.name for p in user_uploads_dir("guest").glob("*"))
    r = _upload(guest, "# no disk writes\n", name="nodisk.md")
    assert r.status_code == 200
    after = set(p.name for p in user_uploads_dir("guest").glob("*"))
    assert after == before


def test_properties_are_valid_json(guest):
    from gamma.db import user_db_path

    r = _upload(guest, "# json\n", name="json.md")
    with sqlite3.connect(user_db_path("guest", "pages.db")) as conn:
        row = conn.execute("SELECT properties FROM unified_blocks WHERE id = ?",
                           (r.json()["block_id"],)).fetchone()
    props = json.loads(row[0])
    assert props["original_filename"] == "json.md"
    assert isinstance(props["markdown_import"], str) and len(props["markdown_import"]) == 24
