"""Handwriting: the ``gamma-ink`` stroke file and the pure geometry every
consumer shares (docs/dev/handwriting.md).

An ink group is a block whose ``properties.ink_url`` names one of these
files (``uploads/<sha>.ink``, plain JSON). The file is the only source of
truth for the strokes; nothing derived is stored. Coordinates are the page
as displayed at scale 1 (pdf.js viewport: points, origin top-left, y down,
rotation applied) — the same frame highlight rects normalise to, so the PDF
writers map ink through the exact conversion they already use for rects.

    {"format": "gamma-ink", "version": 1,
     "space": {"kind": "pdf-page", "page": 3, "width": 612, "height": 792},
     "strokes": [{"id": "k7Qm2x", "tool": "pen", "color": "#1f1f1f",
                  "size": 1.6, "opacity": 1, "pen": true, "t0": 1757760000000,
                  "ch": "xypt", "pts": [12040, 30512, 620, 0, 18, -3, 700, 8]}]}

``ch`` declares the channels of every sample (InkML's idea): ``x`` ``y``
always, then any of ``p`` pressure, ``t`` time, ``a`` altitude, ``z``
azimuth. ``pts`` is one flat integer array — x/y in 1/100 pt and t in ms
are delta-encoded after the first sample, p is 0..1000, a/z degrees. The
frontend's ``src/ink/ink.js`` is the mirror of the codec here; keep them in
step.
"""

import json
import math
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

FORMAT = "gamma-ink"
VERSION = 1
MAX_STROKES = 5000
MAX_SAMPLES = 500_000
MAX_BYTES = 4 * 1024 * 1024
COORD_UNIT = 100        # stored x/y are hundredths of a point
PRESSURE_UNIT = 1000    # stored p is 0..1000
THINNING = 0.5          # width = size * (1 + THINNING * (p - 0.5)); mirrors ink.js
_CH_RE = re.compile(r"^xy(?!.*(.).*\1)[ptaz]*$")
_COLOR_RE = re.compile(r"^(#[0-9a-fA-F]{6}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[0-9.]+\s*)?\))$")


