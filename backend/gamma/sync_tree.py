"""A page's tree as a flat snapshot, and the ops that turn one snapshot into
another — the pure half of the mirror (gamma/sync_engine.py applies them).

A snapshot is ``{block_id: {parent, position, content, props}}`` over the
page root and everything under it. ``diff(base, target, page_id)`` is the
Python twin of the frontend's ``diffTrees`` (src/shared/model/blockOps.js):
inserts for ids only ``target`` has, moves for a changed parent or key,
sets for changed content (carrying ``base``, the text it was edited from —
the server's three-way merge reads it) or a properties patch, and deletes
of the top-most removed subtrees last. Inserts and moves come in tree
order, so a parent always exists before its children arrive.
"""

import json
import re

from .ops import props_patch

UPLOAD_REF_RE = re.compile(r"/api/uploads/([0-9a-f]{8,64}\.[a-z0-9]{1,8})")
HEX_RE = re.compile(r"^[0-9a-f]{8,64}$")


def snapshot_from_rows(rows) -> dict:
    """From ``blocks_store.fetch_subtree`` rows (``BLOCK_COLUMNS`` order)."""
    out = {}
    for r in rows:
        try:
            props = json.loads(r[4] or "{}")
        except (TypeError, ValueError):
            props = {}
        out[r[0]] = {"parent": r[1], "position": r[2], "content": r[3] or "", "props": props}
    return out


def snapshot_from_tree(node: dict) -> dict:
    """From the nested ``GET /blocks/{id}/subtree`` node."""
    out = {}
    pending = [node]
    while pending:
        n = pending.pop()
        out[n["id"]] = {"parent": n.get("parent_id"), "position": n.get("position") or "",
                        "content": n.get("content") or "", "props": dict(n.get("properties") or {})}
        pending.extend(n.get("children") or [])
    return out


def children_of(snapshot: dict) -> dict:
    """``{parent: [ids sorted by position]}``."""
    kids = {}
    for bid, b in snapshot.items():
        kids.setdefault(b["parent"], []).append(bid)
    for ids in kids.values():
        ids.sort(key=lambda i: (snapshot[i]["position"], i))
    return kids


def tree_order(snapshot: dict, page_id: str) -> list[str]:
    """Every id under the page, parents before children, siblings by key."""
    kids = children_of(snapshot)
    out, queue = [], list(kids.get(page_id, []))
    while queue:
        bid = queue.pop(0)
        out.append(bid)
        queue.extend(kids.get(bid, []))
    return out


def subtree_ids(snapshot: dict, block_id: str) -> set[str]:
    kids = children_of(snapshot)
    out, queue = set(), [block_id]
    while queue:
        bid = queue.pop()
        if bid in out:
            continue
        out.add(bid)
        queue.extend(kids.get(bid, []))
    return out


def ancestors(snapshot: dict, block_id: str) -> list[str]:
    """The chain of parents above a block, nearest first (the page root last)."""
    out, cur, seen = [], snapshot.get(block_id), set()
    while cur and cur["parent"] and cur["parent"] in snapshot and cur["parent"] not in seen:
        seen.add(cur["parent"])
        out.append(cur["parent"])
        cur = snapshot[cur["parent"]]
    return out


def _set_op(bid: str, b: dict | None, t: dict, with_base: bool) -> dict | None:
    op = {"op": "set", "id": bid}
    if b is None or t["content"] != b["content"]:
        op["content"] = t["content"]
        if with_base and b is not None:
            op["base"] = b["content"]
    patch = props_patch(b["props"] if b else {}, t["props"])
    if "content" in op and "auto_title" in t["props"] and "auto_title" not in patch:
        # a content write drops the automatic-title marker unless the patch
        # names it (ops.py) — keep the target's marker
        patch["auto_title"] = t["props"]["auto_title"]
    if patch:
        op["props"] = patch
    return op if len(op) > 2 else None


def diff(base: dict, target: dict, page_id: str, *, with_base: bool = True) -> list[dict]:
    """The ops turning ``base`` into ``target`` (see the module doc). The
    page root is only ever ``set``, and only when both snapshots have it."""
    ops = []
    b_root, t_root = base.get(page_id), target.get(page_id)
    if b_root is not None and t_root is not None:
        op = _set_op(page_id, b_root, t_root, with_base)
        if op:
            ops.append(op)
    for bid in tree_order(target, page_id):
        t, b = target[bid], base.get(bid)
        if b is None:
            ops.append({"op": "insert", "id": bid, "parent": t["parent"], "position": t["position"],
                        "content": t["content"], "props": dict(t["props"])})
            continue
        if t["parent"] != b["parent"] or t["position"] != b["position"]:
            ops.append({"op": "move", "id": bid, "parent": t["parent"], "position": t["position"]})
        op = _set_op(bid, b, t, with_base)
        if op:
            ops.append(op)
    gone = [bid for bid in base if bid not in target and bid != page_id]
    for bid in gone:
        parent = base[bid]["parent"]
        if parent in target or parent == page_id or parent not in base:
            ops.append({"op": "delete", "id": bid})
    return ops


def upload_refs(blocks) -> set[str]:
    """The upload file names a set of blocks (snapshot values or op dicts)
    reference: ``/api/uploads/<hash>.<ext>`` in content or properties, and
    a page's ``doc_id`` (its PDF, ``<hash>.pdf``)."""
    names = set()
    for b in blocks:
        content = b.get("content") or ""
        props = b.get("props") or {}
        names.update(UPLOAD_REF_RE.findall(content))
        names.update(UPLOAD_REF_RE.findall(json.dumps(props)))
        doc = props.get("doc_id")
        if isinstance(doc, str) and HEX_RE.match(doc):
            names.add(f"{doc}.pdf")
    return names
