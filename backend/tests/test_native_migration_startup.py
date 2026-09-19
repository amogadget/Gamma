"""The migrated-copy startup path, rehearsed on a synthetic data directory.

`gamma.app._startup_maintenance` is what a migrated copy meets when the server
starts: it migrates/stamps the data directory, then per workspace prunes orphan
uploads and applies the per-file schema statements. This file runs that exact
function against the test's throwaway data dir and checks the invariants the
migration audit (`tools/audit_native_migration.py`, read-only) cares about:

- every native block keeps its canonical JSON (ids, positions, properties),
- every asset a block references still exists and still hashes the same,
- `compare()` reports no lost/changed native blocks and no missing references.

Native files are retained even when unreferenced and very old: neither a
migration nor startup may discard an offline client's staged source. Copies
with preserved mtimes must pass the same strict all-file audit as fresh ones.
The real data volume is never touched: everything is a pytest temp directory.
"""

import importlib.util
import os
import time
import uuid
from pathlib import Path

from conftest import login, make_page, make_user, workspace_of
from gamma.config import DATA_DIR
from gamma.db import ws_uploads_dir


def audit_module():
    """The parent's inventory tool, loaded from tools/ (not a package)."""
    path = Path(__file__).resolve().parents[2] / "tools" / "audit_native_migration.py"
    spec = importlib.util.spec_from_file_location("audit_native_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def library_snapshot(audit, username):
    """Each test owns one library; other files share this worker's DATA_DIR.

    An export rejection test may deliberately leave an invalid attachment in
    its own workspace. That must not change this migration fixture's verdict.
    The production audit CLI remains strict over the entire directory.
    """
    inventory = audit.snapshot(DATA_DIR)
    identity = "user:" + username
    assert identity in inventory["libraries"]
    return {
        **inventory,
        "libraries": [identity],
        **{key: [row for row in inventory[key] if row["library"] == identity]
           for key in ("assets", "blocks", "missing_references")},
    }


def png_bytes(width=2, height=2):
    import struct
    import zlib
    raw = b"".join(b"\x00" + bytes(4) * width for _ in range(height))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def build_library(username):
    """A workspace holding one native annotation (with a replay) plus a staged
    asset no block references yet. Returns (client, ws, ink_block_id, names)."""
    make_user(username, "migration-password")
    client = login(username, "migration-password")
    ws = workspace_of(username)
    page = make_page(client, "Migrated notebook", properties={"doc_id": "e" * 24})

    def upload(data, ext, ctype):
        r = client.post("/api/assets", files={"file": (f"a.{ext}", data, ctype)})
        assert r.status_code == 200, r.text
        return r.json()["filename"]

    drawing = upload(b"migrated drawing bytes", "pkdrawing", "application/octet-stream")
    preview = upload(png_bytes(), "png", "image/png")
    staged = upload(b"staged, never referenced", "pkdrawing", "application/octet-stream")
    ink_id = str(uuid.uuid4())
    r = client.put(f"/api/blocks/{ink_id}/ink", json={
        "parent_id": page["id"], "pdf_page": 1,
        "ink_asset": f"/api/assets/{drawing}", "preview_asset": f"/api/assets/{preview}",
        "bounds": {"x": 5, "y": 5, "width": 20, "height": 10},
        "crop_box": {"width": 612, "height": 792}, "expected_revision": 0})
    assert r.status_code == 200, r.text
    replay = upload("{\"format\": \"gamma-ink-replay-v1\", \"source_sha256\": \"%s\", "
                    "\"width\": 612, \"height\": 792, \"strokes\": []}"
                    % drawing.split(".")[0], "inkjson", "application/json")
    r = client.put(f"/api/blocks/{ink_id}/replay-preview", json={
        "ink_asset": f"/api/assets/{drawing}", "replay_asset": f"/api/assets/{replay}"})
    assert r.status_code == 200, r.text
    return client, ws, page, ink_id, {"drawing": drawing, "preview": preview,
                                      "replay": replay, "staged": staged}


def age_uploads(ws, seconds):
    """Push every stored file past a grace window — what a copy that preserved
    mtimes (cp -a, rsync -a, tar) looks like to the sweep."""
    uploads = ws_uploads_dir(ws)
    old = time.time() - seconds
    aged = 0
    for path in uploads.iterdir():
        if path.is_file():
            os.utime(path, (old, old))
            aged += 1
    return aged


def test_startup_keeps_referenced_native_assets_and_audits_clean():
    """Fresh mtimes (a plain copy): nothing is reclaimed and the audit passes."""
    from gamma.app import _startup_maintenance
    audit = audit_module()
    client, ws, page, ink_id, names = build_library("migrate-fresh")
    uploads = ws_uploads_dir(ws)
    assert all((uploads / names[key]).is_file() for key in names)

    before = library_snapshot(audit, "migrate-fresh")
    assert before["missing_references"] == []
    library = [lib for lib in before["libraries"] if lib.endswith("migrate-fresh")]
    assert len(library) == 1 and [b for b in before["blocks"] if b["id"] == ink_id]

    _startup_maintenance()  # exactly what the server runs on a migrated copy

    after = library_snapshot(audit, "migrate-fresh")
    result = audit.compare(before, after)
    assert result["ok"] is True, result
    assert result["lost_or_changed_assets"] == []
    assert result["lost_or_changed_native_blocks"] == []
    assert result["missing_references_after"] == []
    assert result["before_counts"] == result["after_counts"]
    assert all((uploads / names[key]).is_file() for key in names)

    # The annotation still works after startup: assets serve under both URL
    # forms and the revision CAS is intact.
    assert client.get(f"/api/assets/{names['drawing']}").status_code == 200
    assert client.get(f"/api/uploads/{names['drawing']}").status_code == 200
    assert client.get(f"/api/assets/{names['replay']}").status_code == 200
    saved = client.put(f"/api/blocks/{ink_id}/ink", json={
        "parent_id": page["id"], "pdf_page": 1,
        "ink_asset": f"/api/assets/{names['drawing']}",
        "preview_asset": f"/api/assets/{names['preview']}",
        "bounds": {"x": 6, "y": 5, "width": 20, "height": 10},
        "crop_box": {"width": 612, "height": 792}, "expected_revision": 1})
    assert saved.status_code == 200, saved.text
    assert saved.json()["properties"]["replay_asset"] == f"/api/assets/{names['replay']}"


def test_startup_preserves_all_native_assets_when_mtimes_are_old():
    """Preserved mtimes and unreferenced native sources must audit clean."""
    from gamma.app import _startup_maintenance
    audit = audit_module()
    client, ws, page, ink_id, names = build_library("migrate-aged")
    uploads = ws_uploads_dir(ws)
    assert age_uploads(ws, 365 * 24 * 60 * 60) >= 4

    before = library_snapshot(audit, "migrate-aged")
    _startup_maintenance()
    after = library_snapshot(audit, "migrate-aged")
    result = audit.compare(before, after)

    # The block's canonical hash and its three referenced assets survive
    # untouched ...
    assert result["lost_or_changed_native_blocks"] == []
    assert result["missing_references_after"] == []
    for key in ("drawing", "preview", "replay"):
        assert (uploads / names[key]).is_file(), key
    # ... including the unreferenced source: age is not proof of disposability.
    assert result["lost_or_changed_assets"] == []
    assert result["ok"] is True
    assert client.get(f"/api/assets/{names['staged']}").status_code == 200
    assert client.get(f"/api/assets/{names['drawing']}").status_code == 200
    # Re-uploading is still deduplicated after a prolonged offline gap.
    again = client.post("/api/assets", files={
        "file": ("a.pkdrawing", b"staged, never referenced", "application/octet-stream")})
    assert again.status_code == 200 and again.json()["already_existed"] is True
    assert (uploads / names["staged"]).is_file()
