"""Burn Gamma highlight blocks into a PDF as standard annotations — text
highlights as /Highlight, area notes (Ctrl+drag rectangles, position carries
``area: true``) as /Square — so the exported file shows them (with notes as
annotation popups) in Acrobat, SumatraPDF, Preview, browsers, etc.

Coordinate round-trip: the viewer stores rects in top-left-origin page-render
pixels together with the render size (``width``/``height``), i.e. effectively
normalized coordinates in pdf.js viewport space. pdf.js viewports are based on
the crop box and apply /Rotate, so the inverse mapping here must too. This is
the exact reverse of what routers/imports.py does when reading embedded
annotations (which come straight from PDF user space).

No appearance streams (/AP) are written — every mainstream viewer synthesizes
the marker look for /Highlight annotations from /QuadPoints + /C, and the
outline for /Square from /Rect + /C + /BS.

Zotero compatibility: its reader imports /Highlight (→ highlight) and /Square
(→ image/area annotation) — but pdf-worker's ``readRawAnnotation`` DROPS a
/Square that carries no annotation id (``/Zotero:Key``, or ``/NM`` shaped
``Zotero-<key>``); highlights import fine without one. So every /Square gets a
deterministic ``/NM`` key derived from the highlight block id (stable across
re-exports, so Zotero can dedupe), spelled in Zotero's own 8-char key
alphabet. Highlights stay id-less on purpose.

This module also owns the geometry of the **native** (iPad) annotations —
see the "native PencilKit annotations" section below: a ``type: "pdf_ink"``
block is placed as a picture on the page (Apple's private PKDrawing cannot be
re-opened here, so nothing is converted to vector strokes), and the same
helpers serve the notes document.
"""

import base64
import hashlib
import io
import json
import math
import re

from PyPDF2 import PdfReader, PdfWriter
from PyPDF2._page import PageObject
from PyPDF2.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    RectangleObject,
    TextStringObject,
)

from .logbuf import log
from .native_ink import DRAWING_REF_RE, PREVIEW_REF_RE, REPLAY_REF_RE, ReplayAsset
from .pdf_image import image_xobject

_RGBA_RE = re.compile(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)")
_HEX_RE = re.compile(r"#([0-9a-fA-F]{6})$")
DEFAULT_COLOR = (1.0, 226 / 255, 143 / 255, 0.65)  # the viewer's yellow


def parse_css_color(value):
    """CSS color string (as stored on highlight blocks) → (r, g, b, alpha) in 0..1."""
    m = _RGBA_RE.match((value or "").strip())
    if m:
        r, g, b = (min(int(v), 255) / 255 for v in m.groups()[:3])
        a = min(float(m.group(4)), 1.0) if m.group(4) else 1.0
        return (r, g, b, a)
    m = _HEX_RE.match((value or "").strip())
    if m:
        h = m.group(1)
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)) + (1.0,)
    return DEFAULT_COLOR


def viewer_point_to_pdf(u, v, rotation, crop):
    """A display-space point, normalized (``u`` right, ``v`` down from the
    top of the page as shown) → PDF user space (bottom-left origin).
    ``crop`` is (cx0, cy0, cx1, cy1); ``rotation`` a multiple of 90."""
    cx0, cy0, cx1, cy1 = crop
    cw, ch = cx1 - cx0, cy1 - cy0
    if rotation == 90:
        return cx0 + v * cw, cy0 + u * ch
    if rotation == 180:
        return cx1 - u * cw, cy0 + v * ch
    if rotation == 270:
        return cx1 - v * cw, cy1 - u * ch
    return cx0 + u * cw, cy1 - v * ch


def _viewer_rect_to_pdf(rect, rotation, crop):
    """One stored viewer rect → (x1, y1, x2, y2) in PDF user space."""
    w = float(rect.get("width") or 0) or 1.0
    h = float(rect.get("height") or 0) or 1.0
    (ax, ay), (bx, by) = (viewer_point_to_pdf(float(vx) / w, float(vy) / h, rotation, crop)
                          for vx, vy in ((rect["x1"], rect["y1"]), (rect["x2"], rect["y2"])))
    return (min(ax, bx), min(ay, by), max(ax, bx), max(ay, by))