class Space(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    kind: Literal["pdf-page", "canvas"] = "pdf-page"
    page: int | None = Field(default=None, ge=1)
    width: float = Field(gt=0, le=100_000)
    height: float = Field(gt=0, le=100_000)

    @model_validator(mode="after")
    def _page_for_pdf(self):
        if self.kind == "pdf-page" and self.page is None:
            raise ValueError("a pdf-page space needs a page number")
        return self


class Stroke(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    id: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    tool: Literal["pen", "highlighter"] = "pen"
    color: str = Field(default="#1f1f1f", max_length=40)
    size: float = Field(default=1.6, gt=0, le=100)
    opacity: float = Field(default=1.0, gt=0, le=1)
    pen: bool = True
    t0: int | None = Field(default=None, ge=0)
    ch: str = Field(default="xy", max_length=6)
    pts: list[int] = Field(default_factory=list)

    @model_validator(mode="after")
    def _shape(self):
        if not _CH_RE.match(self.ch):
            raise ValueError(f"bad channel list {self.ch!r}")
        if not _COLOR_RE.match(self.color):
            raise ValueError(f"bad color {self.color!r}")
        n = len(self.ch)
        if not self.pts or len(self.pts) % n:
            raise ValueError("pts length must be a positive multiple of the channel count")
        return self

    @property
    def samples(self) -> int:
        return len(self.pts) // len(self.ch)


class InkFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["gamma-ink"]
    version: Literal[1]
    space: Space
    strokes: list[Stroke] = Field(default_factory=list, max_length=MAX_STROKES)

    @model_validator(mode="after")
    def _budget(self):
        if sum(s.samples for s in self.strokes) > MAX_SAMPLES:
            raise ValueError(f"more than {MAX_SAMPLES} samples")
        if len({s.id for s in self.strokes}) != len(self.strokes):
            raise ValueError("duplicate stroke ids")
        return self


class InkError(ValueError):
    pass


def parse_ink(data: bytes | str | dict) -> InkFile:
    """Validate bytes/JSON into an InkFile; InkError on anything off."""
    try:
        if isinstance(data, (bytes, bytearray)):
            if len(data) > MAX_BYTES:
                raise InkError(f"ink file over {MAX_BYTES // (1024 * 1024)} MB")
            data = json.loads(data.decode("utf-8"))
        elif isinstance(data, str):
            data = json.loads(data)
        return InkFile.model_validate(data)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as e:
        raise InkError(str(e)) from e


def read_upload(uploads_dir, url: str) -> InkFile | None:
    """The parsed file a block's ``ink_url`` (``/api/uploads/<sha>.ink``)
    names, or None when the reference, the file or its contents are off;
    the exporters skip such a group."""
    from .markdown_export import UPLOAD_RE
    m = UPLOAD_RE.search(url or "")
    path = uploads_dir / m.group(1) if (m and uploads_dir) else None
    if not path or not path.is_file():
        return None
    try:
        return parse_ink(path.read_bytes())
    except (InkError, OSError):
        return None


# --- codec -------------------------------------------------------------------

def decode_stroke(stroke: Stroke) -> list[dict]:
    """A stroke's samples in points: ``[{x, y, p, t, a, z}]`` — ``p`` 0..1
    (0.5 when unrecorded), ``t`` ms since t0 or None, ``a``/``z`` degrees or
    None."""
    ch, pts, n = stroke.ch, stroke.pts, len(stroke.ch)
    out = []
    x = y = t = 0
    for i in range(0, len(pts), n):
        row = pts[i:i + n]
        rec = {"p": 0.5, "t": None, "a": None, "z": None}
        for c, v in zip(ch, row):
            if c == "x":
                x += v
                rec["x"] = x / COORD_UNIT
            elif c == "y":
                y += v
                rec["y"] = y / COORD_UNIT
            elif c == "p":
                rec["p"] = max(0.0, min(1.0, v / PRESSURE_UNIT))
            elif c == "t":
                t += v
                rec["t"] = t
            elif c == "a":
                rec["a"] = v
            elif c == "z":
                rec["z"] = v
        out.append(rec)
    return out


def encode_points(samples: list[dict], ch: str = "xy") -> list[int]:
    """The inverse of :func:`decode_stroke` (the importer and tests use it):
    ``samples`` carry ``x``/``y`` in points and the optional channels."""
    out = []
    px = py = pt = 0
    for s in samples:
        for c in ch:
            if c == "x":
                v = round(s["x"] * COORD_UNIT)
                out.append(v - px)
                px = v
            elif c == "y":
                v = round(s["y"] * COORD_UNIT)
                out.append(v - py)
                py = v
            elif c == "p":
                out.append(round(max(0.0, min(1.0, s.get("p", 0.5))) * PRESSURE_UNIT))
            elif c == "t":
                v = int(s.get("t") or 0)
                out.append(v - pt)
                pt = v
            elif c == "a":
                out.append(int(s.get("a") or 0))
            elif c == "z":
                out.append(int(s.get("z") or 0))
    return out


def stroke_width(stroke: Stroke, p: float) -> float:
    """Drawn diameter at pressure ``p``: pens thin with pressure, highlighters
    (and mouse/finger strokes, which carry no real pressure) stay constant."""
    if stroke.tool != "pen" or not stroke.pen:
        return stroke.size
    return stroke.size * (1 + THINNING * (p - 0.5))


def stroke_polyline(stroke: Stroke) -> list[tuple[float, float, float]]:
    """``[(x, y, width)]`` per sample — what every renderer here draws from
    (Xournal++'s model: variable-width polylines)."""
    return [(s["x"], s["y"], stroke_width(stroke, s["p"])) for s in decode_stroke(stroke)]


def bounding_box(ink: InkFile) -> tuple[float, float, float, float] | None:
    """(x0, y0, x1, y1) in points around every stroke, width included;
    None for an empty file."""
    x0 = y0 = math.inf
    x1 = y1 = -math.inf
    for stroke in ink.strokes:
        for x, y, w in stroke_polyline(stroke):
            r = w / 2
            x0, y0 = min(x0, x - r), min(y0, y - r)
            x1, y1 = max(x1, x + r), max(y1, y + r)
    if x0 is math.inf:
        return None
    return (x0, y0, x1, y1)


def pdf_position(ink: InkFile) -> dict | None:
    """The group's bounding box in the highlight ``pdf_position`` shape, so
    jump-to-position, markers and export anchoring treat ink like any other
    region on the page."""
    box = bounding_box(ink)
    if not box or ink.space.kind != "pdf-page":
        return None
    page = ink.space.page
    rect = {"x1": round(box[0], 2), "y1": round(box[1], 2), "x2": round(box[2], 2), "y2": round(box[3], 2),
            "width": ink.space.width, "height": ink.space.height, "pageNumber": page}
    return {"pageNumber": page, "boundingRect": rect, "rects": [dict(rect)]}


def parse_color(value: str) -> tuple[float, float, float, float]:
    """``#rrggbb`` or ``rgb[a](…)`` → (r, g, b, a) in 0..1."""
    v = (value or "").strip()
    if v.startswith("#") and len(v) == 7:
        return tuple(int(v[i:i + 2], 16) / 255 for i in (1, 3, 5)) + (1.0,)
    m = re.match(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)", v)
    if m:
        r, g, b = (min(int(c), 255) / 255 for c in m.groups()[:3])
        return (r, g, b, min(float(m.group(4)), 1.0) if m.group(4) else 1.0)
    return (0.12, 0.12, 0.12, 1.0)


# --- renderers ------------------------------------------------------------------

def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def to_svg(ink: InkFile, box=None, pad: float = 4.0) -> str:
    """An SVG of the strokes cropped to ``box`` (default: the bounding box).
    Pens draw one round-capped segment per sample pair at that pair's width;
    highlighters one constant-width path with their opacity, multiplied onto
    what lies beneath."""
    box = box or bounding_box(ink) or (0, 0, 1, 1)
    x0, y0, x1, y1 = box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad
    w, h = max(1.0, x1 - x0), max(1.0, y1 - y0)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{_fmt(x0)} {_fmt(y0)} {_fmt(w)} {_fmt(h)}" '
             f'width="{_fmt(w)}" height="{_fmt(h)}">']
    for stroke in ink.strokes:
        poly = stroke_polyline(stroke)
        r, g, b, a = parse_color(stroke.color)
        color = f"rgb({round(r * 255)},{round(g * 255)},{round(b * 255)})"
        opacity = min(a, stroke.opacity)
        if stroke.tool == "highlighter":
            d = "M" + " L".join(f"{_fmt(x)} {_fmt(y)}" for x, y, _ in poly)
            if len(poly) == 1:
                d += f" L{_fmt(poly[0][0] + 0.01)} {_fmt(poly[0][1])}"
            parts.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{_fmt(stroke.size)}" '
                         f'stroke-opacity="{_fmt(opacity)}" stroke-linecap="round" stroke-linejoin="round" '
                         'style="mix-blend-mode:multiply"/>')
            continue
        parts.append(f'<g fill="none" stroke="{color}" stroke-linecap="round" stroke-linejoin="round"'
                     + (f' stroke-opacity="{_fmt(opacity)}"' if opacity < 1 else "") + ">")
        if len(poly) == 1:
            x, y, wd = poly[0]
            parts.append(f'<path d="M{_fmt(x)} {_fmt(y)} L{_fmt(x + 0.01)} {_fmt(y)}" stroke-width="{_fmt(wd)}"/>')
        for (ax, ay, aw), (bx, by, bw) in zip(poly, poly[1:]):
            parts.append(f'<path d="M{_fmt(ax)} {_fmt(ay)} L{_fmt(bx)} {_fmt(by)}" '
                         f'stroke-width="{_fmt((aw + bw) / 2)}"/>')
        parts.append("</g>")
    parts.append("</svg>")
    return "".join(parts)


