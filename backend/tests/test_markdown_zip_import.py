"""Zips of Markdown notes → pages: Notion's Markdown & CSV export, Gamma's own
Markdown export round-tripped, and the list-continuation parser rule both rely
on."""

import io
import zipfile

from gamma.markdown_import import md_to_blocks

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
NOTION_HOME = "Home 0123456789abcdef0123456789abcdef"
NOTION_SUB = "Sub page fedcba9876543210fedcba9876543210"
NOTION_DB = "Tasks 11112222333344445555666677778888"
NOTION_ROW = "Write tests aaaabbbbccccddddeeeeffff00001111"


def _zip(files: dict) -> io.BytesIO:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data if isinstance(data, bytes) else data.encode("utf-8"))
    buf.seek(0)
    return buf


def _import(client, buf, folder="", name="notes.zip"):
    r = client.post("/api/import/markdown-zip",
                    files={"file": (name, buf.getvalue(), "application/zip")},
                    data={"folder": folder})
    assert r.status_code == 200, r.text
    return r.json()


def _subtree(client, page_id):
    return client.get(f"/api/blocks/{page_id}/subtree").json()["block"]


def _shape(node):
    return {"content": node["content"], "children": [_shape(c) for c in node["children"]]}


def _notion_zip():
    home_md = f"""# Home

Welcome to the workspace.

<aside>
💡 Remember to export with subpages.

</aside>

[Sub page]({NOTION_HOME.replace(' ', '%20')}/{NOTION_SUB.replace(' ', '%20')}.md)

![diagram.png]({NOTION_HOME.replace(' ', '%20')}/diagram.png)

[Tasks]({NOTION_HOME.replace(' ', '%20')}/{NOTION_DB.replace(' ', '%20')}.csv)

- Toggle heading

    Hidden paragraph under the toggle.
"""
    sub_md = f"""# Sub page

Back to [Home](../{NOTION_HOME.replace(' ', '%20')}.md).
"""
    row_md = """# Write tests

Status: Done

Cover the zip importer.
"""
    return _zip({
        f"{NOTION_HOME}.md": home_md,
        f"{NOTION_HOME}/{NOTION_SUB}.md": sub_md,
        f"{NOTION_HOME}/diagram.png": PNG,
        f"{NOTION_HOME}/{NOTION_DB}.csv": "Name,Status\nWrite tests,Done\n",
        f"{NOTION_HOME}/{NOTION_DB}_all.csv": "Name,Status\nWrite tests,Done\nShip it,Todo\n",
        f"{NOTION_HOME}/{NOTION_DB}/{NOTION_ROW}.md": row_md,
    })


def test_notion_export_becomes_pages_folders_mentions_and_uploads(guest):
    report = _import(guest, _notion_zip(), folder="Imports")
    assert report["notion"] is True
    assert report["pages_created"] == 4
    assert report["assets_stored"] == 1
    assert report["warnings"] == []
    by_title = {p["title"]: p for p in report["pages"]}
    assert set(by_title) == {"Home", "Sub page", "Tasks", "Write tests"}
    assert by_title["Home"]["folder"] == "Imports"
    assert by_title["Sub page"]["folder"] == "Imports/Home"
    assert by_title["Tasks"]["folder"] == "Imports/Home"
    assert by_title["Write tests"]["folder"] == "Imports/Home/Tasks"

    home = _subtree(guest, by_title["Home"]["id"])
    assert home["properties"]["notion_id"] == "0123456789abcdef0123456789abcdef"
    assert home["properties"]["folder"] == "Imports"
    texts = [c["content"] for c in home["children"]]
    assert texts[0] == "Welcome to the workspace."
    # <aside> → callout, the H1 title line is not repeated as a block
    assert texts[1] == "> [!info] 💡 Remember to export with subpages."
    # subpage + database links → mentions of the new pages
    assert texts[2] == f"[[{by_title['Sub page']['id']}]]"
    assert texts[3].startswith("![diagram.png](/api/uploads/") and texts[3].endswith(".png)")
    assert texts[4] == f"[[{by_title['Tasks']['id']}]]"
    toggle = home["children"][5]
    assert toggle["content"] == "Toggle heading"
    assert [c["content"] for c in toggle["children"]] == ["Hidden paragraph under the toggle."]

    upload = texts[3][len("![diagram.png]("):-1]
    assert guest.get(upload).status_code == 200

    sub = _subtree(guest, by_title["Sub page"]["id"])
    assert sub["children"][0]["content"] == f"Back to [[{by_title['Home']['id']}]]."

    # the database: one page holding the _all table (every row), rows as pages
    tasks = _subtree(guest, by_title["Tasks"]["id"])
    table = tasks["children"][0]["content"]
    assert table.startswith("| Name | Status |")
    assert "| Ship it | Todo |" in table
    row = _subtree(guest, by_title["Write tests"]["id"])
    assert [c["content"] for c in row["children"]] == ["Status: Done", "Cover the zip importer."]

    # importing the same export again adds nothing, but links still resolve
    again = _import(guest, _notion_zip(), folder="Imports")
    assert again["pages_created"] == 0
    assert again["pages_skipped"] == 4


def test_notion_wrapper_folder_and_part_zips_are_unpacked(guest):
    inner = _zip({"Export-1b2c3d4e-0000-1111-2222-333344445555/Home 99999999999999999999999999999999.md": "# Home\n\nPart one.\n"})
    outer = _zip({"Part-1.zip": inner.getvalue()})
    report = _import(guest, outer)
    assert report["pages_created"] == 1
    assert report["pages"][0]["folder"] == ""
    assert report["pages"][0]["title"] == "Home"


