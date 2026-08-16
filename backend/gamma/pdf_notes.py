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
math and images. ``math_render`` typesets the math as vector paths (inline
expressions sit on the text baseline, ``$$…$$`` gets its own centred row),
``pdf_image`` embeds the uploads as image XObjects, and a box that had to
squeeze either one down loses to a wider candidate during placement.

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
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    RectangleObject,
    create_string_object,
)

from . import math_render
from .logbuf import log
from .markdown_export import UPLOAD_RE
from .note_markup import MATH, SUB, SUP, TEXT, latex_spans, merge_spans, parse_note
from .pdf_export import parse_css_color
from .pdf_image import image_xobject

CELL = 3.0              # occupancy grid resolution, pt
FONT_SIZE = 7.4
LEADING = 1.22          # × font size
SUP_SCALE = 0.72        # super/subscript size and baseline shift, × font size
SUP_RISE = 0.30
SUB_DROP = 0.16
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

# Helvetica AFM advance widths (1/1000 em) for ASCII 32..126; anything else
# WinAnsi can encode gets the average. Only used for line breaking.
_HELV = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,   # ' '..'/'
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,   # '0'..'?'
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,  # '@'..'O'
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,   # 'P'..'_'
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,   # '`'..'o'
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,        # 'p'..'~'
]
_HELV_DEFAULT = 556

# Greek and math, as carried by the base-14 Symbol font: char → (code, width).
# Both columns were measured from the font itself, not copied from a table.
SYMBOL = {
    "∀": (0x22, 713), "∃": (0x24, 549), "∋": (0x27, 439), "∗": (0x2a, 500), "−": (0x2d, 549),
    "≅": (0x40, 549), "Α": (0x41, 722), "Β": (0x42, 667), "Χ": (0x43, 722), "∆": (0x44, 612),
    "Ε": (0x45, 611), "Φ": (0x46, 763), "Γ": (0x47, 603), "Η": (0x48, 722), "Ι": (0x49, 333),
    "ϑ": (0x4a, 631), "Κ": (0x4b, 722), "Λ": (0x4c, 686), "Μ": (0x4d, 889), "Ν": (0x4e, 722),
    "Ο": (0x4f, 722), "Π": (0x50, 768), "Θ": (0x51, 741), "Ρ": (0x52, 556), "Σ": (0x53, 592),
    "Τ": (0x54, 611), "Υ": (0x55, 690), "ς": (0x56, 439), "Ω": (0x57, 768), "Ξ": (0x58, 645),
    "Ψ": (0x59, 795), "Ζ": (0x5a, 611), "∴": (0x5c, 863), "⊥": (0x5e, 658),
    "α": (0x61, 631), "β": (0x62, 549), "χ": (0x63, 549), "δ": (0x64, 494), "ε": (0x65, 439),
    "φ": (0x66, 521), "γ": (0x67, 411), "η": (0x68, 603), "ι": (0x69, 329), "ϕ": (0x6a, 603),
    "κ": (0x6b, 549), "λ": (0x6c, 549), "μ": (0x6d, 576), "ν": (0x6e, 521), "ο": (0x6f, 549),
    "π": (0x70, 549), "θ": (0x71, 521), "ρ": (0x72, 549), "σ": (0x73, 603), "τ": (0x74, 439),
    "υ": (0x75, 576), "ϖ": (0x76, 713), "ω": (0x77, 686), "ξ": (0x78, 493), "ψ": (0x79, 686),
    "ζ": (0x7a, 494), "∼": (0x7e, 549), "ϒ": (0xa1, 620), "′": (0xa2, 247), "≤": (0xa3, 549),
    "⁄": (0xa4, 167), "∞": (0xa5, 713), "↔": (0xab, 1042), "←": (0xac, 987), "↑": (0xad, 603),
    "→": (0xae, 987), "↓": (0xaf, 603), "″": (0xb2, 411), "≥": (0xb3, 549), "∝": (0xb5, 713),
    "∂": (0xb6, 494), "•": (0xb7, 460), "≠": (0xb9, 549), "≡": (0xba, 549), "≈": (0xbb, 549),
    "…": (0xbc, 1000), "↵": (0xbf, 658), "ℵ": (0xc0, 823), "ℑ": (0xc1, 686), "ℜ": (0xc2, 795),
    "℘": (0xc3, 987), "⊗": (0xc4, 768), "⊕": (0xc5, 768), "∅": (0xc6, 823), "∩": (0xc7, 768),
    "∪": (0xc8, 768), "⊃": (0xc9, 713), "⊇": (0xca, 713), "⊄": (0xcb, 713), "⊂": (0xcc, 713),
    "⊆": (0xcd, 713), "∈": (0xce, 713), "∉": (0xcf, 713), "∠": (0xd0, 768), "∇": (0xd1, 713),
    "∏": (0xd5, 823), "√": (0xd6, 549), "⋅": (0xd7, 250), "¬": (0xd8, 713), "∧": (0xd9, 603),
    "∨": (0xda, 603), "⇔": (0xdb, 1042), "⇐": (0xdc, 987), "⇑": (0xdd, 603), "⇒": (0xde, 987),
    "⇓": (0xdf, 603), "◊": (0xe0, 494), "〈": (0xe1, 329), "∑": (0xe5, 713), "〉": (0xf1, 329),
    "∫": (0xf2, 274),
}
# Unicode keeps near-duplicates of a few of these (Δ U+0394 vs ∆ U+2206, the
# angle brackets), and a note may be typed with either — draw them the same.
for _twin, _canon in (("Δ", "∆"), ("Ω", "Ω"),
                      ("⟨", "〈"), ("⟩", "〉"),
                      ("〈", "〈"), ("〉", "〉")):
    SYMBOL.setdefault(_twin, SYMBOL[_canon])

