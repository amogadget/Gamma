"""Math and CJK → glyph placements plus leftover vector shapes.

Two things the note boxes can't draw with the base-14 fonts:

* **Math.** Approximating it as unicode (``note_markup.latex_spans``) is fine
  for ``\\phi_j`` and hopeless for a fraction of two sums — which is exactly
  what a derivation note looks like. ``math()`` lays it out with ziamath.
* **CJK.** The non-embedded STSong-Light CID font only renders where the viewer
  can substitute an Asian font. pdf.js — what Gamma's own viewer uses — can't,
  and paints the two-byte codes as latin gibberish. ``glyphs()`` uses the
  outlines of an installed font instead, so they look the same in every viewer.

Both produce a :class:`Drawing`: the *glyph placements* (which glyph, standing
for which character, where, at what size) and, separately, content-stream path
ops for everything that is not a glyph — fraction bars, radical vincula,
``\\boxed{}`` frames. ``pdf_glyphs`` turns the placements into Type 3 fonts
whose glyph programs are those same outlines, so the equation is drawn with
real text operators: crisp at any zoom, selectable, searchable, each outline
stored once per document, still no font file to ship and no raster step.

ziamath is only ever asked for its layout tree, never for SVG: walking the
tree gives every glyph's identity and baseline position, which a flattened
``<path>`` no longer has. The non-glyph leaves (bars, boxes, strikes) draw
themselves into a scratch SVG element exactly as ziamath would, and that is
converted to path ops. SVG's y axis points down — the same direction as
``pdf_notes``' display frame — so positions drop straight in with only a
translate. The drawing's top-left is (0, 0); ``ascent`` is where its baseline
sits below that, which is what inline placement needs to line up with the
surrounding text.

Everything is best-effort: unparsable LaTeX, a missing ziamath, or no CJK font
on the box returns None and the caller falls back to what it can draw.
"""

import re
import xml.etree.ElementTree as ET
from collections import namedtuple
from functools import lru_cache
from itertools import accumulate
from pathlib import Path

from .logbuf import log

TEXT_COLOR = (0.13, 0.13, 0.15)
MAX_ASSEMBLY_PARTS = 40   # a stretched delimiter built from more pieces is broken
_NUM = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
_CMD = re.compile(r"[MmLlHhVvCcQqTtSsZz]")

# ``shapes``: path ops for everything that is not a glyph (b"" when there is
# nothing but glyphs); ``glyphs``: the glyph placements. Both are in the
# layout's own y-down frame, whose point (``vx``, ``vy``) is the drawing's
# top-left — the emitter translates by (-vx, -vy) so the drawing fills
# (0, 0)–(width, height).
Drawing = namedtuple("Drawing", "shapes glyphs vx vy")
# One glyph on the page: a ziafont glyph (its outline, advance and bbox in font
# units), the text it stands for when copied ("" = whatever the font's cmap
# says), its origin on the baseline, and its point size.
Placed = namedtuple("Placed", "glyph char x y size")


def _fmt(v: float) -> bytes:
    """Up to 3 decimals, trailing zeros dropped: glyph programs are mostly
    integer font units, and every ``.000`` is repeated thousands of times."""
    s = b"%.3f" % round(v, 3)
    s = s.rstrip(b"0").rstrip(b".") if b"." in s else s
    return b"0" if s == b"-0" else s


