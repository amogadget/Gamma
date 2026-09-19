"""Paint highlight notes onto the page itself ("notes on page" PDF export).

The plain annotated export (``pdf_export.annotate_pdf``) keeps note text in
annotation popups — invisible when the file is printed, and one click away in
every viewer. This module additionally draws each note as a small box placed in
the nearest patch of *empty* page space, with a leader line back to its
highlight.

Empty space comes from the page's own content: pdfium reports a bounding box
for every text run / path / image, which we rasterize into a coarse occupancy
grid (display space, top-left origin, one cell = ``CELL`` pt). A summed-area
table over that grid answers "is this candidate rectangle free?" in O(1), so a
few thousand candidate positions per note can be scored and the cheapest one
near the highlight kept. Boxes already placed are marked occupied too, so notes
never collide with each other.

Everything is laid out in display space (x right, y down, /Rotate applied) —
the same space the viewer stores highlight rects in — and drawn under one ``cm``
that maps that frame back to PDF user space, so rotated pages need no special
casing beyond that matrix.

Notes are markdown with LaTeX and image refs, not plain text: ``note_markup``
splits them into text spans (with super/subscript levels), inline math, display
math and images. ``vector_text`` typesets the math and ``pdf_glyphs`` draws it
as Type 3 text (inline expressions sit on the text baseline, ``$$…$$`` gets
its own centred row), ``pdf_image`` embeds the uploads as image XObjects, and
a box that had to squeeze either one down loses to a wider candidate during
placement.

Prose is drawn with three fonts, all built into every PDF viewer: Helvetica for
WinAnsi, the Symbol font for the Greek and math left over when the math
renderer is unavailable (``\\phi`` → φ, ``\\sum`` → ∑), and a non-embedded
STSong-Light CID font for CJK — viewers with Asian font support render that,
others substitute, and the raw text is still in the annotation popup.
"""

import io
import math

from PyPDF2 import PdfReader, PdfWriter
from PyPDF2._page import PageObject
from PyPDF2.generic import (
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    RectangleObject,
)

from . import vector_text
from .logbuf import log
from .note_markup import TEXT, latex_spans, parse_note
from .pdf_export import parse_css_color
from .pdf_glyphs import GlyphFonts
from .pdf_image import XObjectStore
from .pdf_typeset import (
    CID,
    HELV,
    LEADING,
    SYM,
    draw_spans,
    font_resources,
    line_metrics,
    num as _num,
    plain,
    resolve,
    spans_width,
    wrap,
)

CELL = 3.0              # occupancy grid resolution, pt
FONT_SIZE = 7.4
PAD = 4.0               # box inner padding
BORDER = 0.7
BOX_WIDTHS = (168.0, 132.0, 102.0)
WIDE_WIDTHS = (260.0, 190.0, 140.0)     # notes with a picture or display math
IMAGE_MAX_H = 150.0
IMAGE_GAP = 2.0
PX_PT = 0.75            # CSS px → pt: pasted screenshots are 96 dpi
DISPLAY_MATH_SCALE = 1.15   # $$…$$ is set a touch larger than the note text
PAGE_MARGIN = 8.0       # never place a box closer than this to the page edge
CLEARANCE = 2.5         # empty space to keep around a placed box
MAX_BOX_FRAC = 0.45     # box height cap, as a fraction of the page height
X_STEP = 9.0            # candidate grid for the placement search
Y_STEP = 8.0
Y_RANGE = 320.0         # how far above/below the highlight to look

# The three fonts the boxes draw with (pdf_typeset picks between them per
# character) — kept as a tuple so the page resources carry only these.
_FONTS = (HELV, SYM, CID)


