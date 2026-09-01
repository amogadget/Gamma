"""The typesetting engine both PDF writers draw with: fonts, widths, layout.

``pdf_notes`` paints small note boxes onto an existing page; ``pdf_document``
typesets a whole note page as a fresh PDF. Both need the same things — decide
which built-in font can draw a character, measure it, break spans into lines,
and emit the content-stream operators — so that machinery lives here once.

A **span** is ``(kind, payload, level, style)``:

* ``kind`` is ``TEXT`` (payload = a string) or ``MATH`` (payload = the
  ``(ops, width, height, ascent)`` tuple ``vector_text`` returns for a typeset
  expression or a CJK glyph);
* ``level`` is 0, ``SUP`` or ``SUB`` — a genuinely raised/lowered run;
* ``style`` is a :class:`Style`: emphasis bits plus a link target. Notes drawn
  on a page are all one style (``PLAIN``); a document renders bold, italic,
  code, strike-through, ``==marked==`` text and links.

Everything is laid out in a **y-down frame** (x right, y down, origin at the
visible top-left) — the frame the viewer stores highlight rects in. Callers map
it back to PDF user space with one ``cm``; text is drawn with a flipped text
matrix so the glyphs still come out upright.

Only fonts every PDF viewer has built in are used, so nothing is embedded:
Helvetica in four styles (WinAnsi), Courier for code, Symbol for the Greek and
math left over when the LaTeX renderer is unavailable, and a non-embedded
STSong-Light CID font as the last resort for CJK (``vector_text`` draws
outlines instead wherever a font is installed).
"""

from collections import namedtuple

from PyPDF2.generic import (
    ArrayObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    create_string_object,
)

from . import vector_text
from .logbuf import log
from .note_markup import MATH, SUB, SUP, TEXT, latex_spans

# --- styles ------------------------------------------------------------------

BOLD, ITALIC, MONO, STRIKE, MARK, LINK = 1, 2, 4, 8, 16, 32

# ``bits`` is the mask above; ``href`` the target of a LINK span (kept in the
# style so wrapping and merging treat two different links as two different
# styles, and the drawing pass can build the /Link annotation).
Style = namedtuple("Style", "bits href")
PLAIN = Style(0, None)


def styled(style: Style, add: int = 0, drop: int = 0, href=None) -> Style:
    """``style`` with bits added/removed (and optionally a link target)."""
    return Style((style.bits | add) & ~drop, href if href is not None else style.href)


TEXT_COLOR = (0.13, 0.13, 0.15)
LINK_COLOR = (0.16, 0.35, 0.68)
MARK_COLOR = (1.0, 0.93, 0.55)
CODE_BG = (0.94, 0.94, 0.95)

SUP_SCALE = 0.72        # super/subscript size and baseline shift, × font size
SUP_RISE = 0.30
SUB_DROP = 0.16
LEADING = 1.22          # × font size, the default line height

# --- fonts -------------------------------------------------------------------

# Content-stream resource names. F1/F2/F3 keep the numbering pdf_notes has
# always written, so its output is unchanged by this module existing.
HELV, CID, SYM, HELVB, HELVI, HELVBI, COUR = "F1", "F2", "F3", "F4", "F5", "F6", "F7"

_BASE14 = {
    HELV: "/Helvetica",
    HELVB: "/Helvetica-Bold",
    HELVI: "/Helvetica-Oblique",
    HELVBI: "/Helvetica-BoldOblique",
    COUR: "/Courier",
    SYM: "/Symbol",
}

# Helvetica AFM advance widths (1/1000 em) for ASCII 32..126; anything else
# WinAnsi can encode gets the average. Only used for line breaking.
_HELV_W = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,   # ' '..'/'
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,   # '0'..'?'
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,  # '@'..'O'
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,   # 'P'..'_'
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,   # '`'..'o'
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,        # 'p'..'~'
]
_HELVB_W = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,   # ' '..'/'
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,   # '0'..'?'
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,   # '@'..'O'
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,   # 'P'..'_'
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,   # '`'..'o'
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,        # 'p'..'~'
]
_HELV_DEFAULT = 556
_HELVB_DEFAULT = 611
_COURIER_W = 600            # Courier is monospaced: every glyph the same

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
for _twin, _canon in (("Δ", "∆"), ("Ω", "Ω"),
                      ("⟨", "〈"), ("⟩", "〉"),
                      ("〈", "〈"), ("〉", "〉")):
    SYMBOL.setdefault(_twin, SYMBOL[_canon])


def font_of(ch: str, style: Style = PLAIN) -> str:
    """Which built-in font can draw this character in this style."""
    try:
        ch.encode("cp1252")
    except UnicodeEncodeError:
        return SYM if ch in SYMBOL else CID
    bits = style.bits
    if bits & MONO:
        return COUR
    if bits & BOLD:
        return HELVBI if bits & ITALIC else HELVB
    return HELVI if bits & ITALIC else HELV