HELV, SYM, CID = "F1", "F3", "F2"


def _font_of(ch: str) -> str:
    """Which of the three fonts can draw this character."""
    try:
        ch.encode("cp1252")
        return HELV
    except UnicodeEncodeError:
        return SYM if ch in SYMBOL else CID


def _char_em(ch: str) -> float:
    font = _font_of(ch)
    if font == HELV:
        o = ord(ch)
        return (_HELV[o - 32] if 32 <= o <= 126 else _HELV_DEFAULT) / 1000.0
    if font == SYM:
        return SYMBOL[ch][1] / 1000.0
    return 1.0          # CID fonts here run at the default 1000/1000 width


def _size_of(size: float, level: int) -> float:
    return size * (SUP_SCALE if level else 1.0)


def _span_width(text: str, size: float, level: int = 0) -> float:
    return _size_of(size, level) * sum(_char_em(c) for c in text)


def _spans_width(spans, size: float) -> float:
    return sum(_token_width(k, p, lv, size) for k, p, lv in spans)


# --- text layout -------------------------------------------------------------

def _resolve(spans, size: float, width: float):
    """Typeset every inline-math span into (ops, w, h, ascent), falling back to
    the unicode approximation when the renderer can't handle it."""
    out = []
    for kind, payload, level in spans:
        if kind != MATH:
            out.append((kind, payload, level))
            continue
        math = math_render.render(payload, size)
        if math and math[1] <= width:
            out.append((MATH, math, level))
        else:
            if math:
                log.info("[pdf-notes] inline math too wide for the box, "
                         "falling back to text")
            out.extend(latex_spans(payload))
    return merge_spans(out)


def _token_width(kind, payload, level, size: float) -> float:
    return payload[1] if kind == MATH else _span_width(payload, size, level)


def _tokens(spans):
    """Unbreakable chunks across spans: words, single spaces, one token per CJK
    character (no spaces there, so every character breaks), and math as a
    whole."""
    out = []
    for kind, payload, level in spans:
        if kind == MATH:
            out.append((kind, payload, level))
            continue
        cur = ""
        for ch in payload:
            if ch == " " or _font_of(ch) == CID:
                if cur:
                    out.append((TEXT, cur, level))
                    cur = ""
                out.append((TEXT, ch, level))
            else:
                cur += ch
        if cur:
            out.append((TEXT, cur, level))
    return out


def _hang(spans, size: float, width: float) -> float:
    """Continuation indent: nested note bullets keep their step."""
    head = spans[0][1] if spans and spans[0][0] == TEXT else ""
    body = head.lstrip(" ")
    lead = head[: len(head) - len(body)]
    return min(_span_width(lead + ("  " if body[:2] in ("- ", "* ") else ""), size),
               width * 0.4)


