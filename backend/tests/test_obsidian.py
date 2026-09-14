"""Obsidian: a zipped vault → pages (wikilinks, embeds, anchors, properties),
and pages → a vault (the ``obsidian`` export mode), including the round trip."""

import io
import zipfile

from conftest import make_page

from gamma.markdown_import import md_to_blocks, parse_frontmatter
from gamma.obsidian_export import vault_name

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"


def _blank_pdf_bytes():
    from PyPDF2 import PdfWriter
    w = PdfWriter()
    w.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def _zip(files: dict) -> io.BytesIO:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data if isinstance(data, bytes) else data.encode("utf-8"))
    buf.seek(0)
    return buf


def _import(client, buf, folder=""):
    r = client.post("/api/import/markdown-zip",
                    files={"file": ("vault.zip", buf.getvalue(), "application/zip")},
                    data={"folder": folder})
    assert r.status_code == 200, r.text
    return r.json()


def _subtree(client, page_id):
    return client.get(f"/api/blocks/{page_id}/subtree").json()["block"]


def _flat(node, out=None):
    out = [] if out is None else out
    for c in node["children"]:
        out.append(c)
        _flat(c, out)
    return out


def _put_children(client, page_id, children):
    r = client.put(f"/api/blocks/{page_id}/children", json={"blocks": children})
    assert r.status_code == 200, r.text


# --- import ------------------------------------------------------------------

def _vault():
    home = """---
tags:
  - project/alpha
  - reading
aliases: [Start, "Home page"]
---
# Home

Intro paragraph with a comment %%hidden%% inside.

%%
A whole block comment
%%

See [[Deep Note]] and [[deep note|the alias]] and [[Notes/Deep Note#Method]].
Block link: [[Deep Note#^key-result]] and embed ![[Deep Note#^key-result]].
Whole-note embed ![[Deep Note]] and section ![[Deep Note#Method]].
Same note: [[#Setup]].
Picture ![[diagram.png|300]] and sized ![[diagram.png|200x100]] and titled ![[diagram.png|A diagram]].
Paper [[paper.pdf#page=3]] and file [[notes.txt]].
Markdown link [Deep](Notes/Deep%20Note.md) and shortest [Deep](Deep%20Note.md#Method).
Missing [[Nowhere]] stays.

> [!faq]- Folded question
> the answer

## Setup

A paragraph. ^para-anchor

```python
x = "[[not a link]] %%not a comment%%"
```
"""
    deep = """# Different heading

The key result. ^key-result

## Method

Steps here.

- first bullet ^bullet-id
- second
  - nested

^after-list
"""
    return _zip({
        "MyVault/.obsidian/app.json": "{}",
        "MyVault/.obsidian/plugins/x/README.md": "# not a note",
        "MyVault/.trash/Old.md": "gone",
        "MyVault/Home.md": home,
        "MyVault/Notes/Deep Note.md": deep,
        "MyVault/attachments/diagram.png": PNG,
        "MyVault/attachments/paper.pdf": PDF,
        "MyVault/attachments/notes.txt": "hello",
        "MyVault/Board.canvas": "{}",
    })