def path_ops(d: str, out: list, ymul: float = 1.0) -> bool:
    """SVG path data → PDF path construction ops appended to ``out``. False if
    it uses anything we don't emit (arcs); glyph outlines never do. ``ymul``
    flips the y axis (-1) for glyph programs, which live in y-up font space."""
    tokens = [(m.group(), m.start()) for m in _CMD.finditer(d)]
    if not tokens:
        return False
    cx = cy = sx = sy = 0.0          # current point, subpath start
    qx = qy = None                   # last quadratic control point (for T)

    def emit(*coords):
        return b" ".join(_fmt(v if i % 2 == 0 else v * ymul) for i, v in enumerate(coords))

    for i, (cmd, start) in enumerate(tokens):
        end = tokens[i + 1][1] if i + 1 < len(tokens) else len(d)
        args = [float(m.group()) for m in _NUM.finditer(d[start + 1:end])]
        rel = cmd.islower()
        up = cmd.upper()
        if up == "Z":
            out.append(b"h")
            cx, cy = sx, sy
            continue
        step = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2}.get(up)
        if not step or len(args) < step:
            return False
        for k in range(0, len(args) - step + 1, step):
            a = args[k:k + step]
            if up in ("M", "L"):
                x, y = (cx + a[0], cy + a[1]) if rel else (a[0], a[1])
                out.append(b"%s %s" % (emit(x, y), b"m" if up == "M" and k == 0 else b"l"))
                if up == "M" and k == 0:
                    sx, sy = x, y
                cx, cy = x, y
                qx = qy = None
            elif up in ("H", "V"):
                x = (cx + a[0] if rel else a[0]) if up == "H" else cx
                y = (cy + a[0] if rel else a[0]) if up == "V" else cy
                out.append(b"%s l" % emit(x, y))
                cx, cy = x, y
                qx = qy = None
            elif up in ("C", "S"):
                if up == "C":
                    p = [(cx + v if j % 2 == 0 else cy + v) if rel else v for j, v in enumerate(a)]
                    c1x, c1y, c2x, c2y, x, y = p
                else:
                    c1x, c1y = cx, cy       # no previous cubic control tracked
                    c2x, c2y, x, y = [(cx + v if j % 2 == 0 else cy + v) if rel else v
                                      for j, v in enumerate(a)]
                out.append(b"%s c" % emit(c1x, c1y, c2x, c2y, x, y))
                cx, cy = x, y
                qx = qy = None
            else:                            # Q / T — quadratic → cubic
                if up == "Q":
                    p = [(cx + v if j % 2 == 0 else cy + v) if rel else v for j, v in enumerate(a)]
                    ctlx, ctly, x, y = p
                else:
                    ctlx = 2 * cx - qx if qx is not None else cx
                    ctly = 2 * cy - qy if qy is not None else cy
                    x, y = (cx + a[0], cy + a[1]) if rel else (a[0], a[1])
                c1x, c1y = cx + 2 / 3 * (ctlx - cx), cy + 2 / 3 * (ctly - cy)
                c2x, c2y = x + 2 / 3 * (ctlx - x), y + 2 / 3 * (ctly - y)
                out.append(b"%s c" % emit(c1x, c1y, c2x, c2y, x, y))
                qx, qy = ctlx, ctly
                cx, cy = x, y
    return True


def _paint(el):
    """(line-width op or None, painting operator) for one SVG shape, honouring
    its fill/stroke. Bars are filled, but ``\\boxed{}`` draws a *stroked,
    unfilled* rect — painting that solid turns the whole expression into a
    black slab. The width has to be set before the path is built: no
    graphics-state ops are allowed inside a path object."""
    filled = (el.get("fill") or "black").strip().lower() != "none"
    stroke = (el.get("stroke") or "none").strip().lower() != "none"
    width = b"%s w" % _fmt(float(el.get("stroke-width") or 1)) if stroke else None
    even_odd = b"*" if (el.get("fill-rule") or "").strip() == "evenodd" else b""
    return width, (b"B" + even_odd if filled and stroke else b"f" + even_odd if filled
                   else b"S" if stroke else b"n")


def header(drawing: Drawing) -> bytes:
    """Colour + the translate that puts the drawing's top-left at (0, 0)."""
    return b"\n".join([b"%s %s %s rg" % tuple(_fmt(c) for c in TEXT_COLOR),
                       b"%s %s %s RG" % tuple(_fmt(c) for c in TEXT_COLOR),
                       b"1 0 0 1 %s %s cm" % (_fmt(-drawing.vx), _fmt(-drawing.vy))])


def _shape_ops(svg):
    """The non-glyph shapes of a scratch SVG element → path ops (b"" if there
    are none); None if one uses anything we don't emit (an ellipse, a group
    transform — drawing those children as-is is silently wrong, so refuse
    instead)."""
    ops = []
    for el in svg.iter():
        if el is svg:
            continue
        tag = el.tag.rsplit("}", 1)[-1]
        if (el.get("transform") or "").strip():
            return None
        if tag == "path":
            width, paint = _paint(el)
            if width:
                ops.append(width)
            if not path_ops(el.get("d") or "", ops):
                return None
            ops.append(paint)
        elif tag == "rect":
            width, paint = _paint(el)
            if width:
                ops.append(width)
            ops.append(b"%s %s %s %s re" % tuple(
                _fmt(float(el.get(k) or 0)) for k in ("x", "y", "width", "height")))
            ops.append(paint)
        elif tag not in ("title", "g"):
            return None
    return b"\n".join(ops)


# --- math --------------------------------------------------------------------

def _pieces(node, x: float, y: float):
    """The glyphs one ziamath Glyph node puts on the page: itself, or — for a
    delimiter stretched from the font's MATH assembly table — its parts, each
    at its own offset (ziamath keeps them as a compound with a synthetic id;
    the parts are real glyphs the Type 3 font can hold)."""
    glyph, size = node.glyph, node.size
    parts = getattr(glyph, "glyphs", None)
    if not parts:
        return [Placed(glyph, node.char or "", x, y, size)]
    if len(parts) > MAX_ASSEMBLY_PARTS:
        # ziamath 0.13 sizes ``\left(`` around a \sum/\int by a runaway
        # assembly — hundreds of extender pieces, a parenthesis 2000 pt tall.
        # A real delimiter never needs this many; refuse so the caller falls
        # back to the unicode approximation instead of a page-tall bracket.
        raise ValueError(f"runaway delimiter assembly ({len(parts)} parts)")
    scale = size / glyph.font.info.layout.unitsperem
    out = []
    for i, (part, ofst) in enumerate(zip(parts, glyph.offsets)):
        char = (node.char or "") if i == 0 else ""
        if getattr(glyph, "vert", True):
            out.append(Placed(part, char, x, y - ofst * scale, size))
        else:
            out.append(Placed(part, char, x + ofst * scale, y, size))
    return out


