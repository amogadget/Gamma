"""gamma/sync_tree.py: snapshots and the ops between them (the pure half of
the mirror)."""

from gamma.sync_tree import diff, snapshot_from_tree, subtree_ids, upload_refs

P = "page1"


def apply_to_snapshot(snapshot: dict, ops: list[dict]) -> dict:
    """What the server would hold after ``ops``, positions taken as sent."""
    out = {k: {**v, "props": dict(v["props"])} for k, v in snapshot.items()}
    for op in ops:
        kind, bid = op["op"], op["id"]
        if kind == "insert":
            out[bid] = {"parent": op["parent"], "position": op.get("position") or "",
                        "content": op.get("content") or "", "props": dict(op.get("props") or {})}
        elif kind == "move" and bid in out:
            out[bid]["parent"] = op["parent"]
            out[bid]["position"] = op.get("position") or out[bid]["position"]
        elif kind == "set" and bid in out:
            if op.get("content") is not None:
                out[bid]["content"] = op["content"]
            for k, v in (op.get("props") or {}).items():
                if v is None:
                    out[bid]["props"].pop(k, None)
                else:
                    out[bid]["props"][k] = v
        elif kind == "delete":
            for gone in subtree_ids(out, bid) if bid in out else ():
                out.pop(gone, None)
    return out


def _snap(*blocks, root_content="Title", root_props=None):
    """``(id, parent, position, content, props?)`` tuples plus the page root."""
    out = {P: {"parent": "root", "position": "a0", "content": root_content, "props": dict(root_props or {})}}
    for b in blocks:
        out[b[0]] = {"parent": b[1], "position": b[2], "content": b[3], "props": dict(b[4] if len(b) > 4 else {})}
    return out


def _kinds(ops):
    return [(op["op"], op["id"]) for op in ops]


def test_identical_snapshots_diff_to_nothing():
    a = _snap(("x", P, "a0", "one"), ("y", "x", "a0", "two"))
    assert diff(a, a, P) == []


def test_insert_move_set_delete_in_tree_order_with_deletes_last():
    base = _snap(("x", P, "a0", "one"), ("y", P, "a1", "two"), ("z", "y", "a0", "three"), ("w", P, "a2", "four"))
    target = _snap(("x", P, "a0", "one!"), ("y", P, "a1", "two", {"color": "red"}),
                   ("n", "y", "a0", "new"), ("z", "n", "a0", "three"))
    ops = diff(base, target, P)
    assert _kinds(ops) == [("set", "x"), ("set", "y"), ("insert", "n"), ("move", "z"), ("delete", "w")]
    assert ops[0] == {"op": "set", "id": "x", "content": "one!", "base": "one"}
    assert ops[1] == {"op": "set", "id": "y", "props": {"color": "red"}}
    assert ops[2]["parent"] == "y" and ops[3] == {"op": "move", "id": "z", "parent": "n", "position": "a0"}
    assert apply_to_snapshot(base, ops) == target


def test_only_the_top_of_a_removed_subtree_is_deleted_and_escapees_move_first():
    base = _snap(("a", P, "a0", ""), ("b", "a", "a0", ""), ("c", "b", "a0", "keep me"))
    target = _snap(("c", P, "a0", "keep me"))
    ops = diff(base, target, P)
    assert _kinds(ops) == [("move", "c"), ("delete", "a")]


def test_root_is_only_set_and_only_when_both_have_it():
    base = _snap(root_content="Old", root_props={"folder": "x", "auto_title": "Old"})
    target = _snap(root_content="New", root_props={"folder": "x", "auto_title": "Old"})
    ops = diff(base, target, P)
    # a content write on the root keeps the automatic-title marker in its patch
    assert ops == [{"op": "set", "id": P, "content": "New", "base": "Old", "props": {"auto_title": "Old"}}]
    assert diff({}, target, P) == []
    base2 = _snap(root_props={"meta": {"t": 1}})
    assert diff(base2, _snap(), P) == [{"op": "set", "id": P, "props": {"meta": None}}]


def test_with_base_false_omits_base_texts():
    base = _snap(("x", P, "a0", "one"))
    target = _snap(("x", P, "a0", "two"))
    assert diff(base, target, P, with_base=False) == [{"op": "set", "id": "x", "content": "two"}]


def test_snapshot_from_tree_and_upload_refs():
    tree = {"id": P, "parent_id": "root", "position": "a0", "content": "T",
            "properties": {"doc_id": "abcdef0123456789abcdef01"},
            "children": [{"id": "x", "parent_id": P, "position": "a0",
                          "content": "![i](/api/uploads/0123456789abcdef01234567.png) and [f](/api/uploads/ffffffffffffffffffffffff.zip)",
                          "properties": {"ink_url": "/api/uploads/aaaaaaaaaaaaaaaaaaaaaaaa.ink"}, "children": []}]}
    snap = snapshot_from_tree(tree)
    assert set(snap) == {P, "x"} and snap["x"]["parent"] == P
    assert upload_refs(snap.values()) == {
        "abcdef0123456789abcdef01.pdf", "0123456789abcdef01234567.png",
        "ffffffffffffffffffffffff.zip", "aaaaaaaaaaaaaaaaaaaaaaaa.ink"}
