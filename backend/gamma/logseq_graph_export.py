"""Export a page as a real Logseq file graph (the format the actual app reads).

Unlike the ``logseq`` Markdown flavour (one .md, Gamma-specific ``hl-position``
property), this produces the structures Logseq's PDF annotation system is
actually wired to:

- ``pages/<stem>.md``          — the user's notes; highlights become ``((uuid))``
                                 block refs into the hls page.
- ``pages/hls__<stem>.md``     — the annotations page (``ls-type:: annotation``
                                 blocks with UUID ids), named after the PDF asset.
- ``assets/<stem>.pdf``        — the PDF, renamed from its sha to the page stem
                                 so the ``hls__`` naming convention holds.
- ``assets/<stem>.edn``        — highlight geometry (``{:highlights [...]}``).
- ``assets/<stem>/<page>_<uuid>_<stamp>.png`` — area-highlight crops, rendered
                                 with pypdfium2 (skipped silently if rendering
                                 fails; the annotation block still exports).
- ``logseq/config.edn``        — minimal marker so importers accept the folder.

File-based Logseq ("OG") reads this directly (drop into a graph / open as one);
the DB version converts it — hls pages and EDN included — via its built-in
"File to DB graph" importer, so this one format serves both apps.

Highlight UUIDs are uuid5 of the Gamma highlight id, so re-exports are stable.
Positions transfer verbatim: Gamma's ``pdf_position`` uses the same
rects/bounding model as Logseq's EDN (see ``logseq_import.edn_highlight_position``,
which maps them 1:1 on the way in).
"""

import struct
import uuid
import zlib

from .markdown_export import _RGBA_TO_NAME

CONFIG_EDN = "{:meta/version 1}\n"

_UUID_NS = uuid.uuid5(uuid.NAMESPACE_URL, "gamma-logseq-highlight")


def hl_uuid(highlight_id):
    return uuid.uuid5(_UUID_NS, str(highlight_id))


def hl_stamp(u):
    """Deterministic Logseq-style stamp (they use epoch ms; only consistency
    between the md property, the EDN entry and the image filename matters)."""
    return int.from_bytes(u.bytes[:6], "big") % 10**13


def color_name(rgba):
    return _RGBA_TO_NAME.get((rgba or "").strip(), "yellow")


# --- highlight collection ----------------------------------------------------


def collect_highlights(page):
    """Walk the page tree in document order and describe every annotation-able
    highlight (link regions are navigation aids, not annotations)."""
    out = []

    def walk(node):
        props = node.get("properties") or {}
        if props.get("highlight_id") and not (props.get("link_url") or props.get("link_page_id")):
            u = hl_uuid(props["highlight_id"])
            pos = props.get("pdf_position")
            area = bool(pos and (pos.get("area") or (pos.get("boundingRect") or {}).get("area")))
            quote = (props.get("quote") or "").strip()
            out.append(
                {
                    "uuid": u,
                    "quote": quote,
                    "color": color_name(props.get("color")),
                    "page": props.get("pdf_page") or (pos or {}).get("pageNumber") or 1,
                    "position": pos,
                    "area": area or (not quote and bool(pos)),
                    "stamp": hl_stamp(u),
                }
            )
        for child in node.get("children", []):
            walk(child)

    walk(page)
    return out


# --- hls__ page + EDN --------------------------------------------------------


def render_hls_md(stem, highlights):
    lines = [f"file-path:: ../assets/{stem}.pdf", ""]

    def top(h):
        br = (h["position"] or {}).get("boundingRect") or {}
        return br.get("y1") or 0

    for h in sorted(highlights, key=lambda h: (h["page"], top(h))):
        lines.append(f"- {' '.join(h['quote'].split()) if h['quote'] else '[:span]'}")
        lines.append("  ls-type:: annotation")
        lines.append(f"  hl-page:: {h['page']}")
        lines.append(f"  hl-color:: {h['color']}")
        lines.append(f"  id:: {h['uuid']}")
        if h["area"]:
            lines.append("  hl-type:: area")
            lines.append(f"  hl-stamp:: {h['stamp']}")
    return "\n".join(lines).rstrip() + "\n"