def _walk(node, x: float, y: float, svg, placed: list):
    """ziamath's draw() traversal, minus the glyph paths: glyph nodes are
    recorded, the other leaves (bars, boxes, strikes) draw into ``svg``."""
    from ziamath.drawable import Glyph

    if isinstance(node, Glyph):
        if not node.phantom:
            placed.extend(_pieces(node, x, y))
        return
    xy = getattr(node, "nodexy", None)
    if xy is None:                       # a leaf shape
        node.draw(x, y, svg)
        return
    for (dx, dy), child in zip(xy, node.nodes):
        _walk(child, x + dx, y + dy, svg, placed)


@lru_cache(maxsize=256)
def math(tex: str, size: float = 8.0):
    """LaTeX → (Drawing, width, height, ascent) in points, or None.

    The drawing fills the rectangle (0, 0)–(width, height) of a y-down frame;
    ``ascent`` is the baseline's distance from the top.
    """
    try:
        import ziamath
    except ImportError:
        return None
    try:
        m = ziamath.Math.fromlatex(tex, size=size)
        bbox, margin = m.node.bbox, m.margin
        vx, vy = bbox.xmin - margin, -bbox.ymax - margin
        vw, vh = bbox.xmax - bbox.xmin + 2 * margin, bbox.ymax - bbox.ymin + 2 * margin
        svg, placed = ET.Element("svg"), []
        _walk(m.node, 0.0, 0.0, svg, placed)
        shapes = _shape_ops(svg)
        if shapes is None:
            return None
        return Drawing(shapes, tuple(placed), vx, vy), vw, vh, -vy
    except Exception as e:
        log.info(f"[pdf-notes] math render failed ({type(e).__name__}) for: {tex[:60]}")
        return None


# --- CJK ---------------------------------------------------------------------

# Plain .ttf only — ziafont can't open a .ttc collection, which rules out most
# system CJK fonts (msyh.ttc, simsun.ttc, NotoSansCJK.ttc). The Docker image
# installs fonts-droid-fallback for the first entry.
_CJK_FONTS = (
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/droid/DroidSansFallback.ttf",
    "/usr/share/fonts/truetype/arphic/uming.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttf",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/Deng.ttf",
    "C:/Windows/Fonts/simsunb.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
)


@lru_cache(maxsize=1)
def cjk_font():
    """The first usable CJK outline font on this box, or None."""
    try:
        import ziafont
    except ImportError:
        return None
    for path in _CJK_FONTS:
        if not Path(path).is_file():
            continue
        try:
            return ziafont.Font(path)
        except Exception:
            continue
    log.info("[pdf-notes] no CJK outline font installed; falling back to the "
             "non-embedded CID font (only legible where the viewer can "
             "substitute an Asian font)")
    return None


@lru_cache(maxsize=2048)
def glyphs(text: str, size: float = 8.0):
    """Non-latin text → (Drawing, width, height, ascent), or None when no CJK
    font is installed. Called per character, so lines still break between
    them."""
    font = cjk_font()
    if font is None:
        return None
    try:
        # ziafont's own shaping (GSUB/GPOS) and metrics; only the placement is
        # read off it, never its SVG.
        run = font.text(text, size=size)
        width, height = run.getsize()
        descent = -run.getyofst()
        gids = [font.glyphindex(c) for c in text]
        if font.gsub:
            gids = font.gsub.sub(gids, font.features)
        found = [font.glyph_fromid(g) for g in gids]
        if font.gpos:
            xy = font.gpos.position(found, font.features)
        else:
            xs = list(accumulate([g.advance() for g in found], initial=0))
            xy = [(x, 0) for x in xs[:-1]]
        scale = size / font.info.layout.unitsperem
        xmin = min(0.0, found[0].bbox.xmin * scale) if found else 0.0
        vy = descent - height                       # = -ascent
        placed = tuple(Placed(g, c, px * scale, -py * scale, size)
                       for g, c, (px, py) in zip(found, text, xy))
        return Drawing(b"", placed, xmin, vy), width, height, -vy
    except Exception as e:
        log.info(f"[pdf-notes] glyph render failed ({type(e).__name__}) for: {text[:20]}")
        return None
