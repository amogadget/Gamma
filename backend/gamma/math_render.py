"""LaTeX math → vector PDF path operators.

Approximating math as unicode text (``note_markup.latex_spans``) is fine for
``\\phi_j`` and hopeless for a fraction of two sums — which is exactly what
notes on a derivation look like. ziamath lays the expression out with a real
math font and emits SVG glyph *outlines* (plain ``<path>`` with M/L/Q/Z plus
``<rect>`` for fraction bars, no ``<use>``, no text), so the whole thing
converts to PDF path ops: crisp at any zoom, a few KB, no raster step and no
imaging library.

SVG's y axis points down — the same direction as ``pdf_notes``' display frame —
so the ops drop straight in with only a translate/scale. The returned ops put
the expression's top-left at (0, 0); ``ascent`` says where its baseline sits
below that, which is what inline math needs to line up with the text.

Everything is best-effort: unparsable LaTeX (or a missing ziamath) returns None
and the caller falls back to the unicode approximation.
"""

import re
import xml.etree.ElementTree as ET
from functools import lru_cache

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


@lru_cache(maxsize=256)
def render(tex: str, size: float = 8.0):
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
        svg = ziamath.Math.fromlatex(tex, size=size).svg()
        root = ET.fromstring(svg)
        vx, vy, vw, vh = (float(v) for v in root.get("viewBox").split())
        ops = [b"%s %s %s rg" % tuple(_fmt(c) for c in TEXT_COLOR),
               b"1 0 0 1 %s %s cm" % (_fmt(-vx), _fmt(-vy))]
        for el in root.iter():
            tag = el.tag.rsplit("}", 1)[-1]
            if tag == "path":
                if not _path_ops(el.get("d") or "", ops):
                    return None
                ops.append(b"f")
            elif tag == "rect":
                ops.append(b"%s %s %s %s re f" % tuple(
                    _fmt(float(el.get(k) or 0)) for k in ("x", "y", "width", "height")))
        return b"\n".join(ops), vw, vh, -vy
    except Exception as e:
        log.info(f"[pdf-notes] math render failed ({type(e).__name__}) for: {tex[:60]}")
        return None


def available() -> bool:
    try:
        import ziamath  # noqa: F401
        return True
    except ImportError:
        return False