def _line_metrics(spans, size: float):
    """(ascent, height) of one line: tall inline math pushes the line open."""
    asc, desc = size * 0.82, size * (LEADING - 0.82)
    for kind, payload, _level in spans:
        if kind == MATH:
            _ops, _w, h, a = payload
            asc = max(asc, a + 0.5)
            desc = max(desc, h - a + 0.5)
    return asc, asc + desc


def _wrap(spans, width: float, size: float):
    """Spans → [(indent, spans)], one entry per rendered line."""
    hang = _hang(spans, size, width)
    lines, cur, cur_w, indent = [], [], 0.0, 0.0
    for kind, payload, level in _tokens(spans):
        w = _token_width(kind, payload, level, size)
        if cur and cur_w + w > width - indent:
            if kind == TEXT and payload == " ":
                continue                          # swallow the break's space
            lines.append((indent, merge_spans(cur)))
            cur, cur_w, indent = [], 0.0, hang
        if not cur and kind == TEXT and payload == " ":
            continue
        while kind == TEXT and w > width - indent and len(payload) > 1:
            cut = len(payload)                    # one token too long: hard-split
            while cut > 1 and _span_width(payload[:cut], size, level) > width - indent:
                cut -= 1
            lines.append((indent, [(TEXT, payload[:cut], level)]))
            payload, indent = payload[cut:], hang
            w = _span_width(payload, size, level)
        cur.append((kind, payload, level))
        cur_w += w
    if cur:
        lines.append((indent, merge_spans(cur)))
    return lines or [(0.0, [])]


def _measure(items, width: float, size: float, max_h: float, images):
    """Note items → (rows, natural width, height). A row is
    ``("text", indent, spans, ascent, height)``, ``("image", name, w, h)`` or
    ``("math", ops, w, h)``. Content past ``max_h`` is dropped with an ellipsis
    — the full text is still in the annotation popup."""
    rows, height, natural, cut, shrink = [], 2 * PAD, 0.0, False, 1.0
    for item in items:
        if height >= max_h:
            cut = True
            break
        if item["kind"] == "math":
            math = math_render.render(item["tex"], size * DISPLAY_MATH_SCALE)
            if math:
                ops, w, h, _asc = math
                scale = min(1.0, width / w) if w else 1.0
                if h * scale > max_h - height - IMAGE_GAP:
                    scale = min(scale, max(0.0, max_h - height - IMAGE_GAP) / h)
                if h * scale < 5:
                    cut = True
                    break
                shrink = min(shrink, scale)
                rows.append(("math", (ops, scale), w * scale, h * scale))
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
        for indent, spans in _wrap(_resolve(item["spans"], size, width), width, size):
            ascent, line_h = _line_metrics(spans, size)
            if height + line_h > max_h:
                cut = True
                break
            rows.append(("text", indent, spans, ascent, line_h))
            height += line_h
            natural = max(natural, indent + _spans_width(spans, size))
        if cut:
            break
    if cut:
        rows.append(("text", 0.0, [(TEXT, "…", 0)], size * 0.82, size * LEADING))
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

def _esc(text: str) -> bytes:
    out = bytearray(b"(")
    for ch in text:
        b = ch.encode("cp1252", "replace")
        if b in (b"(", b")", b"\\"):
            out += b"\\"
        out += b
    return bytes(out + b")")


def _sym(text: str) -> bytes:
    out = bytearray(b"(")
    for ch in text:
        b = bytes([SYMBOL[ch][0]])
        if b in (b"(", b")", b"\\"):
            out += b"\\"
        out += b
    return bytes(out + b")")


def _hex(text: str) -> bytes:
    """UTF-16BE hex string for the CID font (BMP only)."""
    out = bytearray(b"<")
    for ch in text:
        o = ord(ch)
        out += b"%04X" % (o if o < 0x10000 else 0x3F)
    return bytes(out + b">")


def _runs(text: str, level: int):
    """[(font, chunk, level)] — one Tj per font stretch."""
    out = []
    for ch in text:
        font = _font_of(ch)
        if out and out[-1][0] == font:
            out[-1][1] += ch
        else:
            out.append([font, ch])
    return [(font, chunk, level) for font, chunk in out]


def _num(v: float) -> bytes:
    return b"%.2f" % round(v, 2)


