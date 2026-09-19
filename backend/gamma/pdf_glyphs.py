"""Glyph outlines → Type 3 fonts, so typeset math and CJK are real text.

``vector_text`` hands back a :class:`~gamma.vector_text.Drawing`: glyph
placements plus the odd bar or frame. Drawing the placements as filled paths
(what the exports did at first) looks right but leaves the equation mute — not
selectable, not searchable, invisible to copy — and repeats every outline at
every occurrence. A **Type 3 font** is a font whose glyph programs are PDF
path operators, which is exactly what those outlines are: each distinct glyph
becomes one CharProc, stored once per document, and the page draws the
expression with ordinary ``Tf``/``TJ`` text operators. A ``/ToUnicode`` CMap
maps every code back to the character it stands for, so selection and search
work the same as for the Helvetica prose. Glyph space is the source font's
own unit grid (``FontMatrix`` = 1/unitsPerEm), so one glyph program serves
every size the layout uses it at. No font file is embedded and nothing is
rasterised — the same zero-dependency deal as the paths, plus text semantics
and a smaller file.

One :class:`GlyphFonts` per document. ``draw()`` emits the text ops for a
drawing, allocating codes as it meets new glyphs; a font takes at most 255
codes (Type 3 is single-byte), so a second resource opens when one fills.
The font dictionaries are allocated as indirect objects up front so pages —
including overlay pages merged onto an existing paper mid-way — can reference
them before every glyph is known, and ``finalize()`` fills them in once the
drawing is done, before the writer serialises.
"""

from PyPDF2.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
)

from .vector_text import header, path_ops

MAX_CODES = 255          # codes 1..255; 0 is left unused
RESOURCE_PREFIX = "GmT3"   # resource names GmT30, GmT31, … (F1–F7 are the base-14)


def _num(v: float) -> bytes:
    return b"%.2f" % round(v, 2)


def _hex(codes) -> bytes:
    return b"<" + b"".join(b"%02X" % c for c in codes) + b">"


def _utf16(text: str) -> bytes:
    return b"".join(b"%02X" % b for b in text.encode("utf-16-be"))


class _Font:
    """One Type 3 font resource: the glyphs it holds (in code order) and the
    dictionary the pages already point at."""

    def __init__(self, writer, name: str, source):
        self.name = name
        self.source = source                    # the ziafont Font the outlines come from
        self.upem = source.info.layout.unitsperem
        self.entries = []                       # (glyph, text) — code = index + 1
        self.dict = DictionaryObject()
        self.ref = writer._add_object(self.dict)

    @property
    def full(self) -> bool:
        return len(self.entries) >= MAX_CODES

    def add(self, glyph, text: str) -> int:
        self.entries.append((glyph, text))
        return len(self.entries)

    def _charproc(self, glyph) -> bytes:
        """The glyph program: ``d1`` (shape-only, takes the fill colour in
        force where it is shown) then the outline in y-up font units."""
        adv = glyph.advance()
        bb = glyph.bbox
        ops = [b"%d 0 %d %d %d %d d1" % (adv, bb.xmin, bb.ymin, bb.xmax, bb.ymax)]
        # ziafont renders at 12 pt by default; scale that back to font units.
        el = glyph.svgpath(0, 0, scale_factor=self.upem / glyph.DFLT_SIZE_PT)
        if el is not None:
            paths = [el] if el.tag == "path" else list(el.iter("path"))
            for path in paths:
                if path_ops(path.get("d") or "", ops, ymul=-1.0):
                    ops.append(b"f")
        return b"\n".join(ops)

    def _tounicode(self) -> bytes:
        pairs = [(code, text) for code, (_g, text) in enumerate(self.entries, 1) if text]
        body = [b"/CIDInit /ProcSet findresource begin", b"12 dict begin", b"begincmap",
                b"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
                b"/CMapName /Adobe-Identity-UCS def", b"/CMapType 2 def",
                b"1 begincodespacerange", b"<00> <FF>", b"endcodespacerange"]
        for i in range(0, len(pairs), 100):          # 100 entries per block, per spec
            chunk = pairs[i:i + 100]
            body.append(b"%d beginbfchar" % len(chunk))
            body.extend(b"<%02X> <%s>" % (code, _utf16(text)) for code, text in chunk)
            body.append(b"endbfchar")
        body += [b"endcmap", b"CMapName currentdict /CMap defineresource pop", b"end", b"end"]
        return b"\n".join(body)

    def build(self, writer):
        """Fill the font dictionary in — every glyph is known by now."""
        procs, names, widths = DictionaryObject(), [], []
        bbox = [0, 0, 0, 0]
        for code, (glyph, _text) in enumerate(self.entries, 1):
            name = f"/g{code}"
            stream = DecodedStreamObject()
            stream.set_data(self._charproc(glyph))
            procs[NameObject(name)] = writer._add_object(stream.flate_encode())
            names.append(NameObject(name))
            widths.append(NumberObject(glyph.advance()))
            bb = glyph.bbox
            bbox = [min(bbox[0], bb.xmin), min(bbox[1], bb.ymin),
                    max(bbox[2], bb.xmax), max(bbox[3], bb.ymax)]
        tounicode = DecodedStreamObject()
        tounicode.set_data(self._tounicode())
        unit = FloatObject(str(round(1.0 / self.upem, 8)))
        self.dict.update({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type3"),
            NameObject("/FontBBox"): ArrayObject(NumberObject(int(v)) for v in bbox),
            NameObject("/FontMatrix"): ArrayObject([unit, FloatObject("0"), FloatObject("0"),
                                                    unit, FloatObject("0"), FloatObject("0")]),
            NameObject("/CharProcs"): procs,
            NameObject("/Encoding"): DictionaryObject({
                NameObject("/Type"): NameObject("/Encoding"),
                NameObject("/Differences"): ArrayObject([NumberObject(1)] + names),
            }),
            NameObject("/FirstChar"): NumberObject(1),
            NameObject("/LastChar"): NumberObject(len(self.entries)),
            NameObject("/Widths"): ArrayObject(widths),
            NameObject("/Resources"): DictionaryObject(),
            NameObject("/ToUnicode"): writer._add_object(tounicode.flate_encode()),
        })