def test_plain_zipped_folder_of_notes(guest):
    buf = _zip({
        "vault/daily/2026-09-01.md": "- woke up\n- [[wiki style]] stays as typed\n",
        "vault/projects/gamma.md": "---\ntitle: Gamma plans\n---\n# Gamma plans\n\nSee [daily](../daily/2026-09-01.md).\n",
    })
    report = _import(guest, buf)
    by_title = {p["title"]: p for p in report["pages"]}
    # the single common root ("vault") is dropped, the rest become folders
    assert by_title["2026-09-01"]["folder"] == "daily"
    assert by_title["Gamma plans"]["folder"] == "projects"
    plans = _subtree(guest, by_title["Gamma plans"]["id"])
    assert plans["children"][0]["content"] == f"See [[{by_title['2026-09-01']['id']}]]."


def test_rejects_zip_without_markdown(guest):
    r = guest.post("/api/import/markdown-zip",
                   files={"file": ("x.zip", _zip({"a.txt": "hi"}).getvalue(), "application/zip")})
    assert r.status_code == 400
    r = guest.post("/api/import/markdown-zip",
                   files={"file": ("x.zip", b"not a zip", "application/zip")})
    assert r.status_code == 400


def _put_children(client, page_id, children):
    r = client.put(f"/api/blocks/{page_id}/children", json={"blocks": children})
    assert r.status_code == 200, r.text


def test_gamma_markdown_export_round_trips(guest):
    """Export a folder as Markdown, import the zip elsewhere: same titles,
    folder tree, block nesting, multi-line blocks, images and links."""
    r = guest.post("/api/blocks", json={"parent_id": "root", "content": "Round trip A"})
    a = r.json()
    r = guest.post("/api/blocks", json={"parent_id": "root", "content": "Round trip B"})
    b = r.json()
    guest.put(f"/api/blocks/{a['id']}", json={"properties": {"folder": "rt2026"}})
    guest.put(f"/api/blocks/{b['id']}", json={"properties": {"folder": "rt2026/deep"}})
    img = guest.post("/api/upload-image", files={"file": ("d.png", PNG, "image/png")}).json()["url"]
    _put_children(guest, a["id"], [
        {"id": "rt-h", "content": "# Heading", "properties": {}, "children": [
            {"id": "rt-p", "content": "first line\nsecond line", "properties": {}, "children": []},
            {"id": "rt-c", "content": "```python\nx = 1\n\ny = 2\n```", "properties": {}, "children": []},
            {"id": "rt-i", "content": f"![pic]({img})", "properties": {}, "children": []},
        ]},
        {"id": "rt-l", "content": f"see [[{b['id']}]] for more", "properties": {}, "children": [
            {"id": "rt-m", "content": "$$\na = b\n$$", "properties": {}, "children": []},
        ]},
    ])
    _put_children(guest, b["id"], [
        {"id": "rt-b1", "content": "b note", "properties": {}, "children": []},
    ])

    r = guest.get("/api/folders/export?name=rt2026&mode=readable&highlights=1&notes=1&pdf=1")
    assert r.status_code == 200, r.text
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    md_a = next(n for n in names if n.startswith("Round trip A"))
    text_a = zf.read(md_a).decode()
    assert "folder:" not in text_a                      # at the export's root
    md_b = next(n for n in names if n.startswith("Round trip B"))
    assert "folder: deep" in zf.read(md_b).decode()     # relative to the export

    report = _import(guest, io.BytesIO(r.content), folder="restored")
    assert report["pages_created"] == 2
    assert report["warnings"] == []
    by_title = {p["title"]: p for p in report["pages"]}
    assert by_title["Round trip A"]["folder"] == "restored"
    assert by_title["Round trip B"]["folder"] == "restored/deep"

    new_a = _subtree(guest, by_title["Round trip A"]["id"])
    assert _shape(new_a)["children"] == [
        {"content": "# Heading", "children": [
            {"content": "first line\nsecond line", "children": []},
            {"content": "```python\nx = 1\n\ny = 2\n```", "children": []},
            {"content": f"![pic]({img})", "children": []},   # same hash → same upload
        ]},
        {"content": f"see [[{by_title['Round trip B']['id']}]] for more", "children": [
            {"content": "$$\na = b\n$$", "children": []},
        ]},
    ]
    assert new_a["properties"]["folder"] == "restored"
    assert "doc_id" not in new_a["properties"]

    # a second import of the same zip is a no-op
    again = _import(guest, io.BytesIO(r.content), folder="restored")
    assert again["pages_created"] == 0 and again["pages_skipped"] == 2


def test_gamma_single_md_upload_honours_front_matter_folder(guest):
    src = b"---\ntitle: Filed note\nfolder: papers/misc\n---\n# Filed note\n\n- one\n"
    r = guest.post("/api/import/markdown", files={"file": ("filed.md", src, "text/markdown")},
                   data={"folder": "inbox"})
    assert r.status_code == 200, r.text
    assert r.json()["folder"] == "inbox/papers/misc"


def test_md_to_blocks_list_continuation_rules():
    text = """- item one
  continues item one
  - nested
- code item
  ```js
  a();

  b();
  ```
- toggle

    child paragraph after a blank line
- para item

  second paragraph of the item
"""
    tree = md_to_blocks(text)
    assert [n["content"] for n in tree] == [
        "item one\ncontinues item one",
        "code item\n```js\na();\n\nb();\n```",
        "toggle",
        "para item\n\nsecond paragraph of the item",
    ]
    assert [c["content"] for c in tree[0]["children"]] == ["nested"]
    assert [c["content"] for c in tree[2]["children"]] == ["child paragraph after a blank line"]
