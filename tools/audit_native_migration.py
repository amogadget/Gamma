#!/usr/bin/env python3
"""Read-only native-data integrity inventory, before and after workspace migration.

snapshot DATA_DIR OUTPUT.json; compare BEFORE.json AFTER.json
Inventories contain hashes and internal identifiers, never note text or secrets.
Run only against stopped, disposable data copies for a consistent snapshot.
"""
import argparse
from collections import Counter
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3

ASSET_REF = re.compile(r"/api/assets/([0-9a-f]{64}\.(?:pkdrawing|png|m4a|inkjson))")


def digest_file(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def readonly_db(path):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro")


def snapshot(root):
    root = Path(root).resolve()
    if not (root / "users.db").is_file():
        raise ValueError("data directory must contain users.db")
    workspace_owners = {}
    with closing(readonly_db(root / "users.db")) as conn:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
        if "default_workspace" in columns:
            for username, ws in conn.execute("SELECT username, default_workspace FROM users"):
                if ws:
                    workspace_owners[ws] = "user:" + username
    libraries = []
    for base, prefix in ((root / "users", "user:"), (root / "workspaces", "workspace:")):
        if base.is_dir():
            for folder in sorted(base.iterdir()):
                if folder.is_dir() and (folder / "pages.db").is_file():
                    identity = workspace_owners.get(folder.name, prefix + folder.name) if prefix == "workspace:" else prefix + folder.name
                    libraries.append((identity, folder))
    if not libraries:
        raise ValueError("no user/workspace pages.db found")
    assets, blocks, missing = [], [], []
    identities = set()
    for identity, folder in libraries:
        if identity in identities:
            raise ValueError("ambiguous old and new library identity: " + identity)
        identities.add(identity)
        uploads = folder / "uploads"
        if uploads.exists():
            for asset in sorted(uploads.iterdir()):
                if asset.is_symlink():
                    raise ValueError("refusing upload symlink: " + str(asset))
                if asset.is_file():
                    assets.append({"library": identity, "name": asset.name, "bytes": asset.stat().st_size, "sha256": digest_file(asset)})
        with closing(readonly_db(folder / "pages.db")) as conn:
            for block_id, parent, position, content, raw in conn.execute("SELECT id,parent_id,position,content,properties FROM unified_blocks"):
                properties = json.loads(raw or "{}")
                refs = sorted(set(ASSET_REF.findall(json.dumps(properties)) + ASSET_REF.findall(content or "")))
                if properties.get("type") not in ("pdf_ink", "audio") and not properties.get("native_note") and not refs:
                    continue
                canonical = json.dumps([block_id, parent, position, content, properties], sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
                blocks.append({"library": identity, "id": block_id, "sha256": hashlib.sha256(canonical).hexdigest(), "assets": refs})
                for ref in refs:
                    if not (uploads / ref).is_file():
                        missing.append({"library": identity, "block": block_id, "asset": ref})
    return {"format": "gamma-native-migration-audit-v1", "libraries": sorted(identities), "assets": sorted(assets, key=lambda r: (r["library"], r["name"])), "blocks": sorted(blocks, key=lambda r: (r["library"], r["id"])), "missing_references": missing}


def compare(before, after):
    for value in (before, after):
        if value.get("format") != "gamma-native-migration-audit-v1":
            raise ValueError("unsupported inventory format")
    def records(value, field):
        return Counter(json.dumps(row, sort_keys=True) for row in value[field])
    lost_assets = list((records(before, "assets") - records(after, "assets")).elements())
    changed_blocks = list((records(before, "blocks") - records(after, "blocks")).elements())
    missing = after["missing_references"]
    return {"ok": not (lost_assets or changed_blocks or missing or before["missing_references"]),
            "lost_or_changed_assets": [json.loads(row) for row in lost_assets],
            "lost_or_changed_native_blocks": [json.loads(row) for row in changed_blocks],
            "missing_references_before": before["missing_references"], "missing_references_after": missing,
            "before_counts": {key: len(before[key]) for key in ("assets", "blocks")},
            "after_counts": {key: len(after[key]) for key in ("assets", "blocks")}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    snap = commands.add_parser("snapshot")
    snap.add_argument("data_dir", type=Path)
    snap.add_argument("output", type=Path)
    diff = commands.add_parser("compare")
    diff.add_argument("before", type=Path)
    diff.add_argument("after", type=Path)
    args = parser.parse_args()
    if args.command == "snapshot":
        # Refuse overwrite: prior evidence is intentionally immutable.
        result = snapshot(args.data_dir)
        with args.output.open("x", encoding="utf-8") as output:
            json.dump(result, output, indent=2, ensure_ascii=False)
            output.write("\n")
        print(json.dumps({"assets": len(result["assets"]), "native_blocks": len(result["blocks"]), "missing_references": len(result["missing_references"])}))
        return 1 if result["missing_references"] else 0
    result = compare(json.loads(args.before.read_text()), json.loads(args.after.read_text()))
    print(json.dumps(result, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
