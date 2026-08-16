"""Note markdown/LaTeX → drawable spans, and uploads → PDF image XObjects."""

import io
import zlib

from gamma.note_markup import MATH, SUB, SUP, SYMBOLS, TEXT, latex_spans, parse_note
from gamma.pdf_image import image_xobject
from gamma.pdf_notes import CID, _font_of


def flat(spans):
    """Spans → the text they draw; inline math shows as ⟪tex⟫."""
    return "".join(f"⟪{p}⟫" if k == MATH else p for k, p, _ in spans)


def levels(spans, level):
    return [p for k, p, lv in spans if k == TEXT and lv == level]


def test_every_symbol_is_drawable():
    """A LaTeX command that maps to a character none of the three PDF fonts
    carry would print as a blank box — the mapping must stay in sync with
    pdf_notes.SYMBOL."""
    undrawable = {name: ch for name, ch in SYMBOLS.items()
                  if any(_font_of(c) == CID for c in ch)}
    assert undrawable == {}


def test_latex_becomes_symbols_and_scripts():
    spans = latex_spans(r"F_1=\frac{1}{2}+\sum_{i=1}^N \sin\left( nx \right)^2")
    assert flat(spans) == "F1=1/2+∑i=1N sin( nx )2"
    # The parts that must not be drawn on the baseline.
    assert levels(spans, SUP) == ["N", "2"]
    assert levels(spans, SUB) == ["1", "i=1"]

    assert flat(latex_spans(r"\ket{\phi_j}")) == "|φj〉"
    assert flat(latex_spans(r"\nabla g \geq \alpha \cdot \beta")) == "∇ g ≥ α ⋅ β"
    assert flat(latex_spans(r"\sqrt{2}\times\mathbf{A}")) == "√2×A"
    # An unknown command keeps its name — that is what \sin, \log, \max need.
    assert flat(latex_spans(r"\argmax_x")) == "argmaxx"


def test_parse_note_splits_math_images_and_markdown():
    items = parse_note(
        "**bold** and `code` and a [link](https://x.dev) with $\\alpha$\n"
        "![shot](/api/uploads/ab12cd.png)\n"
        "$$E = mc^2$$"
    )
    kinds = [i["kind"] for i in items]
    assert kinds == ["text", "image", "math"]
    # Inline math stays in the line (typeset in place); display math is its own
    # item so pdf_notes can centre it.
    assert flat(items[0]["spans"]) == r"bold and code and a link with ⟪\alpha⟫"
    assert items[1]["src"] == "/api/uploads/ab12cd.png"
    assert items[1]["alt"] == "shot"
    assert items[2]["tex"] == "E = mc^2"


def test_parse_note_keeps_plain_text_intact():
    items = parse_note("top comment\n- nested note\n  - deeper")
    assert [flat(i["spans"]) for i in items] == ["top comment", "- nested note", "  - deeper"]


def _png(width, height, ctype, depth=8, filt=0):
    chans = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    stride = width * chans * depth // 8
    raw = b"".join(bytes([filt]) + bytes(range(1, stride + 1)) for _ in range(height))

    def chunk(tag, data):
        body = tag + data
        import struct
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    import struct
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, depth, ctype, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def test_png_rgb_is_embedded_verbatim(tmp_path):
    """8-bit RGB needs no decoding: PDF's /Predictor 15 is PNG row filtering."""
    path = tmp_path / "a.png"
    path.write_bytes(_png(4, 3, ctype=2))
    stream, w, h = image_xobject(path)
    assert (w, h) == (4, 3)
    assert str(stream["/Filter"]) == "/FlateDecode"
    assert int(stream["/DecodeParms"]["/Predictor"]) == 15
    assert str(stream["/ColorSpace"]) == "/DeviceRGB"


def test_png_with_alpha_is_decoded_onto_white(tmp_path):
    path = tmp_path / "a.png"
    path.write_bytes(_png(2, 2, ctype=6))
    stream, w, h = image_xobject(path)
    assert (w, h) == (2, 2)
    assert "/DecodeParms" not in stream       # unfiltered here, not by the viewer
    assert len(zlib.decompress(stream.get_data())) == 2 * 2 * 3

    from gamma.pdf_image import MAX_PIXELS
    assert MAX_PIXELS > 1_000_000            # a pasted screenshot must fit


def test_unsupported_image_is_skipped(tmp_path):
    path = tmp_path / "a.gif"
    path.write_bytes(b"GIF89a nope")
    assert image_xobject(path) is None


def _palette_png(width, height, palette):
    import struct

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(bytes([0]) + bytes(range(width)) for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0))
            + chunk(b"PLTE", palette)
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def test_palette_survives_as_raw_bytes(tmp_path):
    """The /Indexed lookup table must be a byte string. As a *text* string
    PyPDF2 re-encodes it (UTF-16 as soon as a byte isn't PDFDocEncodable),
    which scrambles the palette and paints the picture one flat colour."""
    from PyPDF2.generic import ByteStringObject

    palette = bytes([255, 0, 0, 0, 200, 0, 32, 64, 255, 250, 250, 180])
    path = tmp_path / "p.png"
    path.write_bytes(_palette_png(4, 2, palette))
    stream, w, h = image_xobject(path)
    space = stream["/ColorSpace"]
    assert str(space[0]) == "/Indexed" and int(space[2]) == 3
    assert isinstance(space[3], ByteStringObject)
    assert bytes(space[3]) == palette


def test_vector_text_refuses_rescaled_svg():
    """A <symbol>/<use> or a group transform rescales what follows; drawing
    those children as-is is silently wrong (ziafont's default output makes
    glyphs ~1.5x too big), so the converter must refuse them."""
    from gamma.vector_text import _svg_ops

    flat = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -8 10 10">'
            '<path d="M 0 0 L 5 0 L 5 -5 Z"/></svg>')
    assert _svg_ops(flat) is not None
    for bad in ('<symbol id="g" viewBox="0 -20 20 20"><path d="M 0 0 L 5 0 Z"/></symbol>',
                '<g transform="scale(2)"><path d="M 0 0 L 5 0 Z"/></g>'):
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -8 10 10">{bad}</svg>'
        assert _svg_ops(svg) is None