def _page_frame(page):
    """(crop box, rotation) of a PyPDF2 page — the frame both mappers need."""
    crop = tuple(float(v) for v in (page.cropbox.left, page.cropbox.bottom,
                                    page.cropbox.right, page.cropbox.top))
    try:
        rotation = int(page.rotation) % 360
    except Exception:
        rotation = 0
    return crop, rotation


# --- native (iPad) PencilKit annotations -------------------------------------
#
# A ``type: "pdf_ink"`` block (docs/dev/handwriting.md) keeps Apple's private
# PKDrawing as ``ink_asset`` plus two READABLE renderings of it: the whole
# annotation as a PNG (``preview_asset``) and, when the iPad has exported one,
# a per-stroke ``replay_asset`` (``gamma-ink-replay-v1``). Neither can be
# turned back into strokes — PKDrawing is opaque outside Apple's frameworks —
# so the exporters place the PICTURE where the annotation sits. That is
# faithful to what the page looks like and claims nothing more: the editable
# source stays on iPad, and no vector ink is invented from a raster.
#
# Geometry is ``pdf-crop-top-left-v1``: unrotated crop-box points, origin at
# the crop's upper-left, x right / y down. That is the frame the native client
# records in and the frame ``frontend/src/native/inkBlock.js`` maps out of, so
# the mapping here is the same one, one page frame down — a crop-local point
# (x, y) sits at
#
#     user_x = crop.left + x * (crop_width  / frame_width)
#     user_y = crop.top  - y * (crop_height / frame_height)
#
# and a box is that mapping of its top-left corner and its extent (see
# ``native_ink_user_box``). The declared frame (``crop_box`` for the preview,
# the derivative's own width/height for a replay) is scaled onto the page's
# crop box, exactly as the viewer scales it; /Rotate is deliberately NOT
# applied, because the recording is already in the unrotated frame — the viewer
# rotates the page, and with it the placed picture, the same way it rotates the
# handwriting on screen.

NATIVE_INK_SPACE = "pdf-crop-top-left-v1"
_NATIVE_EPSILON = 0.001
NATIVE_IMAGE_PREFIX = "GmNi"    # distinct from pdf_image's GmIm / pdf_glyphs' GmT
BLEND_STATE = "GmNiInk"         # the ExtGState name native pictures draw under


def _native_numbers(values, count: int):
    """``count`` finite floats from a stored geometry field, or None."""
    if not isinstance(values, (list, tuple)) or len(values) != count:
        return None
    out = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        value = float(value)
        if not math.isfinite(value):
            return None
        out.append(value)
    return tuple(out)


def _ink_frame_and_bounds(props):
    """A ``pdf_ink`` block's stored box and its coordinate frame, both in that
    frame's own points → ``((x, y, w, h), (frame_w, frame_h))``, or None when
    the geometry is missing or self-contradictory (a box outside its frame is
    a broken block, not a placement to guess at)."""
    if not isinstance(props, dict) or props.get("type") != "pdf_ink":
        return None
    bounds, crop = props.get("bounds"), props.get("crop_box")
    if not isinstance(bounds, dict) or not isinstance(crop, dict):
        return None
    box = _native_numbers((bounds.get("x"), bounds.get("y"),
                           bounds.get("width"), bounds.get("height")), 4)
    frame = _native_numbers((crop.get("width"), crop.get("height")), 2)
    if box is None or frame is None:
        return None
    x, y, w, h = box
    if x < 0 or y < 0 or w <= 0 or h <= 0:
        return None
    if x + w > frame[0] + _NATIVE_EPSILON or y + h > frame[1] + _NATIVE_EPSILON:
        return None
    return box, frame


def native_ink_geometry(props) -> dict | None:
    """Validated PAGE placement of a native annotation →
    ``{"page": n, "bounds": (x, y, w, h), "crop": (w, h)}``, or None.

    Requires the recorded coordinate space (``pdf-crop-top-left-v1``): a block
    claiming a space this writer does not know is left off the page rather than
    positioned by guesswork. Its picture can still appear in the notes
    document, which needs no page position."""
    if not isinstance(props, dict) or props.get("coordinate_space") != NATIVE_INK_SPACE:
        return None
    page = props.get("pdf_page")
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        return None
    geometry = _ink_frame_and_bounds(props)
    if geometry is None:
        return None
    bounds, crop = geometry
    return {"page": page, "bounds": bounds, "crop": crop}