def test_vault_import_pages_links_embeds_and_properties(guest):
    report = _import(guest, _vault(), folder="obs")
    assert report["obsidian"] is True
    assert report["pages_created"] == 2
    assert any("canvas" in w["reason"] for w in report["warnings"])
    titles = {p["title"]: p for p in report["pages"]}
    assert set(titles) == {"Home", "Deep Note"}          # filename is the title
    assert titles["Deep Note"]["folder"] == "obs/Notes"

    home = _subtree(guest, titles["Home"]["id"])
    deep = _subtree(guest, titles["Deep Note"]["id"])
    assert home["properties"]["category"] == "project/alpha, reading"
    assert home["properties"]["aliases"] == ["Start", "Home page"]

    deep_blocks = _flat(deep)
    by_content = {b["content"].split("\n")[0]: b for b in deep_blocks}
    # The H1 differs from the filename, so it stays in the body.
    assert "# Different heading" in by_content
    key = by_content["The key result."]                    # anchor stripped
    method = by_content["## Method"]
    first = by_content["first bullet"]
    second = by_content["second"]
    assert "^" not in key["content"] and "^" not in first["content"]
    assert not any(b["content"].startswith("^") for b in deep_blocks)

    home_blocks = _flat(home)
    text = "\n".join(b["content"] for b in home_blocks)
    did, hid = deep["id"], home["id"]
    assert "hidden" not in text and "whole block comment" not in text.lower()
    assert "Intro paragraph with a comment  inside." in text
    assert f"See [[{did}]] and [[{did}]] and [[{method['id']}]]." in text
    assert f"Block link: [[{key['id']}]] and embed ![[{key['id']}]]." in text
    assert f"Whole-note embed [[{did}]] and section [[{method['id']}]]." in text
    setup = next(b for b in home_blocks if b["content"] == "## Setup")
    assert f"Same note: [[{setup['id']}]]." in text
    assert "![|300](/api/uploads/" in text and "![|200x100](/api/uploads/" in text
    assert "![A diagram](/api/uploads/" in text
    assert "[paper.pdf](/api/uploads/" in text and ".pdf)" in text
    assert "[notes.txt](/api/uploads/" in text
    assert f"Markdown link [[{did}]] and shortest [[{method['id']}]]." in text
    assert "[[Nowhere]] stays" in text
    assert "> [!faq] Folded question" in text and "[!faq]-" not in text
    para = next(b for b in home_blocks if b["content"] == "A paragraph.")
    assert para["parent_id"] == setup["id"]
    fence = next(b for b in home_blocks if b["content"].startswith("```python"))
    assert "[[not a link]] %%not a comment%%" in fence["content"]
    # Lists nest under the nearest heading; the anchor line after the list
    # belongs to the block before it (and was dropped as a block).
    assert second["parent_id"] == method["id"] and first["parent_id"] == method["id"]
    assert report["assets_stored"] == 3
    assert "# Home" not in text                              # H1 repeats the title


def test_vault_import_is_idempotent(guest):
    """The same vault (same bytes) imported again adds nothing — the pages
    were already created by the test above, this import is the repeat."""
    again = _import(guest, _vault(), folder="obs2")
    assert again["pages_created"] == 0 and again["pages_skipped"] == 2


def test_frontmatter_lists_and_fold_markers():
    fm, body = parse_frontmatter("---\ntags:\n  - a\n  - b\nx: [1, 2]\ns: 'q'\n---\nrest")
    assert fm == {"tags": ["a", "b"], "x": ["1", "2"], "s": "q"} and body == "rest"
    assert md_to_blocks("> [!tip]+ T\n> b")[0]["content"] == "> [!tip] T\n> b"


# --- export ------------------------------------------------------------------

def _highlight(hid, quote, note="", page=1):
    return {
        "id": hid, "content": note, "children": [],
        "properties": {
            "highlight_id": hid, "quote": quote, "pdf_page": page,
            "color": "rgba(255, 226, 143, 0.65)",
            "pdf_position": {"pageNumber": page, "boundingRect": {}, "rects": []},
        },
    }


def test_vault_name_strips_obsidian_forbidden_characters():
    assert vault_name('A: "b" [c] #d ^e | f/g') == "A b c d e  f g".replace("  ", " ")
    assert vault_name(".hidden.") == "hidden"
    assert vault_name("") == "Untitled"


