"""Math and CJK → vector PDF path operators.

Two things the note boxes can't draw with the base-14 fonts:

* **Math.** Approximating it as unicode (``note_markup.latex_spans``) is fine
  for ``\\phi_j`` and hopeless for a fraction of two sums — which is exactly
  what a derivation note looks like. ``math()`` lays it out with ziamath.
* **CJK.** The non-embedded STSong-Light CID font only renders where the viewer
  can substitute an Asian font. pdf.js — what Gamma's own viewer uses — can't,
  and paints the two-byte codes as latin gibberish. ``glyphs()`` draws the
  characters as outlines instead, so they look the same in every viewer.

Both go through the same trick: ziamath/ziafont emit SVG glyph *outlines*
(plain ``<path>`` with M/L/Q/Z, plus ``<rect>`` for fraction bars — no
``<use>``, no text), which convert straight to PDF path ops. Crisp at any zoom,
a few KB, no raster step, no imaging library, no font embedding.

SVG's y axis points down — the same direction as ``pdf_notes``' display frame —
so the ops drop straight in with only a translate/scale. The returned ops put
the run's top-left at (0, 0); ``ascent`` is where its baseline sits below that,
which is what inline placement needs to line up with the surrounding text.

Everything is best-effort: unparsable LaTeX, a missing ziamath, or no CJK font
on the box returns None and the caller falls back to what it can draw.
"""

import re
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path

from .logbuf import log

TEXT_COLOR = (0.13, 0.13, 0.15)
_NUM = re.compile(r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?")
_CMD = re.compile(r"[MmLlHhVvCcQqTtSsZz]")


def _fmt(v: float) -> bytes:
    return b"%.3f" % round(v, 3)


def _path_ops(d: str, out: list) -> bool:
    """SVG path data → PDF path construction ops. False if it uses anything we
    don't emit (arcs); glyph outlines never do."""
    tokens = [(m.group(), m.start()) for m in _CMD.finditer(d)]
    if not tokens:
        return False
    cx = cy = sx = sy = 0.0          # current point, subpath start
    qx = qy = None                   # last quadratic control point (for T)
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
                out.append(b"%s %s %s" % (_fmt(x), _fmt(y), b"m" if up == "M" and k == 0 else b"l"))
                if up == "M" and k == 0:
                    sx, sy = x, y
                cx, cy = x, y
                qx = qy = None
            elif up in ("H", "V"):
                x = (cx + a[0] if rel else a[0]) if up == "H" else cx
                y = (cy + a[0] if rel else a[0]) if up == "V" else cy
                out.append(b"%s %s l" % (_fmt(x), _fmt(y)))
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
                out.append(b"%s %s %s %s %s %s c" % (_fmt(c1x), _fmt(c1y), _fmt(c2x),
                                                     _fmt(c2y), _fmt(x), _fmt(y)))
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
                out.append(b"%s %s %s %s %s %s c" % (_fmt(c1x), _fmt(c1y), _fmt(c2x),
                                                     _fmt(c2y), _fmt(x), _fmt(y)))
                qx, qy = ctlx, ctly
                cx, cy = x, y
    return True


def _paint(el):
    """(line-width op or None, painting operator) for one SVG shape, honouring
    its fill/stroke. Glyph outlines are filled, but ``\\boxed{}`` draws a
    *stroked, unfilled* rect — painting that solid turns the whole expression
    into a black slab. The width has to be set before the path is built: no
    graphics-state ops are allowed inside a path object."""
    filled = (el.get("fill") or "black").strip().lower() != "none"
    stroke = (el.get("stroke") or "none").strip().lower() != "none"
    width = b"%s w" % _fmt(float(el.get("stroke-width") or 1)) if stroke else None
    even_odd = b"*" if (el.get("fill-rule") or "").strip() == "evenodd" else b""
    return width, (b"B" + even_odd if filled and stroke else b"f" + even_odd if filled
                   else b"S" if stroke else b"n")


def _svg_ops(svg: str):
    """Outline SVG → (path ops, width, height, ascent); None if it uses
    anything we don't emit (arcs — glyph outlines never do)."""
    root = ET.fromstring(svg)
    vx, vy, vw, vh = (float(v) for v in root.get("viewBox").split())
    ops = [b"%s %s %s rg" % tuple(_fmt(c) for c in TEXT_COLOR),
           b"%s %s %s RG" % tuple(_fmt(c) for c in TEXT_COLOR),
           b"1 0 0 1 %s %s cm" % (_fmt(-vx), _fmt(-vy))]
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        # Bail on anything that would rescale/move what follows: a <symbol>'s
        # own viewBox or a group transform. Drawing those children as-is is
        # silently wrong (glyphs come out at the wrong size), so refuse
        # instead — both libraries are configured to emit flat paths.
        if tag in ("symbol", "use") or (el.get("transform") or "").strip():
            return None
        if tag not in ("path", "rect"):
            continue
        width, paint = _paint(el)
        if width:
            ops.append(width)
        if tag == "path":
            if not _path_ops(el.get("d") or "", ops):
                return None
        else:
            ops.append(b"%s %s %s %s re" % tuple(
                _fmt(float(el.get(k) or 0)) for k in ("x", "y", "width", "height")))
        ops.append(paint)
    return b"\n".join(ops), vw, vh, -vy


@lru_cache(maxsize=256)
def math(tex: str, size: float = 8.0):
    """LaTeX → (path ops, width, height, ascent) in points, or None.

    The ops draw the expression into the rectangle (0, 0)–(width, height) of a
    y-down frame; ``ascent`` is the baseline's distance from the top.
    """
    try:
        import ziamath
    except ImportError:
        return None
    try:
        ziamath.config.svg2 = False          # plain <path>, no <use>/<symbol>
        return _svg_ops(ziamath.Math.fromlatex(tex, size=size).svg())
    except Exception as e:
        log.info(f"[pdf-notes] math render failed ({type(e).__name__}) for: {tex[:60]}")
        return None


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
    """Non-latin text → (path ops, width, height, ascent), or None when no CJK
    font is installed. Called per character, so lines still break between
    them."""
    font = cjk_font()
    if font is None:
        return None
    try:
        import ziafont
        # Without this the glyph goes in a <symbol> whose own viewBox rescales
        # it — drawing its <path> directly would come out ~1.5x too big.
        ziafont.config.svg2 = False
        return _svg_ops(font.text(text, size=size).svg())
    except Exception as e:
        log.info(f"[pdf-notes] glyph render failed ({type(e).__name__}) for: {text[:20]}")
        return None