def _asset_bytes(uploads_dir, ref, pattern) -> bytes | None:
    """The stored bytes behind a ``/api/assets/<64hex>.<ext>`` reference, or
    None. Only the canonical local URL is accepted (no remote, no data URL, no
    traversal) and it must be a real, non-symlink file in the workspace's own
    uploads directory — the store the native upload endpoint writes."""
    if uploads_dir is None or not isinstance(ref, str) or not pattern.fullmatch(ref):
        return None
    path = uploads_dir / ref.rsplit("/", 1)[-1]
    try:
        if path.is_symlink() or not path.is_file():
            return None
        return path.read_bytes()
    except OSError:
        return None


class _BytesImage:
    """``pdf_image.image_xobject`` reads a file; a replay derivative's stroke
    PNGs exist only base64-encoded inside the ``.inkjson``, so they are handed
    to it through this minimal path-like (it calls ``read_bytes()``)."""

    def __init__(self, data: bytes, name: str = "native-ink.png"):
        self._data, self.name = data, name

    def read_bytes(self) -> bytes:
        return self._data


def native_ink_image(writer, data: bytes):
    """PNG bytes → ``(resource name, indirect object)`` on this writer, or None
    when the bytes are not an image this server can embed (there is no imaging
    library here — ``pdf_image`` handles PNG and JPEG). Names are
    content-addressed, so one document never mints a name twice and identical
    pictures share one entry."""
    built = image_xobject(_BytesImage(data))
    if not built:
        return None
    return f"{NATIVE_IMAGE_PREFIX}{hashlib.sha256(data).hexdigest()[:16]}", writer._add_object(built[0])


def _trim_to_content(picture: dict) -> dict:
    """A picture's frame cut down to what its draws actually cover. Needed for
    the PNG preview, whose box is a small annotation inside a page-sized
    ``crop_box``: laid out in a document, the picture should be the
    handwriting, not the empty page around it."""
    x0 = min(d["box"][0] for d in picture["draws"])
    y0 = min(d["box"][1] for d in picture["draws"])
    x1 = max(d["box"][0] + d["box"][2] for d in picture["draws"])
    y1 = max(d["box"][1] + d["box"][3] for d in picture["draws"])
    return {**picture,
            "frame": (x1 - x0, y1 - y0),
            "draws": [{**d, "box": (d["box"][0] - x0, d["box"][1] - y0,
                                    d["box"][2], d["box"][3])} for d in picture["draws"]]}


def _preview_picture(uploads_dir, props) -> dict | None:
    """The block's own PNG preview — the whole annotation as the viewer puts it
    on the page — or None when the geometry or the file is unusable."""
    geometry = _ink_frame_and_bounds(props)
    data = _asset_bytes(uploads_dir, props.get("preview_asset"), PREVIEW_REF_RE)
    if geometry is None or data is None:
        return None
    bounds, crop = geometry
    return {"frame": crop, "draws": [{"data": data, "box": bounds}],
            "source": "preview", "strokes": None}


def _replay_picture(uploads_dir, props) -> dict | None:
    """The per-stroke ``gamma-ink-replay-v1`` derivative as a picture, or None
    when it is missing, unreadable, or STALE — a derivative whose
    ``source_sha256`` is no longer the block's current ``ink_asset`` digest
    describes a drawing that has since been replaced, and drawing it would show
    strokes that are not there any more. The server enforces the same rule when
    the reference is attached, so this is the second half of one contract."""
    raw = _asset_bytes(uploads_dir, props.get("replay_asset"), REPLAY_REF_RE)
    drawing = props.get("ink_asset")
    if raw is None or not isinstance(drawing, str) or not DRAWING_REF_RE.fullmatch(drawing):
        return None
    try:
        replay = ReplayAsset.model_validate(json.loads(raw.decode("utf-8")))
    except Exception:
        return None
    if replay.source_sha256 != drawing.rsplit("/", 1)[-1].split(".", 1)[0]:
        return None
    draws = []
    for stroke in replay.strokes:
        try:
            data = base64.b64decode(stroke.png.encode("ascii"), validate=True)
        except Exception:
            continue
        b = stroke.bounds
        draws.append({"data": data, "box": (b.x, b.y, b.width, b.height)})
    if not draws:
        return None
    return {"frame": (replay.width, replay.height), "draws": draws,
            "source": "replay", "strokes": len(replay.strokes)}