def test_obsidian_export_writes_a_vault(guest):
    img = guest.post("/api/upload-image", files={"file": ("d.png", PNG, "image/png")}).json()["url"]
    target = make_page(guest, "Target: note", properties={"folder": "ov/sub", "category": "read, later"})
    _put_children(guest, target["id"], [
        {"id": "ot-h", "content": "## Findings", "properties": {}, "children": [
            {"id": "ot-p", "content": "a shared finding\nsecond line", "properties": {}, "children": [
                {"id": "ot-c", "content": "child bullet", "properties": {}, "children": []},
            ]},
        ]},
        {"id": "ot-f", "content": "```py\nx = 1\n```", "properties": {}, "children": []},
    ])
    src = make_page(guest, "Source", properties={"folder": "ov", "aliases": ["S"]})
    _put_children(guest, src["id"], [
        {"id": "os-1", "content": f"see [[ot-p]] and page [[{target['id']}]] and code [[ot-f]]",
         "properties": {}, "children": []},
        {"id": "os-2", "content": "synced: ![[ot-p]]", "properties": {}, "children": []},
        {"id": "os-3", "content": f"pic ![cap|300]({img})", "properties": {}, "children": []},
        {"id": "os-4", "content": "> [!note] kept\n> body", "properties": {}, "children": []},
    ])

    r = guest.get("/api/folders/export", params={"name": "ov", "mode": "obsidian"})
    assert r.status_code == 200, r.text
    assert "ov-obsidian.zip" in r.headers["content-disposition"]
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert "Source.md" in names and "sub/Target note.md" in names
    assert f"attachments/{img.rsplit('/', 1)[1]}" in names
    assert ".obsidian/app.json" in names

    t = z.read("sub/Target note.md").decode()
    assert t.startswith("---\ntitle: \"Target: note\"\ntags:\n  - read\n  - later\n---\n")
    assert "# Target" not in t                              # no H1: the filename is the title
    # A block with children is a list item (the anchor on its bullet line),
    # a leaf block a paragraph, a fence's anchor sits on its own line.
    assert "## Findings\n\n- a shared finding ^ot-p\n  second line\n  - child bullet\n" in t
    assert "```py\nx = 1\n```\n\n^ot-f\n" in t

    s = z.read("Source.md").decode()
    assert "aliases:\n  - S\n" in s
    assert "see [[Target note#^ot-p]] and page [[Target note]] and code [[Target note#^ot-f]]" in s
    assert "synced: ![[Target note#^ot-p]]" in s
    assert f"pic ![cap|300](attachments/{img.rsplit('/', 1)[1]})" in s
    assert "> [!note] kept\n> body" in s


def test_obsidian_export_bundles_pdf_and_links_highlight_pages(guest):
    up = guest.post("/api/uploads", files={"file": ("paper.pdf", _blank_pdf_bytes(), "application/pdf")})
    assert up.status_code == 200, up.text
    props = {"doc_id": up.json()["doc_id"], "source_url": up.json()["source_url"], "folder": "ovp"}
    page_id = make_page(guest, "Paper", properties=props)["id"]
    _put_children(guest, page_id, [
        _highlight("oh-1", "quoted text\nsecond", note="my note", page=3) | {"children": [
            {"id": "oh-1c", "content": "under the note", "properties": {}, "children": []}]},
        {"id": "op-1", "content": "top paragraph", "properties": {}, "children": [
            {"id": "op-1a", "content": _highlight("oh-2", "nested quote", page=5)["content"],
             "properties": _highlight("oh-2", "nested quote", page=5)["properties"], "children": []},
        ]},
    ])
    r = guest.get(f"/api/pages/{page_id}/export", params={"mode": "obsidian"})
    assert r.status_code == 200, r.text
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert "attachments/Paper.pdf" in z.namelist()
    # A single page keeps its whole folder label as the directory.
    md = z.read("ovp/Paper.md").decode()
    assert 'source: "[[Paper.pdf]]"' in md
    assert "> [!quote] [[Paper.pdf#page=3|p. 3]]\n> quoted text\n> second\n\nmy note\n\n- under the note\n" in md
    assert "- top paragraph\n  - > nested quote\n    [[Paper.pdf#page=5|p. 5]]\n" in md

    # Without the bundle: page markers only, and the source stays a URL.
    r = guest.get(f"/api/pages/{page_id}/export", params={"mode": "obsidian", "pdf": 0})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    md = z.read("ovp/Paper.md").decode()
    assert "attachments/Paper.pdf" not in z.namelist()
    assert "> [!quote] p. 3\n> quoted text" in md and "[[Paper.pdf" not in md
    assert f"source: {props['source_url']}" in md

    # Dropping highlights keeps the note as a plain block (with its child).
    r = guest.get(f"/api/pages/{page_id}/export", params={"mode": "obsidian", "highlights": 0})
    md = zipfile.ZipFile(io.BytesIO(r.content)).read("ovp/Paper.md").decode()
    assert "[!quote]" not in md and "\n- my note\n  - under the note\n" in md


