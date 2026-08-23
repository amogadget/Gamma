"""Per-folder home-chat buckets: path-keyed chat routes ("home:<folder>",
slashes included) and the folder-rename migration endpoint that carries the
conversations through folder rename/move/delete."""


def _msgs(client, key):
    return client.get(f"/api/chats/{key}").json()["messages"]


def _put(client, key, text):
    r = client.put(f"/api/chats/{key}", json={"messages": [{"role": "user", "text": text}]})
    assert r.status_code == 200, r.text


def test_bucket_keys_may_contain_slashes(guest):
    _put(guest, "home:cs229/Exams", "hi")
    assert _msgs(guest, "home:cs229/Exams")[0]["text"] == "hi"
    assert guest.delete("/api/chats/home:cs229/Exams").status_code == 200
    assert _msgs(guest, "home:cs229/Exams") == []


def test_folder_rename_moves_buckets_by_prefix(guest):
    _put(guest, "home:a", "A")
    _put(guest, "home:a/sub", "S")
    _put(guest, "home:ab", "AB")  # shares the string prefix but not the path
    r = guest.post("/api/chats/folder-rename", json={"src": "a", "dst": "b"})
    assert r.status_code == 200 and r.json()["moved"] == 2
    assert _msgs(guest, "home:a") == []
    assert _msgs(guest, "home:b")[0]["text"] == "A"
    assert _msgs(guest, "home:b/sub")[0]["text"] == "S"
    assert _msgs(guest, "home:ab")[0]["text"] == "AB"  # untouched


def test_folder_rename_collision_keeps_real_destination(guest):
    _put(guest, "home:x", "src")
    _put(guest, "home:y", "dest")
    guest.post("/api/chats/folder-rename", json={"src": "x", "dst": "y"})
    assert _msgs(guest, "home:y")[0]["text"] == "dest"
    assert _msgs(guest, "home:x") == []


def test_folder_rename_overwrites_empty_destination_row(guest):
    # An empty destination row (ChatDock's save-effect echo) must not shadow
    # the real conversation being moved in.
    _put(guest, "home:p", "src")
    assert guest.put("/api/chats/home:q", json={"messages": []}).status_code == 200
    guest.post("/api/chats/folder-rename", json={"src": "p", "dst": "q"})
    assert _msgs(guest, "home:q")[0]["text"] == "src"


def test_folder_delete_drops_buckets(guest):
    _put(guest, "home:z/deep", "gone")
    r = guest.post("/api/chats/folder-rename", json={"src": "z", "dst": ""})
    assert r.json()["moved"] == 1
    assert _msgs(guest, "home:z/deep") == []


def test_folder_rename_never_touches_root_bucket(guest):
    _put(guest, "home", "root chat")
    assert guest.post("/api/chats/folder-rename", json={"src": "", "dst": "x"}).status_code == 400
    guest.post("/api/chats/folder-rename", json={"src": "home", "dst": ""})  # only "home:home" would match
    assert _msgs(guest, "home")[0]["text"] == "root chat"