def native_ink_picture(uploads_dir, props, prefer_replay: bool = False,
                       crop_to_content: bool = False) -> dict | None:
    """A native annotation's readable picture, in its own crop-local frame:

    ``{"frame": (w, h), "draws": [{"data": <png bytes>, "box": (x, y, w, h)}],
    "source": "preview" | "replay", "strokes": <int|None>}``

    or None when neither rendering is available — the caller then says so
    rather than drawing something made up. ``prefer_replay`` puts the
    per-stroke derivative first (the higher-resolution rendering the web's
    static preview shows); otherwise the block's PNG preview is authoritative
    and the derivative is the fallback. ``crop_to_content`` trims the frame to
    the picture's own bounds (see ``_trim_to_content``)."""
    if not isinstance(props, dict) or props.get("type") != "pdf_ink":
        return None
    preview = _preview_picture(uploads_dir, props)
    replay = _replay_picture(uploads_dir, props)
    for picture in ((replay, preview) if prefer_replay else (preview, replay)):
        if picture is not None:
            return _trim_to_content(picture) if crop_to_content else picture
    return None


def native_ink_user_box(box, frame, crop):
    """A box in a native annotation's crop-local frame → the rectangle it
    occupies in PDF user space ``(x, y, w, h)`` on a page whose crop box is
    ``crop`` (``(cx0, cy0, cx1, cy1)``).

    The frame is scaled onto the crop box (the viewer's own rule; in the normal
    case the declared ``crop_box`` IS the crop's size and the scale is 1) and y
    is flipped, because crop-local y grows downward from the crop's top.
    /Rotate is not part of this mapping — the recording is already unrotated."""
    cx0, cy0, cx1, cy1 = crop
    x, y, w, h = box
    kx = (cx1 - cx0) / frame[0] if frame[0] else 1.0
    ky = (cy1 - cy0) / frame[1] if frame[1] else 1.0
    return (cx0 + x * kx, cy1 - (y + h) * ky, w * kx, h * ky)


def _num(value: float) -> bytes:
    return b"%.2f" % round(float(value), 2)


def _stamp_images(writer, page_index: int, ops: list, xobjects: dict):
    """Merge an image-only overlay onto a page as extra page CONTENT.

    Content, not an annotation, is deliberate: the picture prints, needs no
    appearance stream, and every viewer shows it. The overlay's boxes are
    widened to the target page's own (the pattern ``pdf_notes`` uses) so its
    coordinates map 1:1, and PyPDF2 leaves the merged stream inline in the page
    dict — it is re-added as an indirect object or the file is unreadable.

    The pictures are drawn with a **Multiply** blend mode. Both renderings the
    iPad produces are PencilKit images on a transparent background, and
    ``pdf_image`` bakes that transparency onto white (it has no alpha-channel
    path): drawn normally, the annotation's bounding box would be an opaque
    white rectangle that erases the text it was written over. Multiplying, the
    white parts let the paper through and dark ink darkens it — what ink on
    paper does. Blend modes are a PDF 1.4 feature, so the header says so
    (PyPDF2 stamps 1.3 otherwise)."""
    page = writer.pages[page_index]
    overlay = PageObject.create_blank_page(width=1, height=1)
    box = [float(v) for v in (page.mediabox.left, page.mediabox.bottom,
                              page.mediabox.right, page.mediabox.top)]
    crop = [float(v) for v in (page.cropbox.left, page.cropbox.bottom,
                               page.cropbox.right, page.cropbox.top)]
    rect = RectangleObject((min(box[0], crop[0]), min(box[1], crop[1]),
                            max(box[2], crop[2]), max(box[3], crop[3])))
    overlay[NameObject("/MediaBox")] = rect
    overlay[NameObject("/TrimBox")] = rect
    stream = DecodedStreamObject()
    stream.set_data(b"q /%s gs\n" % BLEND_STATE.encode("ascii")
                    + b"\n".join(ops) + b"\nQ")
    overlay[NameObject("/Contents")] = stream
    overlay[NameObject("/Resources")] = DictionaryObject({
        NameObject("/XObject"): DictionaryObject(
            {NameObject("/" + name): ref for name, ref in xobjects.items()}),
        NameObject("/ExtGState"): DictionaryObject({NameObject("/" + BLEND_STATE): DictionaryObject({
            NameObject("/Type"): NameObject("/ExtGState"),
            NameObject("/BM"): NameObject("/Multiply"),
            NameObject("/ca"): FloatObject(1),
            NameObject("/CA"): FloatObject(1),
        })}),
    })

    page.merge_page(overlay)
    page[NameObject("/Contents")] = writer._add_object(page[NameObject("/Contents")])
    try:
        writer.pdf_header = b"%PDF-1.4"
    except Exception:                    # a PyPDF2 without the setter: version stays
        pass


