"""Convert a plain Markdown document into Gamma's nested note blocks.

Used by ``POST /api/import/markdown`` (uploading a .md file, alone or inside a
folder upload, turns it into a note page). The parser is deliberately shallow:
block contents keep their raw markdown — the block editor renders headings,
math, callouts etc. live — so all that matters here is how the document splits
into blocks and how they nest:

- headings nest by level (## under #, …) and keep their ``#`` markup;
- list items nest by indentation under the nearest heading, bullet markers are
  dropped (every block already renders as a bullet), numbered markers stay;
- indented continuation lines become a child block of their list item;
- everything else groups into one block per paragraph (consecutive non-blank
  lines — which also keeps quote runs, tables and ``$$`` math together);
- fenced code blocks are kept whole, fences included.
"""

import re

# blocks per document — a runaway guard, far above any real notes file
MAX_BLOCKS = 5000

_FRONTMATTER_RE = re.compile(r"^---[ \t]*\n(.*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)", re.S)
_HEADING_RE = re.compile(r"^(#{1,6})\s+\S")
_LIST_RE = re.compile(r"^([ \t]*)([-*+]|\d{1,4}[.)])\s+(.*)$")


def split_frontmatter(text: str):
    """Return (title_or_None, body) — YAML front matter is dropped, only its
    ``title:`` field is read (nested keys and multi-line values are ignored)."""
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return None, text
    title = None
    for line in match.group(1).splitlines():
        key, _, value = line.partition(":")
        if key.strip().lower() == "title" and not line[:1].isspace():
            title = value.strip().strip("'\"") or None
    return title, text[match.end():]


def md_to_blocks(text: str) -> list:
    """Parse markdown into a tree of ``{"content": str, "children": [...]}``."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    root = {"content": "", "children": []}
    headings = [(0, root)]   # (heading level, node) — nesting for everything
    lists = []               # (indent width, node) — the current list run
    para: list[str] = []     # pending paragraph lines
    para_target = root
    count = 0

    def flush_para():
        nonlocal para, count
        if para and count < MAX_BLOCKS:
            para_target["children"].append({"content": "\n".join(para).strip(), "children": []})
            count += 1
        para = []

    def add(parent, content):
        nonlocal count
        node = {"content": content, "children": []}
        if count < MAX_BLOCKS:
            parent["children"].append(node)
            count += 1
        return node

    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()

        if not stripped:
            flush_para()
            lists.clear()
            i += 1
            continue

        if _HEADING_RE.match(stripped) and raw[:1] not in (" ", "\t"):
            flush_para()
            lists.clear()
            level = len(stripped) - len(stripped.lstrip("#"))
            while len(headings) > 1 and headings[-1][0] >= level:
                headings.pop()
            headings.append((level, add(headings[-1][1], stripped)))
            i += 1
            continue

        if stripped.startswith("```") or stripped.startswith("~~~"):
            flush_para()
            fence = stripped[:3]
            buf = [raw.rstrip()]
            i += 1
            while i < len(lines):
                buf.append(lines[i].rstrip())
                if lines[i].strip().startswith(fence):
                    i += 1
                    break
                i += 1
            add(lists[-1][1] if lists else headings[-1][1], "\n".join(buf))
            continue

        list_match = _LIST_RE.match(raw)
        if list_match:
            flush_para()
            indent = len(list_match.group(1).replace("\t", "    "))
            marker, body = list_match.group(2), list_match.group(3).strip()
            while lists and lists[-1][0] >= indent:
                lists.pop()
            parent = lists[-1][1] if lists else headings[-1][1]
            content = body if len(marker) == 1 else f"{marker} {body}"
            lists.append((indent, add(parent, content)))
            i += 1
            continue

        # Plain text: continuation of a list item while indented, else a
        # paragraph under the current heading (which ends any list run).
        if not (lists and raw[:1] in (" ", "\t")):
            lists.clear()
        target = lists[-1][1] if lists else headings[-1][1]
        if para and para_target is not target:
            flush_para()
        para_target = target
        para.append(stripped)
        i += 1

    flush_para()
    return root["children"]