def pdf_path_ops(ink: InkFile, to_pdf, scale: float = 1.0) -> bytes:
    """PDF content-stream operators drawing the strokes: ``to_pdf(x, y)``
    maps a display-space point to user space (the notes-as-PDF writer
    draws in a frame of its own). Highlighter opacity is baked into the
    colour (no ExtGState needed) — over white that is the same shade."""
    from .pdf_typeset import num
    ops = [b"q 1 J 1 j"]
    for stroke in ink.strokes:
        poly = stroke_polyline(stroke)
        r, g, b, a = parse_color(stroke.color)
        a = min(a, stroke.opacity)
        if a < 1:
            r, g, b = (c * a + (1 - a) for c in (r, g, b))
        ops.append(b"%s %s %s RG" % (num(r), num(g), num(b)))
        if stroke.tool == "highlighter":
            pts = [to_pdf(x, y) for x, y, _ in poly]
            ops.append(b"%s w" % num(stroke.size * scale))
            ops.append(b"%s %s m " % (num(pts[0][0]), num(pts[0][1]))
                       + b" ".join(b"%s %s l" % (num(x), num(y)) for x, y in pts[1:] or [pts[0]]) + b" S")
            continue
        for (ax, ay, aw), (bx, by, bw) in zip(poly, poly[1:] or poly):
            (px, py), (qx, qy) = to_pdf(ax, ay), to_pdf(bx, by)
            ops.append(b"%s w %s %s m %s %s l S" % (num((aw + bw) / 2 * scale), num(px), num(py), num(qx), num(qy)))
    ops.append(b"Q")
    return b"\n".join(ops)