def _picture_ops(writer, picture, crop, xobjects: dict) -> list:
    """The content-stream operators that draw one picture at its crop-local
    frame position, registering every image XObject it needs in ``xobjects``
    (resource name → indirect object). Empty when no part could be embedded."""
    ops = []
    for draw in picture["draws"]:
        built = native_ink_image(writer, draw["data"])
        if not built:
            log.info("[pdf-export] a native ink picture could not be embedded (unsupported image bytes)")
            continue
        name, ref = built
        xobjects.setdefault(name, ref)
        x, y, w, h = native_ink_user_box(draw["box"], picture["frame"], crop)
        if w <= 0 or h <= 0:
            continue
        ops.append(b"q %s 0 0 %s %s %s cm /%s Do Q" % (
            _num(w), _num(h), _num(x), _num(y), name.encode("ascii")))
    return ops


def draw_native_ink(writer, groups) -> int:
    """Draw every native annotation group's picture onto its page.

    ``groups``: ``[{"props": <pdf_ink properties>, "picture": <native_ink_picture>,
    "id": <block id>}]``. Returns the number of PICTURES drawn; a group whose
    geometry, assets or page are unusable is skipped and logged — never placed
    from a guess."""
    by_page: dict[int, list] = {}
    for group in groups:
        props = group.get("props") or {}
        geometry = native_ink_geometry(props)
        picture = group.get("picture")
        if geometry is None or not picture:
            log.info(f"[pdf-export] native ink {group.get('id')}: no placement or picture; skipped")
            continue
        by_page.setdefault(geometry["page"], []).append(picture)

    drawn = 0
    for page_num, pictures in sorted(by_page.items()):
        if page_num < 1 or page_num > len(writer.pages):
            continue
        page = writer.pages[page_num - 1]
        crop = _page_frame(page)[0]
        ops, xobjects = [], {}
        for picture in pictures:
            picture_ops = _picture_ops(writer, picture, crop, xobjects)
            if not picture_ops:
                continue
            drawn += 1
            ops.extend(picture_ops)
        if ops:
            _stamp_images(writer, page_num - 1, ops, xobjects)
    return drawn


def _finish_annotation(annot, color, note, author):
    r, g, b, alpha = color
    annot[NameObject("/C")] = ArrayObject((FloatObject(r), FloatObject(g), FloatObject(b)))
    annot[NameObject("/CA")] = FloatObject(round(alpha, 3))
    annot[NameObject("/F")] = NumberObject(4)  # print
    if note:
        annot[NameObject("/Contents")] = TextStringObject(note)
    if author:
        annot[NameObject("/T")] = TextStringObject(author)
    return annot


def _highlight_annotation(rects, color, note, author):
    quads, xs, ys = [], [], []
    for x1, y1, x2, y2 in rects:
        # Quad order: upper-left, upper-right, lower-left, lower-right.
        quads.extend((x1, y2, x2, y2, x1, y1, x2, y1))
        xs.extend((x1, x2))
        ys.extend((y1, y2))
    annot = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Highlight"),
        NameObject("/Rect"): ArrayObject(
            FloatObject(v) for v in (min(xs), min(ys), max(xs), max(ys))
        ),
        NameObject("/QuadPoints"): ArrayObject(FloatObject(v) for v in quads),
    })
    return _finish_annotation(annot, color, note, author)