def _measure(items, width: float, size: float, max_h: float, images):
    """Note items → (rows, natural width, height). A row is
    ``("text", indent, spans, ascent, height)``, ``("image", name, w, h)`` or
    ``("math", (drawing, scale), w, h)``. Content past ``max_h`` is dropped with an ellipsis
    — the full text is still in the annotation popup."""
    rows, height, natural, cut, shrink = [], 2 * PAD, 0.0, False, 1.0
    for item in items:
        if height >= max_h:
            cut = True
            break
        if item["kind"] == "math":
            math = vector_text.math(item["tex"], size * DISPLAY_MATH_SCALE)
            if math:
                drawing, w, h, _asc = math
                scale = min(1.0, width / w) if w else 1.0
                if h * scale > max_h - height - IMAGE_GAP:
                    scale = min(scale, max(0.0, max_h - height - IMAGE_GAP) / h)
                if h * scale < 5:
                    cut = True
                    break
                shrink = min(shrink, scale)
                rows.append(("math", (drawing, scale), w * scale, h * scale))
                height += h * scale + IMAGE_GAP
                natural = max(natural, w * scale)
                continue
            item = {"spans": latex_spans(item["tex"])}     # renderer gave up
        elif item["kind"] == "image":
            info = images.get(item["src"])
            if info:
                name, px_w, px_h = info
                w = min(width, px_w * PX_PT)
                h = w * px_h / max(px_w, 1)
                for cap in (IMAGE_MAX_H, max(0.0, max_h - height - IMAGE_GAP)):
                    if h > cap > 0:
                        w, h = w * cap / h, cap
                if h < 8:
                    cut = True
                    break
                shrink = min(shrink, w / max(px_w * PX_PT, 1))
                rows.append(("image", name, w, h))
                height += h + IMAGE_GAP
                natural = max(natural, w)
                continue
            item = {"spans": [(TEXT, (item.get("alt") or "image").strip(), 0)]}
        spans = resolve(plain(item["spans"]), size, width)
        for indent, line in wrap(spans, width, size):
            ascent, line_h = line_metrics(line, size)
            if height + line_h > max_h:
                cut = True
                break
            rows.append(("text", indent, line, ascent, line_h))
            height += line_h
            natural = max(natural, indent + spans_width(line, size))
        if cut:
            break
    if cut:
        rows.append(("text", 0.0, plain([(TEXT, "\u2026", 0)]), size * 0.82, size * LEADING))
        height += size * LEADING
    return rows, natural, height, shrink


# --- free-space search -------------------------------------------------------

class _Space:
    """Occupancy of one page in display space, plus the boxes placed so far."""

    def __init__(self, width: float, height: float):
        self.w, self.h = width, height
        self.cols = max(1, int(math.ceil(width / CELL)))
        self.rows = max(1, int(math.ceil(height / CELL)))
        self.grid = bytearray(self.cols * self.rows)
        self.sat = None
        self.placed = []

    def mark(self, rect):
        x0, y0, x1, y1 = rect
        c0 = max(0, int(x0 / CELL))
        c1 = min(self.cols, int(math.ceil(x1 / CELL)))
        r0 = max(0, int(y0 / CELL))
        r1 = min(self.rows, int(math.ceil(y1 / CELL)))
        for r in range(r0, r1):
            base = r * self.cols
            for c in range(c0, c1):
                self.grid[base + c] = 1

    def freeze(self):
        """Summed-area table so rect queries are O(1)."""
        cols, rows = self.cols, self.rows
        sat = [0] * ((cols + 1) * (rows + 1))
        for r in range(rows):
            row_sum = 0
            base, above, cur = r * cols, r * (cols + 1), (r + 1) * (cols + 1)
            for c in range(cols):
                row_sum += self.grid[base + c]
                sat[cur + c + 1] = sat[above + c + 1] + row_sum
        self.sat = sat

    def occupied(self, x0, y0, x1, y1) -> int:
        """Number of occupied cells under the rect (page content only)."""
        cols = self.cols
        c0 = max(0, min(cols, int(x0 / CELL)))
        c1 = max(0, min(cols, int(math.ceil(x1 / CELL))))
        r0 = max(0, min(self.rows, int(y0 / CELL)))
        r1 = max(0, min(self.rows, int(math.ceil(y1 / CELL))))
        if c1 <= c0 or r1 <= r0:
            return 0
        sat, stride = self.sat, cols + 1
        return (sat[r1 * stride + c1] - sat[r0 * stride + c1]
                - sat[r1 * stride + c0] + sat[r0 * stride + c0])

    def hits_placed(self, x0, y0, x1, y1) -> bool:
        for px0, py0, px1, py1 in self.placed:
            if x0 < px1 and px0 < x1 and y0 < py1 and py0 < y1:
                return True
        return False


def _cost(box, anchor):
    bx0, by0, bx1, by1 = box
    ax0, ay0, ax1, ay1 = anchor
    gap_x = 0.0 if bx0 < ax1 and ax0 < bx1 else min(abs(bx0 - ax1), abs(ax0 - bx1))
    return gap_x + 1.3 * abs(by0 - ay0)