def _edn_scalar(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return repr(v)
    if isinstance(v, int):
        return str(v)
    if v is None:
        return "nil"
    s = str(v).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\t", "\\t")
    return f'"{s}"'


def _edn_rect(r):
    keys = ("x1", "y1", "x2", "y2", "width", "height")
    return "{" + " ".join(f":{k} {_edn_scalar((r or {}).get(k, 0))}" for k in keys) + "}"


def render_edn(highlights):
    entries = []
    for h in highlights:
        pos = h["position"]
        if not pos or not pos.get("boundingRect"):
            continue  # geometry unknown (e.g. imported without EDN) — md-only
        rects = " ".join(_edn_rect(r) for r in (pos.get("rects") or [pos["boundingRect"]]))
        content = f":text {_edn_scalar(h['quote'])}"
        if h["area"]:
            content = f':text "[:span]" :image {h["stamp"]}'
        entries.append(
            "{"
            f':id #uuid "{h["uuid"]}" '
            f":page {h['page']} "
            f":position {{:bounding {_edn_rect(pos['boundingRect'])} :rects [{rects}] :page {h['page']}}} "
            f":content {{{content}}} "
            f':properties {{:color "{h["color"]}"}}'
            "}"
        )
    return "{:highlights [" + "\n ".join(entries) + "]\n :extra {:page 1}}\n"


# --- user page ---------------------------------------------------------------


def render_graph_page_md(page, stem, has_pdf):
    """Logseq-dialect page whose highlight blocks are ``((uuid))`` refs into the
    hls page (the native shape of notes made from Logseq's PDF viewer)."""
    props = page.get("properties") or {}
    title = (page.get("content") or "").strip() or "Untitled"

    lines = [f"title:: {title}"]
    src = props.get("source_url") or ""
    if src and not src.startswith("/api/uploads/"):
        lines.append(f"source:: {src}")
    lines.append("")
    if has_pdf:
        lines.append(f"- ![{title}](../assets/{stem}.pdf)")

    for child in page["children"]:
        _render_block(child, 0, lines, has_pdf)
    return "\n".join(lines).rstrip() + "\n"


def _oneline(text):
    return " ".join((text or "").split("\n")).strip()


def _render_block(node, depth, lines, has_pdf):
    props = node.get("properties") or {}
    content = (node.get("content") or "").strip()
    tabs = "\t" * depth

    if props.get("link_url"):
        label = content or (props.get("quote") or "").strip() or props["link_url"]
        lines.append(f"{tabs}- [{_oneline(label)}]({props['link_url']})")
    elif props.get("highlight_id") and not props.get("link_page_id"):
        if has_pdf:
            bullet = f"(({hl_uuid(props['highlight_id'])}))"
        else:
            # No PDF asset in the graph → no hls page to point at; keep the
            # quote itself so the note still reads.
            bullet = _oneline(props.get("quote") or "") or _oneline(content) or "[:span]"
        lines.append(f"{tabs}- {bullet}")
        note = _oneline(content)
        if note and note != bullet:
            child_tabs = "\t" * (depth + 1)
            lines.append(f"{child_tabs}- {note}")
        for child in node["children"]:
            _render_block(child, depth + 1, lines, has_pdf)
        return
    elif content:
        lines.append(f"{tabs}- {_oneline(content)}")
    else:
        for child in node["children"]:
            _render_block(child, depth, lines, has_pdf)
        return
    for child in node["children"]:
        _render_block(child, depth + 1, lines, has_pdf)


# --- area-highlight images ---------------------------------------------------


def _encode_png(width, height, rgb_rows):
    """Minimal PNG writer (8-bit RGB, filter 0) — avoids a Pillow dependency."""

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(b"\x00" + row for row in rgb_rows)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def render_area_images(pdf_path, stem, highlights, scale=2.0):
    """Render each area highlight's crop → ``[(arcname, png_bytes)]``.
    Best-effort: any failure just drops the image, never the export."""
    areas = [h for h in highlights if h["area"] and h["position"] and h["position"].get("boundingRect")]
    if not areas:
        return []
    out = []
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(str(pdf_path))
        try:
            for h in areas:
                try:
                    page = pdf[h["page"] - 1]
                    bitmap = page.render(scale=scale, rev_byteorder=True)
                    buf = bytes(bitmap.buffer)
                    W, H, stride, nch = bitmap.width, bitmap.height, bitmap.stride, bitmap.n_channels
                    br = h["position"]["boundingRect"]
                    # br coords are relative to a capture-time render of size
                    # width×height — rescale into this bitmap's pixel grid.
                    sx, sy = W / (br.get("width") or W), H / (br.get("height") or H)
                    x1, x2 = sorted((int(br["x1"] * sx), int(br["x2"] * sx)))
                    y1, y2 = sorted((int(br["y1"] * sy), int(br["y2"] * sy)))
                    x1, y1 = max(0, x1), max(0, y1)
                    x2, y2 = min(W, max(x2, x1 + 1)), min(H, max(y2, y1 + 1))
                    rows = []
                    for y in range(y1, y2):
                        row = buf[y * stride + x1 * nch : y * stride + x2 * nch]
                        if nch == 4:  # RGBA → RGB
                            row = b"".join(row[i : i + 3] for i in range(0, len(row), 4))
                        rows.append(row)
                    png = _encode_png(x2 - x1, y2 - y1, rows)
                    out.append((f"assets/{stem}/{h['page']}_{h['uuid']}_{h['stamp']}.png", png))
                except Exception:
                    continue
        finally:
            pdf.close()
    except Exception:
        return out
    return out