# Zotero's item-key alphabet (32 chars — 5 bits per char).
_ZOTERO_KEY_CHARS = "23456789ABCDEFGHIJKLMNPQRSTUVWXZ"


def zotero_annot_key(highlight_id: str) -> str:
    """Deterministic 8-char Zotero-style key for a highlight block id."""
    digest = hashlib.sha1((highlight_id or "").encode("utf-8")).digest()
    return "".join(_ZOTERO_KEY_CHARS[b & 31] for b in digest[:8])


def _square_annotation(rects, color, note, author, highlight_id=""):
    """Area note → /Square: a stroked rectangle (no interior fill — it would
    obscure the figure underneath) over the bounding box of the rects. The
    /NM id is what makes Zotero import it (see module docstring)."""
    xs = [v for x1, _, x2, _ in rects for v in (x1, x2)]
    ys = [v for _, y1, _, y2 in rects for v in (y1, y2)]
    annot = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Square"),
        NameObject("/Rect"): ArrayObject(
            FloatObject(v) for v in (min(xs), min(ys), max(xs), max(ys))
        ),
        NameObject("/BS"): DictionaryObject({
            NameObject("/W"): NumberObject(2),
            NameObject("/S"): NameObject("/S"),
        }),
    })
    if highlight_id:
        annot[NameObject("/NM")] = TextStringObject(f"Zotero-{zotero_annot_key(highlight_id)}")
    return _finish_annotation(annot, color, note, author)


def _ink_annotations(ink, rotation, crop, note, author, block_id=""):
    """One handwriting group → ``/Ink`` annotations, one per look bucket
    (``ink.ink_buckets``): ``/InkList`` polylines in user space, ``/BS /W``
    the bucket's mean drawn width, ``/C`` + ``/CA`` its colour. Every
    annotation also carries its strokes as ``/GammaInk`` (the gamma-ink JSON)
    so a Gamma re-import keeps pressure and time; other readers ignore the
    private key. The note rides on the first bucket only."""
    from . import ink as inkmod
    sw, sh = float(ink.space.width), float(ink.space.height)
    # Display points are pdf.js scale-1 points, so the crop box has the same
    # size unless the page was replaced; widths scale by the ratio.
    cw, ch = crop[2] - crop[0], crop[3] - crop[1]
    k = ((cw if rotation in (0, 180) else ch) / sw) if sw else 1.0
    out = []
    for n, bucket in enumerate(inkmod.ink_buckets(ink)):
        first = bucket[0]
        r, g, b, a = inkmod.parse_color(first.color)
        paths, xs, ys, widths = [], [], [], []
        for stroke in bucket:
            poly = inkmod.stroke_polyline(stroke)
            flat = []
            for x, y, w in poly:
                px, py = viewer_point_to_pdf(x / sw, y / sh, rotation, crop)
                flat.extend((px, py))
                xs.append(px)
                ys.append(py)
                widths.append(w)
            if len(poly) == 1:
                flat.extend(flat[:2])
            paths.append(ArrayObject(FloatObject(round(v, 2)) for v in flat))
        if not paths:
            continue
        width = (sum(widths) / len(widths)) * k
        pad = width / 2 + 1
        annot = DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Ink"),
            NameObject("/Rect"): ArrayObject(
                FloatObject(v) for v in (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)),
            NameObject("/InkList"): ArrayObject(paths),
            NameObject("/BS"): DictionaryObject({
                NameObject("/W"): FloatObject(round(width, 2)),
                NameObject("/S"): NameObject("/S"),
            }),
            NameObject("/GammaInk"): TextStringObject(inkmod.dumps({
                "format": inkmod.FORMAT, "version": inkmod.VERSION,
                "space": ink.space.model_dump(exclude_none=True),
                "strokes": [s.model_dump(exclude_none=True) for s in bucket],
            }).decode("utf-8")),
        })
        if block_id:
            annot[NameObject("/NM")] = TextStringObject(f"Zotero-{zotero_annot_key(f'{block_id}:{n}')}")
        out.append(_finish_annotation(annot, (r, g, b, min(a, first.opacity)),
                                      note if n == 0 else "", author))
    return out