def _place(space: _Space, anchor, box_w: float, box_h: float, width_penalty: float):
    """Cheapest free spot for a box_w × box_h box near ``anchor`` → (score, x,
    y, free) or None. Falls back to the least-covered spot when nothing is
    free, so a note is never silently dropped on a densely typeset page."""
    x_lo, x_hi = PAGE_MARGIN, space.w - PAGE_MARGIN - box_w
    if x_hi < x_lo or box_h > space.h - 2 * PAGE_MARGIN:
        return None
    xs = [x_lo + i * X_STEP for i in range(int((x_hi - x_lo) / X_STEP) + 1)] + [x_hi]
    ax_mid = (anchor[0] + anchor[2]) / 2
    xs.sort(key=lambda x: abs(x + box_w / 2 - ax_mid))

    best = None          # (score, x, y, free)
    steps = int(Y_RANGE / Y_STEP)
    for i in range(2 * steps + 1):
        dy = (i + 1) // 2 * Y_STEP * (1 if i % 2 else -1)
        y = anchor[1] + dy
        y = min(max(y, PAGE_MARGIN), space.h - PAGE_MARGIN - box_h)
        for x in xs:
            box = (x, y, x + box_w, y + box_h)
            if space.hits_placed(*box):
                continue
            covered = space.occupied(x - CLEARANCE, y - CLEARANCE,
                                     x + box_w + CLEARANCE, y + box_h + CLEARANCE)
            score = _cost(box, anchor) + width_penalty + covered * 6.0
            if best is None or score < best[0]:
                best = (score, x, y, covered == 0)
        if best and best[3] and best[0] - width_penalty < 24:
            break        # snug against the highlight already — stop looking
    return best


# --- content stream ----------------------------------------------------------

def _draw_note(ops: list, box, anchor, rows, size: float, color, glyphs):
    """Box + leader line + rows, all in display coordinates; ``glyphs`` is the
    document's GlyphFonts, which draws the math."""
    r, g, b, _a = color
    bx0, by0, bx1, by1 = box
    # Border: the highlight's hue darkened; fill: the same hue washed out, so
    # the box reads as belonging to its highlight without fighting the page.
    br, bg, bb = (max(0.0, c * 0.62) for c in (r, g, b))
    fr, fg, fb = (1 - (1 - c) * 0.16 for c in (r, g, b))

    ax0, ay0, ax1, ay1 = anchor
    px = min(max((bx0 + bx1) / 2, ax0), ax1)
    py = min(max((by0 + by1) / 2, ay0), ay1)
    qx = min(max(px, bx0), bx1)
    qy = min(max(py, by0), by1)
    if math.hypot(qx - px, qy - py) > 3:
        ops.append(b"%s %s %s RG %s w [2 2] 0 d %s %s m %s %s l S [] 0 d" % (
            _num(br), _num(bg), _num(bb), _num(BORDER),
            _num(px), _num(py), _num(qx), _num(qy)))
        ops.append(b"%s %s %s rg %s %s 2.6 2.6 re f" % (
            _num(br), _num(bg), _num(bb), _num(px - 1.3), _num(py - 1.3)))

    ops.append(b"%s %s %s rg %s %s %s %s re f" % (
        _num(fr), _num(fg), _num(fb),
        _num(bx0), _num(by0), _num(bx1 - bx0), _num(by1 - by0)))
    ops.append(b"%s %s %s RG %s w %s %s %s %s re S" % (
        _num(br), _num(bg), _num(bb), _num(BORDER),
        _num(bx0), _num(by0), _num(bx1 - bx0), _num(by1 - by0)))

    y = by0 + PAD
    inner = bx1 - bx0 - 2 * PAD
    for row in rows:
        if row[0] == "image":
            _kind, name, w, h = row
            # The frame has y running down, so flip the image matrix back.
            ops.append(b"q %s 0 0 %s %s %s cm /%s Do Q" % (
                _num(w), _num(-h), _num(bx0 + PAD), _num(y + h), name.encode()))
            y += h + IMAGE_GAP
            continue
        if row[0] == "math":                     # display math, centred
            _kind, (drawing, scale), w, h = row
            ops.append(b"q %s 0 0 %s %s %s cm" % (
                _num(scale), _num(scale), _num(bx0 + PAD + max(0, (inner - w) / 2)), _num(y)))
            ops.append(glyphs.draw(drawing))
            ops.append(b"Q")
            y += h + IMAGE_GAP
            continue
        _kind, indent, spans, ascent, line_h = row
        draw_spans(ops, bx0 + PAD + indent, y + ascent, spans, size, glyphs=glyphs)
        y += line_h