def char_em(ch: str, style: Style = PLAIN) -> float:
    font = font_of(ch, style)
    if font == SYM:
        return SYMBOL[ch][1] / 1000.0
    if font == CID:
        return 1.0          # CID fonts here run at the default 1000/1000 width
    if font == COUR:
        return _COURIER_W / 1000.0
    table, default = ((_HELVB_W, _HELVB_DEFAULT) if font in (HELVB, HELVBI)
                      else (_HELV_W, _HELV_DEFAULT))
    o = ord(ch)
    return (table[o - 32] if 32 <= o <= 126 else default) / 1000.0


def size_of(size: float, level: int) -> float:
    return size * (SUP_SCALE if level else 1.0)


def span_width(text: str, size: float, level: int = 0, style: Style = PLAIN) -> float:
    return size_of(size, level) * sum(char_em(c, style) for c in text)


def token_width(kind, payload, level, size: float, style: Style = PLAIN) -> float:
    return payload[1] if kind == MATH else span_width(payload, size, level, style)


def spans_width(spans, size: float) -> float:
    return sum(token_width(k, p, lv, size, st) for k, p, lv, st in spans)


def font_resources(names) -> DictionaryObject:
    """/Font resource dictionary for the given resource names."""
    fonts = DictionaryObject()
    for name in names:
        if name in _BASE14:
            font = DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject(_BASE14[name]),
            })
            if name != SYM:      # Symbol carries its own built-in encoding
                font[NameObject("/Encoding")] = NameObject("/WinAnsiEncoding")
        else:
            # Non-embedded CID font for anything the others can't hold (CJK).
            # Adobe-GB1 with the standard UniGB-UCS2-H CMap: no font file to ship.
            descendant = DictionaryObject({
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
            font = DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type0"),
                NameObject("/BaseFont"): NameObject("/STSong-Light"),
                NameObject("/Encoding"): NameObject("/UniGB-UCS2-H"),
                NameObject("/DescendantFonts"): ArrayObject([descendant]),
            })
        fonts[NameObject("/" + name)] = font
    return fonts


# --- span helpers ------------------------------------------------------------

def plain(spans, style: Style = PLAIN):
    """note_markup's (kind, payload, level) triples → styled spans."""
    return [(k, p, lv, style) for k, p, lv in spans]


def merge(spans):
    """Collapse neighbouring text spans sharing a level and style; math stays
    whole."""
    out = []
    for kind, payload, level, style in spans:
        if (kind == TEXT and out and out[-1][0] == TEXT
                and out[-1][2] == level and out[-1][3] == style):
            out[-1] = (TEXT, out[-1][1] + payload, level, style)
        elif kind == MATH or payload:
            out.append((kind, payload, level, style))
    return out


def resolve(spans, size: float, width: float):
    """Turn every span the built-in fonts can't draw into vector paths:
    (ops, w, h, ascent). Inline math that won't fit the column falls back to
    the unicode approximation; CJK without an outline font falls back to the
    CID font, which is only legible in viewers that can substitute one."""
    out = []
    for kind, payload, level, style in spans:
        if kind == MATH:
            drawn = vector_text.math(payload, size)
            if drawn and drawn[1] <= width:
                out.append((MATH, drawn, level, style))
            else:
                if drawn:
                    log.info("[pdf-typeset] inline math too wide for the column, "
                             "falling back to text")
                out.extend(plain(latex_spans(payload), style))
            continue
        # One vector span per CJK character, so lines still break between them.
        run = ""
        for ch in payload:
            drawn = (vector_text.glyphs(ch, size_of(size, level))
                     if font_of(ch, style) == CID else None)
            if drawn is None:
                run += ch
                continue
            if run:
                out.append((TEXT, run, level, style))
                run = ""
            out.append((MATH, drawn, level, style))
        if run:
            out.append((TEXT, run, level, style))
    return merge(out)


def tokens(spans):
    """Unbreakable chunks across spans: words, single spaces, one token per CJK
    character (no spaces there, so every character breaks), and math as a
    whole."""
    out = []
    for kind, payload, level, style in spans:
        if kind == MATH:
            out.append((kind, payload, level, style))
            continue
        cur = ""
        for ch in payload:
            if ch == " " or font_of(ch, style) == CID:
                if cur:
                    out.append((TEXT, cur, level, style))
                    cur = ""
                out.append((TEXT, ch, level, style))
            else:
                cur += ch
        if cur:
            out.append((TEXT, cur, level, style))
    return out


def hang_indent(spans, size: float, width: float) -> float:
    """Continuation indent: a wrapped bullet line keeps its marker's step."""
    head = spans[0][1] if spans and spans[0][0] == TEXT else ""
    body = head.lstrip(" ")
    lead = head[: len(head) - len(body)]
    return min(span_width(lead + ("  " if body[:2] in ("- ", "* ") else ""), size),
               width * 0.4)


def line_metrics(spans, size: float, leading: float = LEADING):
    """(ascent, height) of one line: tall inline math pushes the line open."""
    asc, desc = size * 0.82, size * (leading - 0.82)
    for kind, payload, _level, _style in spans:
        if kind == MATH:
            _ops, _w, h, a = payload
            asc = max(asc, a + 0.5)
            desc = max(desc, h - a + 0.5)
    return asc, asc + desc