class GlyphFonts:
    """The Type 3 fonts of one document, and the text ops that use them."""

    def __init__(self, writer):
        self.writer = writer
        self.fonts = []             # every _Font, in resource-name order
        self._open = {}             # source font id → the _Font still taking codes
        self._codes = {}            # (glyph id, text) → (_Font, code)

    # -- registry --
    def _lookup(self, glyph, text: str):
        key = (glyph.id, text)
        hit = self._codes.get(key)
        if hit:
            return hit
        source = glyph.font
        font = self._open.get(id(source))
        if font is None or font.full:
            font = _Font(self.writer, f"{RESOURCE_PREFIX}{len(self.fonts)}", source)
            self.fonts.append(font)
            self._open[id(source)] = font
        hit = (font, font.add(glyph, text))
        self._codes[key] = hit
        return hit

    @staticmethod
    def _text(placed) -> str:
        """What the glyph stands for in the ToUnicode map: what the layout said
        it drew, else whatever the font's cmap has for the glyph."""
        if placed.char:
            return placed.char
        chars = placed.glyph.char
        return min(chars) if chars else ""

    # -- drawing --
    def draw(self, drawing) -> bytes:
        """Content-stream ops for a drawing: its shapes, then the glyphs as
        text runs. Consecutive glyphs on one baseline in one font and size
        become a single ``TJ`` whose adjustments carry the exact layout
        positions (kerning, spacing), so extractors see a natural string."""
        ops = [header(drawing)]
        if drawing.shapes:
            ops.append(drawing.shapes)
        runs = []                    # [font, size, y, [(code, x, advance)]]
        for placed in drawing.glyphs:
            font, code = self._lookup(placed.glyph, self._text(placed))
            adv = placed.glyph.advance() * placed.size / font.upem
            run = runs[-1] if runs else None
            if (run and run[0] is font and run[1] == placed.size
                    and abs(run[2] - placed.y) < 0.01):
                run[3].append((code, placed.x, adv))
            else:
                runs.append([font, placed.size, placed.y, [(code, placed.x, adv)]])
        if not runs:
            return b"\n".join(ops)
        ops.append(b"BT")
        current = None
        for font, size, y, items in runs:
            if current != (font.name, size):
                ops.append(b"/%s %s Tf" % (font.name.encode(), _num(size)))
                current = (font.name, size)
            parts, expected = [], None
            for code, x, adv in items:
                if expected is not None:
                    adj = (expected - x) * 1000.0 / size
                    if abs(adj) >= 0.05:
                        parts.append(b"%.1f" % adj)
                parts.append(_hex([code]))
                expected = x + adv
            ops.append(b"1 0 0 -1 %s %s Tm [%s] TJ" % (
                _num(items[0][1]), _num(y), b" ".join(parts)))
        ops.append(b"ET")
        return b"\n".join(ops)

    # -- resources --
    def resources(self) -> dict:
        """Resource name → font dictionary (indirect), for a page's /Font."""
        return {font.name: font.ref for font in self.fonts}

    def finalize(self):
        """Write the glyph programs, widths and ToUnicode maps. Call once, after
        the last draw and before the writer serialises."""
        for font in self.fonts:
            if not font.dict:
                font.build(self.writer)