def _stamp(writer, page_index: int, matrix, ops: list, xobjects, glyph_fonts):
    """Merge the drawing onto the page as an overlay content stream.
    ``glyph_fonts`` is ``GlyphFonts.resources()`` — the Type 3 fonts the math
    was drawn with, referenced now and filled in at ``finalize()``."""
    page = writer.pages[page_index]
    body = b"q %s cm\n" % b" ".join(_num(v) for v in matrix) + b"\n".join(ops) + b"\nQ"

    overlay = PageObject.create_blank_page(width=1, height=1)
    box = [float(v) for v in (page.mediabox.left, page.mediabox.bottom,
                              page.mediabox.right, page.mediabox.top)]
    crop = [float(v) for v in (page.cropbox.left, page.cropbox.bottom,
                               page.cropbox.right, page.cropbox.top)]
    # merge_page clips the overlay to its own trim box — cover both boxes.
    rect = RectangleObject((min(box[0], crop[0]), min(box[1], crop[1]),
                            max(box[2], crop[2]), max(box[3], crop[3])))
    overlay[NameObject("/MediaBox")] = rect
    overlay[NameObject("/TrimBox")] = rect
    stream = DecodedStreamObject()
    stream.set_data(body)
    overlay[NameObject("/Contents")] = stream
    fonts = font_resources(_FONTS)
    fonts.update({NameObject("/" + name): ref for name, ref in glyph_fonts.items()})
    resources = DictionaryObject({NameObject("/Font"): fonts})
    if xobjects:
        resources[NameObject("/XObject")] = DictionaryObject(
            {NameObject("/" + name): ref for name, ref in xobjects.items()})
    overlay[NameObject("/Resources")] = resources

    page.merge_page(overlay)
    # PyPDF2 leaves the merged content inline in the page dict; streams must be
    # indirect objects or the file is unreadable.
    page[NameObject("/Contents")] = writer._add_object(page[NameObject("/Contents")])


# --- geometry ----------------------------------------------------------------

def _frame(crop, rotation):
    """Display frame (x right, y down, origin top-left of the visible page) →
    (display size, cm matrix into user space, user→display point mapper)."""
    cx0, cy0, cx1, cy1 = crop
    if rotation == 90:
        size = (cy1 - cy0, cx1 - cx0)
        return size, (0, 1, 1, 0, cx0, cy0), lambda px, py: (py - cy0, px - cx0)
    if rotation == 180:
        size = (cx1 - cx0, cy1 - cy0)
        return size, (-1, 0, 0, 1, cx1, cy0), lambda px, py: (cx1 - px, py - cy0)
    if rotation == 270:
        size = (cy1 - cy0, cx1 - cx0)
        return size, (0, -1, -1, 0, cx1, cy1), lambda px, py: (cy1 - py, cx1 - px)
    size = (cx1 - cx0, cy1 - cy0)
    return size, (1, 0, 0, -1, cx0, cy1), lambda px, py: (px - cx0, cy1 - py)


def _anchor_rect(pos, disp_w, disp_h):
    """Stored viewer rects → one display-space bounding box."""
    rects = pos.get("rects") or ([pos["boundingRect"]] if pos.get("boundingRect") else [])
    xs, ys = [], []
    for r in rects:
        if not r or r.get("x1") is None:
            continue
        rw = float(r.get("width") or 0) or disp_w
        rh = float(r.get("height") or 0) or disp_h
        for vx, vy in ((r["x1"], r["y1"]), (r["x2"], r["y2"])):
            xs.append(float(vx) / rw * disp_w)
            ys.append(float(vy) / rh * disp_h)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _page_occupancy(pdfium_page, to_display, disp_w, disp_h) -> _Space:
    """Everything the page already draws, as a display-space occupancy grid."""
    space = _Space(disp_w, disp_h)
    area = disp_w * disp_h
    boxes = []
    if pdfium_page is not None:
        # max_depth=1: a form XObject's own bounds already cover its contents,
        # and nested objects' bounds are in the form's space, not the page's.
        for obj in pdfium_page.get_objects(max_depth=1):
            try:
                l, b, r, t = obj.get_bounds()
            except Exception:
                continue
            x0, y0 = to_display(l, t)
            x1, y1 = to_display(r, b)
            box = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
            if (box[2] - box[0]) * (box[3] - box[1]) > 0.6 * area:
                continue        # page-sized background fill, not content
            boxes.append(box)
    if not boxes:
        # No object info (pdfium failed, or a scanned page): assume the usual
        # text block is busy so notes still land in the margins.
        boxes = [(disp_w * 0.07, disp_h * 0.05, disp_w * 0.93, disp_h * 0.95)]
    for box in boxes:
        space.mark(box)
    space.freeze()
    return space


# --- entry point -------------------------------------------------------------