def wrap(spans, width: float, size: float, hang=None):
    """Spans → [(indent, spans)], one entry per rendered line."""
    if hang is None:
        hang = hang_indent(spans, size, width)
    lines, cur, cur_w, indent = [], [], 0.0, 0.0
    for kind, payload, level, style in tokens(spans):
        w = token_width(kind, payload, level, size, style)
        if cur and cur_w + w > width - indent:
            if kind == TEXT and payload == " ":
                continue                          # swallow the break's space
            lines.append((indent, merge(cur)))
            cur, cur_w, indent = [], 0.0, hang
        if not cur and kind == TEXT and payload == " ":
            continue
        while kind == TEXT and w > width - indent and len(payload) > 1:
            cut = len(payload)                    # one token too long: hard-split
            while cut > 1 and span_width(payload[:cut], size, level, style) > width - indent:
                cut -= 1
            lines.append((indent, [(TEXT, payload[:cut], level, style)]))
            payload, indent = payload[cut:], hang
            w = span_width(payload, size, level, style)
        cur.append((kind, payload, level, style))
        cur_w += w
    if cur:
        lines.append((indent, merge(cur)))
    return lines or [(0.0, [])]


# --- content stream ----------------------------------------------------------

def num(v: float) -> bytes:
    return b"%.2f" % round(v, 2)


def esc(text: str) -> bytes:
    out = bytearray(b"(")
    for ch in text:
        b = ch.encode("cp1252", "replace")
        if b in (b"(", b")", b"\\"):
            out += b"\\"
        out += b
    return bytes(out + b")")


def sym(text: str) -> bytes:
    out = bytearray(b"(")
    for ch in text:
        b = bytes([SYMBOL[ch][0]])
        if b in (b"(", b")", b"\\"):
            out += b"\\"
        out += b
    return bytes(out + b")")


def hex_(text: str) -> bytes:
    """UTF-16BE hex string for the CID font (BMP only)."""
    out = bytearray(b"<")
    for ch in text:
        o = ord(ch)
        out += b"%04X" % (o if o < 0x10000 else 0x3F)
    return bytes(out + b">")


def runs(text: str, style: Style = PLAIN):
    """[(font, chunk)] — one Tj per font stretch."""
    out = []
    for ch in text:
        font = font_of(ch, style)
        if out and out[-1][0] == font:
            out[-1][1] += ch
        else:
            out.append([font, ch])
    return [(font, chunk) for font, chunk in out]


def fill_rect(ops, x0, y0, x1, y1, color):
    ops.append(b"%s %s %s rg %s %s %s %s re f" % (
        num(color[0]), num(color[1]), num(color[2]),
        num(x0), num(y0), num(x1 - x0), num(y1 - y0)))


def draw_spans(ops, x: float, base: float, spans, size: float,
               color=TEXT_COLOR, fonts=None, links=None) -> float:
    """Draw one laid-out line in the y-down frame, its baseline at ``base``;
    returns the x it ended at. ``fonts`` collects the resource names actually
    used, ``links`` the ``(x0, y0, x1, y1, href)`` boxes of LINK spans so the
    caller can turn them into /Link annotations."""
    ascent, height = line_metrics(spans, size)
    for kind, payload, level, style in spans:
        if kind == MATH:
            math_ops, w, _h, asc = payload
            ops.append(b"q 1 0 0 1 %s %s cm" % (num(x), num(base - asc)))
            ops.append(math_ops)
            ops.append(b"Q")
            x += w
            continue
        width = span_width(payload, size, level, style)
        bits, drawn = style.bits, bool(payload.strip())
        if drawn and bits & MARK:
            fill_rect(ops, x, base - size * 0.78, x + width, base + size * 0.22, MARK_COLOR)
        elif drawn and bits & MONO:
            fill_rect(ops, x - 1, base - size * 0.78, x + width + 1, base + size * 0.22, CODE_BG)
        rgb = LINK_COLOR if bits & LINK else color
        ops.append(b"BT %s %s %s rg" % (num(rgb[0]), num(rgb[1]), num(rgb[2])))
        cursor = x
        for font, chunk in runs(payload, style):
            if fonts is not None:
                fonts.add(font)
            if chunk.strip():
                fs = size_of(size, level)
                shift = (-SUP_RISE * size if level == SUP
                         else SUB_DROP * size if level == SUB else 0)
                body = (sym(chunk) if font == SYM else
                        hex_(chunk) if font == CID else esc(chunk))
                ops.append(b"/%s %s Tf 1 0 0 -1 %s %s Tm %s Tj" % (
                    font.encode(), num(fs), num(cursor), num(base + shift), body))
            cursor += span_width(chunk, size, level, style)
        ops.append(b"ET")
        if drawn and bits & STRIKE:
            ops.append(b"%s %s %s RG %s w %s %s m %s %s l S" % (
                num(rgb[0]), num(rgb[1]), num(rgb[2]), num(max(0.4, size * 0.06)),
                num(x), num(base - size * 0.26), num(x + width), num(base - size * 0.26)))
        if drawn and bits & LINK and links is not None and style.href:
            links.append((x, base - ascent, x + width, base + height - ascent, style.href))
        x += width
    return x
