"""Plain .md uploads become note pages, including inside folder uploads."""

import json
from conftest import workspace_of
import sqlite3

from gamma.db import ws_db_path


def test_markdown_upload_creates_nested_note_page(guest):
    source = b"""---
title: Reading notes
---
# Overview

Opening paragraph.

- first
  - nested

## Details

More text.
"""
    r = guest.post(
        "/api/import/markdown",
        files={"file": ("paper-notes.md", source, "text/markdown")},
        data={"folder": "papers/week 1"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Reading notes"
    assert body["original_filename"] == "paper-notes.md"
    assert body["folder"] == "papers/week 1"

    page = guest.get(f"/api/blocks/{body['block_id']}/subtree").json()["block"]
    assert page["content"] == "Reading notes"
    assert page["properties"]["folder"] == "papers/week 1"
    assert page["properties"]["original_filename"] == "paper-notes.md"
    overview = page["children"][0]
    assert overview["content"] == "# Overview"
    assert [child["content"] for child in overview["children"]] == [
        "Opening paragraph.", "first", "## Details",
    ]
    assert overview["children"][1]["children"][0]["content"] == "nested"
    assert overview["children"][2]["children"][0]["content"] == "More text."


def test_markdown_upload_uses_filename_without_extension(guest):
    r = guest.post(
        "/api/import/markdown",
        files={"file": ("standalone.markdown", b"One paragraph", "text/plain")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "standalone"
    page = guest.get(f"/api/blocks/{body['block_id']}/subtree").json()["block"]
    assert [child["content"] for child in page["children"]] == ["One paragraph"]


def test_markdown_upload_strips_directory_from_multipart_filename(guest):
    r = guest.post(
        "/api/import/markdown",
        files={"file": (
            "spectrum_analyzer_data/CODE_INDEX.md",
            b"Index body",
            "text/markdown",
        )},
        data={"folder": "spectrum_analyzer_data"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "CODE_INDEX"
    assert body["original_filename"] == "CODE_INDEX.md"
    page = guest.get(f"/api/blocks/{body['block_id']}").json()
    assert page["content"] == "CODE_INDEX"
    assert page["properties"]["folder"] == "spectrum_analyzer_data"


def test_library_load_repairs_old_automatic_path_title(guest):
    created = guest.post(
        "/api/import/markdown",
        files={"file": ("CODE_INDEX.md", b"Index body", "text/markdown")},
    ).json()
    with sqlite3.connect(ws_db_path(workspace_of("guest"), "pages.db")) as conn:
        row = conn.execute(
            "SELECT properties FROM unified_blocks WHERE id=?", (created["block_id"],)
        ).fetchone()
        props = json.loads(row[0])
        props["original_filename"] = "spectrum_analyzer_data/CODE_INDEX.md"
        conn.execute(
            "UPDATE unified_blocks SET content=?, properties=? WHERE id=?",
            ("spectrum_analyzer_data/CODE_INDEX", json.dumps(props), created["block_id"]),
        )
        conn.commit()

    children = guest.get("/api/blocks/root/children").json()["children"]
    repaired = next(page for page in children if page["id"] == created["block_id"])
    assert repaired["content"] == "CODE_INDEX"
    assert repaired["properties"]["original_filename"] == "CODE_INDEX.md"


def test_markdown_upload_rejects_non_utf8(guest):
    r = guest.post(
        "/api/import/markdown",
        files={"file": ("bad.md", b"\xff\xfe\xfa", "text/markdown")},
    )
    assert r.status_code == 400
    assert "UTF-8" in r.json()["detail"]


def test_markdown_blocks_endpoint_parses_without_storing(guest):
    """POST /api/markdown-blocks: the paste-as-blocks helper returns the parsed
    tree and writes nothing."""
    r = guest.post("/api/markdown-blocks", json={
        "text": "# Head\n\n- pasted-first\n  - pasted-nested\n- pasted-second"})
    assert r.status_code == 200, r.text
    tree = r.json()["blocks"]
    assert tree[0]["content"] == "# Head"
    items = tree[0]["children"]
    assert [b["content"] for b in items] == ["pasted-first", "pasted-second"]
    assert items[0]["children"][0]["content"] == "pasted-nested"

    with sqlite3.connect(ws_db_path(workspace_of("guest"), "pages.db")) as conn:
        n = conn.execute("SELECT COUNT(*) FROM unified_blocks "
                         "WHERE content LIKE 'pasted-%'").fetchone()[0]
    assert n == 0


def test_markdown_blocks_endpoint_caps_size(guest):
    r = guest.post("/api/markdown-blocks", json={"text": "x" * (5 * 1024 * 1024 + 10)})
    assert r.status_code == 413


def test_markdown_blocks_keeps_display_math_whole(guest):
    r"""Multi-line $$ math stays one block even when its rows look like list
    items or numbered lines (a shattered \begin{array} never renders)."""
    math = r"""$$
\begin{aligned}
- x + y &= 3 \\
1. & \text{numbered-looking row} \\
\end{aligned}
$$"""
    text = "Result:\n" + math + "\nDone."
    r = guest.post("/api/markdown-blocks", json={"text": text})
    assert r.status_code == 200, r.text
    tree = r.json()["blocks"]
    assert [b["content"] for b in tree] == ["Result:", math, "Done."]