def test_obsidian_export_disambiguates_same_titles(guest):
    a = make_page(guest, "Twin", properties={"folder": "ovt/one"})
    b = make_page(guest, "Twin", properties={"folder": "ovt/two"})
    c = make_page(guest, "Twin", properties={"folder": "ovt/two"})
    src = make_page(guest, "Links", properties={"folder": "ovt"})
    _put_children(guest, src["id"], [
        {"id": "ol-1", "content": f"[[{a['id']}]] [[{b['id']}]] [[{c['id']}]]",
         "properties": {}, "children": []},
    ])
    r = guest.get("/api/folders/export", params={"name": "ovt", "mode": "obsidian"})
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert {"one/Twin.md", "two/Twin.md", "two/Twin 2.md", "Links.md"} <= set(z.namelist())
    assert "[[one/Twin]] [[two/Twin]] [[Twin 2]]" in z.read("Links.md").decode()


def test_obsidian_round_trip(guest):
    """Export a folder as a vault, import the zip into another folder: the
    same titles, tree, synced block and labels come back."""
    img = guest.post("/api/upload-image", files={"file": ("d.png", PNG, "image/png")}).json()["url"]
    a = make_page(guest, "Round A", properties={"folder": "ovr", "category": "t1"})
    b = make_page(guest, "Round B", properties={"folder": "ovr/deep"})
    _put_children(guest, a["id"], [
        {"id": "ra-h", "content": "# Heading", "properties": {}, "children": [
            {"id": "ra-p", "content": "first line\nsecond line", "properties": {}, "children": []},
            {"id": "ra-c", "content": "```python\nx = 1\n\ny = 2\n```", "properties": {}, "children": []},
            {"id": "ra-i", "content": f"![pic|200]({img})", "properties": {}, "children": []},
        ]},
        {"id": "ra-l", "content": f"see [[{b['id']}]] and ![[rb-1]]", "properties": {}, "children": [
            {"id": "ra-m", "content": "$$\na = b\n$$", "properties": {}, "children": []},
        ]},
    ])
    _put_children(guest, b["id"], [
        {"id": "rb-1", "content": "b note", "properties": {}, "children": []},
    ])
    r = guest.get("/api/folders/export", params={"name": "ovr", "mode": "obsidian"})
    assert r.status_code == 200, r.text
    report = _import(guest, io.BytesIO(r.content), folder="restored")
    assert report["pages_created"] == 2 and report["warnings"] == []
    by_title = {p["title"]: p for p in report["pages"]}
    assert by_title["Round B"]["folder"] == "restored/deep"
    new_a = _subtree(guest, by_title["Round A"]["id"])
    new_b = _subtree(guest, by_title["Round B"]["id"])
    assert new_a["properties"]["category"] == "t1"
    b_note = new_b["children"][0]
    # Document style is lossy in one way: what follows a heading belongs to
    # it on re-import. Everything else — nesting, multi-line blocks, the
    # mention, the synced block, the sized image — comes back as it was.
    heading = new_a["children"][0]
    assert [c["content"] for c in new_a["children"]] == ["# Heading"]
    assert [(c["content"], [g["content"] for g in c["children"]]) for c in heading["children"]] == [
        ("first line\nsecond line", []),
        ("```python\nx = 1\n\ny = 2\n```", []),
        (f"![pic|200]({img})", []),
        (f"see [[{new_b['id']}]] and ![[{b_note['id']}]]", ["$$\na = b\n$$"]),
    ]