def highlight_note_text(block, children_by_id):
    """The annotation popup text: the highlight's own comment plus its nested
    notes as an indented bullet list."""

    def walk(bid, depth):
        lines = []
        for child in children_by_id.get(bid, []):
            text = (child.get("content") or "").strip()
            if text:
                lines.append("  " * depth + "- " + text)
            lines.extend(walk(child["id"], depth + 1))
        return lines

    parts = []
    own = (block.get("content") or "").strip()
    if own:
        parts.append(own)
    parts.extend(walk(block["id"], 0))
    return "\n".join(parts)


def annotate_pdf(pdf_bytes: bytes, highlights, author: str = "", ink=(),
                 native_ink=()) -> tuple[bytes, int]:
    """Return (annotated pdf bytes, number of annotations written).

    ``highlights``: [{position: <pdf_position dict>, color: <css string>,
    note: <str>, id: <highlight block id, optional>}]. Positions with no
    usable rects or an out-of-range page are skipped rather than failing the
    whole export. ``ink``: [{ink: <gamma.ink.InkFile>, note, id}], the
    handwriting groups, written as ``/Ink`` (``_ink_annotations``) — the vector
    route, unchanged. ``native_ink``: [{props: <pdf_ink properties>, picture:
    <native_ink_picture>, id}], the iPad annotations, whose readable picture is
    drawn INTO the page as content (``draw_native_ink``) — that count is
    reported by ``annotate_pdf_result``, not by the annotation count here.
    """
    result = annotate_pdf_result(pdf_bytes, highlights, author=author, ink=ink,
                                 native_ink=native_ink)
    return result["pdf"], result["annotations"]


def annotate_pdf_result(pdf_bytes: bytes, highlights, author: str = "", ink=(),
                        native_ink=()) -> dict:
    """``annotate_pdf``'s work, reported field by field:
    ``{"pdf": bytes, "annotations": n, "native_ink": n}`` — ``annotations``
    counts the /Highlight, /Square and /Ink annotations, ``native_ink`` the
    native PencilKit pictures placed as page content."""
    reader = PdfReader(io.BytesIO(pdf_bytes))
    writer = PdfWriter()
    writer.append(reader)

    written = 0
    for group in ink:
        ink_file = group.get("ink")
        page_num = ink_file.space.page if ink_file and ink_file.space.kind == "pdf-page" else None
        if not page_num or page_num < 1 or page_num > len(writer.pages):
            continue
        crop, rotation = _page_frame(writer.pages[page_num - 1])
        for annot in _ink_annotations(ink_file, rotation, crop, group.get("note") or "",
                                      author, block_id=group.get("id") or ""):
            writer.add_annotation(page_number=page_num - 1, annotation=annot)
            written += 1
    for h in highlights:
        pos = h.get("position") or {}
        page_num = pos.get("pageNumber") or (pos.get("boundingRect") or {}).get("pageNumber")
        if not page_num or page_num < 1 or page_num > len(writer.pages):
            continue
        viewer_rects = pos.get("rects") or ([pos["boundingRect"]] if pos.get("boundingRect") else [])
        viewer_rects = [r for r in viewer_rects if r and r.get("x1") is not None]
        if not viewer_rects:
            continue
        crop, rotation = _page_frame(writer.pages[page_num - 1])
        pdf_rects = [_viewer_rect_to_pdf(r, rotation, crop) for r in viewer_rects]
        color = parse_css_color(h.get("color"))
        if pos.get("area"):
            annot = _square_annotation(pdf_rects, color, h.get("note") or "",
                                       author, highlight_id=h.get("id") or "")
        else:
            annot = _highlight_annotation(pdf_rects, color, h.get("note") or "", author)
        writer.add_annotation(page_number=page_num - 1, annotation=annot)
        written += 1

    drawn = draw_native_ink(writer, native_ink)

    out = io.BytesIO()
    writer.write(out)
    return {"pdf": out.getvalue(), "annotations": written, "native_ink": drawn}