def _draw_note(ops: list, box, anchor, rows, size: float, color):
    """Box + leader line + rows, all in display coordinates."""
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
            _kind, (math_ops, scale), w, h = row
            ops.append(b"q %s 0 0 %s %s %s cm" % (
                _num(scale), _num(scale), _num(bx0 + PAD + max(0, (inner - w) / 2)), _num(y)))
            ops.append(math_ops)
            ops.append(b"Q")
            y += h + IMAGE_GAP
            continue
        _kind, indent, spans, ascent, line_h = row
        x = bx0 + PAD + indent
        base = y + ascent
        for kind, payload, level in spans:
            if kind == MATH:
                math_ops, w, h, asc = payload
                ops.append(b"q 1 0 0 1 %s %s cm" % (_num(x), _num(base - asc)))
                ops.append(math_ops)
                ops.append(b"Q")
                x += w
                continue
            ops.append(b"BT 0.13 0.13 0.15 rg")
            for font, chunk, lv in _runs(payload, level):
                if chunk.strip():
                    fs = _size_of(size, lv)
                    shift = -SUP_RISE * size if lv == SUP else SUB_DROP * size if lv == SUB else 0
                    body = (_sym(chunk) if font == SYM else
                            _hex(chunk) if font == CID else _esc(chunk))
                    ops.append(b"/%s %s Tf 1 0 0 -1 %s %s Tm %s Tj" % (
                        font.encode(), _num(fs), _num(x), _num(base + shift), body))
                x += _span_width(chunk, size, lv)
            ops.append(b"ET")
        y += line_h


def _fonts():
    def base14(name):
        font = DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject(name),
        })
        if name == "/Helvetica":       # Symbol carries its own built-in encoding
            font[NameObject("/Encoding")] = NameObject("/WinAnsiEncoding")
        return font

    # Non-embedded CID font for anything the other two can't hold (CJK).
    # Adobe-GB1 with the standard UniGB-UCS2-H CMap: no font file to ship.
    cid = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/CIDFontType0"),
        NameObject("/BaseFont"): NameObject("/STSong-Light"),
        NameObject("/CIDSystemInfo"): DictionaryObject({
            NameObject("/Registry"): create_string_object("Adobe"),
            NameObject("/Ordering"): create_string_object("GB1"),
            NameObject("/Supplement"): NumberObject(2),
        }),
        NameObject("/DW"): NumberObject(1000),
    })
    wide = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type0"),
        NameObject("/BaseFont"): NameObject("/STSong-Light"),
        NameObject("/Encoding"): NameObject("/UniGB-UCS2-H"),
        NameObject("/DescendantFonts"): ArrayObject([cid]),
    })
    return DictionaryObject({
        NameObject("/" + HELV): base14("/Helvetica"),
        NameObject("/" + SYM): base14("/Symbol"),
        NameObject("/" + CID): wide,
    })


def _stamp(writer, page_index: int, matrix, ops: list, xobjects):
    """Merge the drawing onto the page as an overlay content stream."""
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
    resources = DictionaryObject({NameObject("/Font"): _fonts()})
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


# --- images ------------------------------------------------------------------

class _Images:
    """Uploaded images referenced by notes → PDF XObjects, one per file."""

    def __init__(self, writer, uploads_dir):
        self.writer, self.dir = writer, uploads_dir
        self.by_src = {}        # src → (name, px_w, px_h) or None
        self.refs = {}          # name → indirect object

    def resolve(self, src: str):
        if src in self.by_src:
            return self.by_src[src]
        info = None
        match = UPLOAD_RE.search(src or "")
        if match and self.dir is not None:
            path = self.dir / match.group(1)
            if path.is_file():
                built = image_xobject(path)
                if built:
                    stream, px_w, px_h = built
                    name = f"GmIm{len(self.refs)}"
                    self.refs[name] = self.writer._add_object(stream)
                    info = (name, px_w, px_h)
                else:
                    log.info(f"[pdf-notes] unsupported image format: {match.group(1)}")
        self.by_src[src] = info
        return info

    def used(self, rows):
        return {row[1]: self.refs[row[1]] for row in rows if row[0] == "image"}


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

    images = _Images(writer, uploads_dir)
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
                _draw_note(ops, (x, y, x + box_w, y + box_h), anchor, rows, FONT_SIZE, color)
                used.update(images.used(rows))
                drawn += 1

            if ops:
                _stamp(writer, page_num - 1, matrix, ops, used)
    finally:
        if doc is not None:
            doc.close()

    if not drawn:
        return pdf_bytes, 0
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue(), drawn