# --- PDF /Ink interchange --------------------------------------------------------

def ink_buckets(ink: InkFile) -> list[list[Stroke]]:
    """Strokes grouped by look (tool, colour, size, opacity), in first-seen
    order: one ``/Ink`` annotation per bucket, since the PDF annotation has
    one width and one colour."""
    buckets: dict[tuple, list[Stroke]] = {}
    for s in ink.strokes:
        buckets.setdefault((s.tool, s.color.lower(), round(s.size, 2), round(s.opacity, 3)), []).append(s)
    return list(buckets.values())


def from_pdf_ink(ink_list, width_pt: float, color: str, opacity: float, page: int,
                 page_w: float, page_h: float, private_json: str | None = None) -> dict:
    """An embedded ``/Ink`` annotation → an ink file dict. ``ink_list`` is the
    ``/InkList`` (paths of x y pairs in PDF user space, origin bottom-left);
    ``private_json`` is the ``/GammaInk`` string a Gamma export left behind,
    which wins when it parses (it carries pressure and time)."""
    if private_json:
        try:
            ink = parse_ink(private_json)
            if ink.space.kind == "pdf-page":
                ink.space.page = page
            return ink.model_dump(exclude_none=True)
        except InkError:
            pass
    strokes = []
    for n, path in enumerate(ink_list or []):
        nums = [float(v) for v in path]
        samples = [{"x": nums[i], "y": page_h - nums[i + 1]} for i in range(0, len(nums) - 1, 2)]
        if not samples:
            continue
        strokes.append({"id": f"i{n}", "tool": "pen", "pen": False, "color": color,
                        "size": max(0.2, min(100.0, width_pt or 1.0)), "opacity": max(0.05, min(1.0, opacity)),
                        "ch": "xy", "pts": encode_points(samples, "xy")})
    return {"format": FORMAT, "version": VERSION,
            "space": {"kind": "pdf-page", "page": page, "width": page_w, "height": page_h},
            "strokes": strokes}


def dumps(ink: InkFile | dict) -> bytes:
    """Canonical bytes for storage (sorted keys, no whitespace) — the same
    strokes always hash to the same upload name."""
    data = ink.model_dump(exclude_none=True) if isinstance(ink, InkFile) else ink
    return json.dumps(data, separators=(",", ":"), sort_keys=True).encode("utf-8")