def render_notes(pdf_bytes: bytes, notes, uploads_dir=None) -> tuple[bytes, int]:
    """Return (pdf bytes with note boxes drawn, number of boxes drawn).

    ``notes``: [{position: <pdf_position dict>, color: <css string>,
    note: <str>}] — the same shape ``pdf_export.annotate_pdf`` takes. Notes
    without text, without usable rects, or on an out-of-range page are skipped.
    ``uploads_dir`` is where ``/api/uploads/…`` refs are read from; without it
    images degrade to their alt text.
    """
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    writer.append(reader)

    by_page: dict[int, list] = {}
    for n in notes:
        text = (n.get("note") or "").strip()
        pos = n.get("position") or {}
        page_num = pos.get("pageNumber") or (pos.get("boundingRect") or {}).get("pageNumber")
        if not text or not page_num or page_num < 1 or page_num > len(writer.pages):
            continue
        items = parse_note(text)
        if items:
            by_page.setdefault(int(page_num), []).append((items, pos, n.get("color")))
    if not by_page:
        return pdf_bytes, 0

    try:
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(pdf_bytes)
    except Exception as e:
        log.warning(f"[pdf-notes] pdfium open failed ({e}); placing notes in the margins")
        doc = None

    images = XObjectStore(writer, uploads_dir)
    glyphs = GlyphFonts(writer)
    drawn = 0
    try:
        for page_num, entries in sorted(by_page.items()):
            page = writer.pages[page_num - 1]
            crop = tuple(float(v) for v in (page.cropbox.left, page.cropbox.bottom,
                                            page.cropbox.right, page.cropbox.top))
            try:
                rotation = int(page.rotation) % 360
            except Exception:
                rotation = 0
            (disp_w, disp_h), matrix, to_display = _frame(crop, rotation)
            if disp_w <= 0 or disp_h <= 0:
                continue

            pdfium_page = None
            if doc is not None:
                try:
                    pdfium_page = doc[page_num - 1]
                except Exception:
                    pdfium_page = None
            space = _page_occupancy(pdfium_page, to_display, disp_w, disp_h)

            placements = []
            for items, pos, color in entries:
                anchor = _anchor_rect(pos, disp_w, disp_h)
                if not anchor:
                    continue
                resolved = {}
                for item in items:
                    if item["kind"] == "image":
                        info = images.resolve(item["src"])
                        if info:
                            resolved[item["src"]] = info
                placements.append((anchor, items, resolved, parse_css_color(color)))
            placements.sort(key=lambda p: (p[0][1], p[0][0]))

            ops, used = [], {}
            max_h = disp_h * MAX_BOX_FRAC
            for anchor, items, resolved, color in placements:
                blocks = bool(resolved) or any(i["kind"] == "math" for i in items)
                widths = WIDE_WIDTHS if blocks else BOX_WIDTHS
                best = None
                for width in widths:
                    limit = min(width, disp_w - 2 * PAGE_MARGIN) - 2 * PAD
                    rows, natural, box_h, shrink = _measure(
                        items, limit, FONT_SIZE, max_h, resolved)
                    # A one-line note gets a one-line-wide box, not a column.
                    box_w = min(limit, natural) + 2 * PAD
                    # Penalty for narrow boxes, and for squeezing an equation or
                    # picture down to fit one — a shrunk formula is unreadable.
                    penalty = (widths[0] - width) * 0.35 + (1 - shrink) * 160
                    spot = _place(space, anchor, box_w, box_h, penalty)
                    if spot and (best is None or spot[0] < best[0][0]):
                        best = (spot, box_w, box_h, rows)
                    if spot and spot[3] and spot[0] < 30:
                        break
                if not best:
                    continue
                (_score, x, y, free), box_w, box_h, rows = best
                if not free:
                    log.info(f"[pdf-notes] page {page_num}: no free space, "
                             f"note box overlaps content")
                space.placed.append((x - CLEARANCE, y - CLEARANCE,
                                     x + box_w + CLEARANCE, y + box_h + CLEARANCE))
                _draw_note(ops, (x, y, x + box_w, y + box_h), anchor, rows, FONT_SIZE,
                           color, glyphs)
                used.update({row[1]: images.refs[row[1]] for row in rows if row[0] == "image"})
                drawn += 1

            if ops:
                _stamp(writer, page_num - 1, matrix, ops, used, glyphs.resources())
    finally:
        if doc is not None:
            doc.close()

    if not drawn:
        return pdf_bytes, 0
    glyphs.finalize()
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue(), drawn
