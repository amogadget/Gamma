"""Native (iPad) handwriting and recordings in the two PDF writers.

The native representation is a second, independent shape (docs/dev/handwriting.md):
a ``type: "pdf_ink"`` block carries Apple's private PKDrawing plus two readable
renderings of it — a whole-block PNG preview and, when the iPad exported one, a
per-stroke ``.inkjson`` derivative — and a ``type: "audio"`` block carries
finalized M4A segments. Neither can be converted into the browser's vector
``gamma-ink`` strokes here, so these tests pin what the exporters actually
promise:

* the annotation's PICTURE lands on the page where the recorded
  ``pdf-crop-top-left-v1`` geometry says it belongs, for an offset crop box and
  every quarter turn, rotated with the page (asserted from RENDERED pixels, not
  from a 200 response);
* the notes document carries the same picture plus a caption, and the recording
  as text — durations and links to the stored segments — never as a fake
  embedded player;
* the upstream vector export is untouched, and no export mutates stored files.

Fixtures are built by hand (real PNGs, a real PDF with a crop box and /Rotate)
because the server ships no imaging library and must not need one.
"""

import base64
import hashlib
import io
import json
import struct
import uuid
import zlib

import pytest
from PyPDF2 import PdfReader, PdfWriter
from PyPDF2.generic import FloatObject, NameObject, RectangleObject

from conftest import login, make_user, workspace_of

PAGE_W, PAGE_H = 612.0, 792.0
CROP = (40.0, 60.0, 572.0, 732.0)          # offset crop box: an origin bug cannot hide
CROP_W, CROP_H = CROP[2] - CROP[0], CROP[3] - CROP[1]
BOUNDS = {"x": 100, "y": 200, "width": 120, "height": 80}


# --- fixtures ------------------------------------------------------------------

def png_bytes(width=40, height=20, rgb=(255, 0, 0), alpha=None):
    """A real, structurally valid PNG of one flat colour (RGBA when ``alpha`` is
    given — the shape a PencilKit preview usually is)."""
    ctype, channels = (6, 4) if alpha is not None else (2, 3)
    pixel = bytes((*rgb, alpha)) if alpha is not None else bytes(rgb)
    raw = b"".join(b"\x00" + pixel * width for _ in range(height))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, ctype, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def split_png_bytes(width=40, height=20):
    """A PNG whose left half is red and right half blue: after a quarter turn
    the COLOURS must move too, which a bounding box alone would not show."""
    raw = b"".join(b"\x00" + (bytes((255, 0, 0)) * (width // 2) + bytes((0, 0, 255)) * (width - width // 2))
                   for _ in range(height))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


def m4a_bytes(payload=b"segment"):
    """A plausible ISO-BMFF ``ftyp`` box; the audio itself stays opaque."""
    return (16 + len(payload)).to_bytes(4, "big") + b"ftyp" + b"M4A " + (0).to_bytes(4, "big") + payload


def page_pdf(pages=1, crop=None, rotate=0, black_rect=None):
    """A blank PDF; every page carries ``crop`` as its CropBox and ``rotate``.

    ``black_rect`` fills a user-space rectangle in black first, so a test can
    see whether something drawn over it hides the page or blends into it.
    Each call stamps a unique comment into the page content, so two tests that
    upload a fixture never share a document id (and therefore never share the
    page the annotations hang off) — a PDF is stored by content hash."""
    from PyPDF2.generic import DecodedStreamObject

    marker = uuid.uuid4().hex
    writer = PdfWriter()
    for index in range(pages):
        writer.add_blank_page(width=PAGE_W, height=PAGE_H)
        if crop:
            writer.pages[index][NameObject("/CropBox")] = RectangleObject(
                [FloatObject(v) for v in crop])
        if rotate:
            writer.pages[index].rotate(rotate)
        body = f"% fixture {marker}-{index}\n"
        if black_rect:
            x0, y0, x1, y1 = black_rect
            body += f"0 0 0 rg {x0} {y0} {x1 - x0} {y1 - y0} re f\n"
        stream = DecodedStreamObject()
        stream.set_data(body.encode("ascii"))
        writer.pages[index][NameObject("/Contents")] = writer._add_object(stream)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def replay_document(drawing, strokes, width=CROP_W, height=CROP_H):
    """A ``gamma-ink-replay-v1`` derivative (the strict schema the server
    validates): one PNG + sampled path per stroke, in crop-local points."""
    return {"format": "gamma-ink-replay-v1", "source_sha256": drawing,
            "width": width, "height": height,
            "strokes": [
                {"id": name,
                 "bounds": {"x": x, "y": y, "width": w, "height": h},
                 "png": base64.b64encode(png).decode(),
                 "points": [{"x": x, "y": y, "t": 0, "radius": 2}]}
                for name, (x, y, w, h), png in strokes]}


# A well-formed PencilKit reference that is deliberately NOT uploaded. These
# properties are handed to the pure geometry/picture helpers and to
# ``annotate_pdf_result`` / ``render_document`` directly — never through the
# block API — so no stored block can reference it; ``clean_workspace`` re-checks
# that after every test, which is what would catch it if that ever changed.
UNSTORED_DRAWING = "/api/assets/" + "a" * 64 + ".pkdrawing"


def native_props(preview=None, drawing=None, replay=None, *, bounds=BOUNDS,
                 crop_box=(CROP_W, CROP_H), page=1, space="pdf-crop-top-left-v1"):
    """The properties the native endpoints store for a ``pdf_ink`` block
    (``drawing`` defaults to ``UNSTORED_DRAWING``; pass a real uploaded asset
    URL whenever the test needs a replay's ``source_sha256`` to match)."""
    props = {"type": "pdf_ink", "pdf_page": page,
             "ink_asset": drawing or UNSTORED_DRAWING,
             "bounds": dict(bounds),
             "crop_box": {"width": crop_box[0], "height": crop_box[1]},
             "coordinate_space": space, "ink_revision": 1}
    if preview:
        props["preview_asset"] = preview
    if replay:
        props["replay_asset"] = replay
    return props


OWNER = "native-pdf-owner"


def owner_workspaces():
    """Every personal workspace this file's account owns, oldest first.

    One test exports from a NON-default workspace on purpose, so cleanup and
    verification cover all of them, not just the default."""
    from gamma import workspaces
    return workspaces.personal_workspaces(OWNER) or [workspace_of(OWNER)]


def ws_uploads(ws=None):
    from gamma.db import ws_uploads_dir
    return ws_uploads_dir(ws or workspace_of(OWNER))


def dangling_native_references():
    """``[(workspace, block id, asset filename)]`` for every ``/api/assets/…``
    reference in this account's workspaces whose file is not on disk.

    The same test as ``tools/audit_native_migration.py``'s ``missing_references``
    (which scans a whole data directory), reduced to the libraries these tests
    own — the worker's data directory is shared with other test files, and a
    dangling reference left here fails their audit, not just this one."""
    import re
    from gamma.db import connect_pages_db

    pattern = re.compile(r"/api/assets/([0-9a-f]{64}\.(?:pkdrawing|png|m4a|inkjson))")
    missing = []
    for ws in owner_workspaces():
        uploads = ws_uploads(ws)
        with connect_pages_db(ws) as conn:
            rows = conn.execute("SELECT id, content, properties FROM unified_blocks").fetchall()
        for block_id, content, properties in rows:
            for name in sorted(set(pattern.findall(properties or ""))
                               | set(pattern.findall(content or ""))):
                if not (uploads / name).is_file():
                    missing.append((ws, block_id, name))
    return missing


@pytest.fixture
def owner():
    make_user(OWNER, "native-pdf-password")
    with login(OWNER, "native-pdf-password") as client:
        yield client


@pytest.fixture(autouse=True)
def clean_workspace(owner):
    """Leave the worker's shared data directory as this test found it.

    Two tests here remove a stored asset on purpose — "the preview is not on
    this server" is a real state — and the whole-directory native audit
    ``tests/test_native_migration_startup.py`` runs fails on a reference whose
    file is gone, so a file left missing here breaks another file's verdict
    when both share an xdist worker. After every test this fixture therefore:

    1. puts back any stored file that was already there when the test started
       (assets are content-addressed, so one test's fixture image is another
       test's file), and
    2. asserts none of this account's workspaces has a dangling native
       reference at all — which is what forces a test that removes a file its
       OWN block still references to restore it (both such tests do), and what
       would catch the never-stored properties above ever becoming stored ones.

    Both steps cover every personal workspace the account owns: the
    absolute-link test exports from a non-default one on purpose."""
    before = {}
    for ws in owner_workspaces():
        uploads = ws_uploads(ws)
        before[ws] = ({path.name: path.read_bytes()
                       for path in uploads.iterdir() if path.is_file()}
                      if uploads.exists() else {})
    yield
    for ws, files in before.items():
        uploads = ws_uploads(ws)
        uploads.mkdir(parents=True, exist_ok=True)
        for name, data in files.items():
            path = uploads / name
            if not path.is_file():
                path.write_bytes(data)
    assert dangling_native_references() == []

def upload_asset(client, data, ext, ctype, ws=None):
    response = client.post("/api/assets", files={"file": (f"asset.{ext}", data, ctype)},
                           params=_scope(ws))
    assert response.status_code == 200, response.text
    return response.json()["url"]


def _scope(ws):
    """Request params naming a workspace explicitly, or nothing for the
    account's default one."""
    return {"ws": ws} if ws else {}


def private_preview(client):
    """An uploaded preview PNG whose BYTES nothing else uses.

    Assets are content-addressed, so identical fixture images share one file:
    a test that removes a file to simulate a lost preview must not take out an
    asset another test's block still references (that would leave a dangling
    reference, which the whole-directory migration audit rightly fails)."""
    seed = uuid.uuid4().int
    colour = (seed % 256, (seed // 256) % 256, (seed // 65536) % 256)
    return upload_asset(client, png_bytes(17, 7, colour), "png", "image/png")


def asset_file(url):
    """The stored file behind an ``/api/assets/…`` URL, in this file's library."""
    return ws_uploads() / url.rsplit("/", 1)[-1]


# --- rendering helpers ---------------------------------------------------------

def _bitmap(pdf_bytes, page=1, scale=1.0):
    """The DISPLAYED page as pdfium paints it: ``(width, height, pixels)`` with
    row 0 at the top (verified against a red rectangle in all four rotations)
    and RGB tuples. Rendering through pdfium is the point: it proves the image
    is really in the content stream and decodable, not merely referenced."""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(pdf_bytes)
    try:
        bitmap = document[page - 1].render(scale=scale)
        try:
            raw, stride = bytes(bitmap.buffer), bitmap.stride
            width, height = bitmap.width, bitmap.height
            pixels = [[(raw[y * stride + 3 * x + 2], raw[y * stride + 3 * x + 1],
                        raw[y * stride + 3 * x]) for x in range(width)] for y in range(height)]
            return width, height, pixels
        finally:
            bitmap.close()
    finally:
        document.close()


def colour_box(pdf_bytes, rgb, page=1, tolerance=70):
    """Bounding box ``(x0, y0, x1, y1)`` of the pixels matching ``rgb``, in
    display points (top-left origin, /Rotate and the crop box applied)."""
    width, height, pixels = _bitmap(pdf_bytes, page)
    xs, ys = [], []
    for y in range(height):
        for x in range(width):
            r, g, b = pixels[y][x]
            if all(abs(c - t) <= tolerance for c, t in zip((r, g, b), rgb)):
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def image_boxes(pdf_bytes, page=1):
    """User-space bounds of every image object on a page, straight from
    pdfium's page-object walk (the unrotated frame the content stream draws in)."""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(pdf_bytes)
    try:
        return [tuple(round(float(v), 3) for v in obj.get_bounds())
                for obj in document[page - 1].get_objects(max_depth=1) if obj.type == 3]
    finally:
        document.close()


def path_boxes(pdf_bytes, page=1):
    """User-space bounds of every PATH object (rules, bars, bullet dots, …)."""
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(pdf_bytes)
    try:
        return [tuple(round(float(v), 3) for v in obj.get_bounds())
                for obj in document[page - 1].get_objects(max_depth=1) if obj.type == 2]
    finally:
        document.close()


def page_text(pdf_bytes, page=1):
    import pypdfium2 as pdfium

    document = pdfium.PdfDocument(pdf_bytes)
    try:
        textpage = document[page - 1].get_textpage()
        try:
            return textpage.get_text_bounded() or ""
        finally:
            textpage.close()
    finally:
        document.close()


def link_targets(pdf_bytes, page=1):
    """Every ``/Link`` annotation's URI on a page."""
    reader = PdfReader(io.BytesIO(pdf_bytes))
    out = []
    for annot in reader.pages[page - 1].get("/Annots") or []:
        annot = annot.get_object()
        action = annot.get("/A")
        if action is not None and action.get_object().get("/URI") is not None:
            out.append(str(action.get_object()["/URI"]))
    return out


def display_box(bounds, crop, rotate):
    """Where a crop-local box must appear on the DISPLAYED page: the mapping
    ``pdf_notes._frame`` inverts, spelled out so the expectation is independent
    of the code under test."""
    cx0, cy0, cx1, cy1 = crop
    cw, ch = cx1 - cx0, cy1 - cy0
    x, y, w, h = bounds["x"], bounds["y"], bounds["width"], bounds["height"]
    if rotate == 90:
        return (ch - y - h, x, ch - y, x + w)
    if rotate == 180:
        return (cw - x - w, ch - y - h, cw - x, ch - y)
    if rotate == 270:
        return (y, cw - x - w, y + h, cw - x)
    return (x, y, x + w, y + h)


def snapshot_uploads():
    """This library's stored files, name → sha256: the export must not change
    a single one of them (see the endpoint tests)."""
    uploads = ws_uploads()
    if not uploads.exists():
        return {}
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(uploads.iterdir()) if path.is_file()}


def close_to(box, expected, tolerance=1.5):
    assert box is not None, f"nothing drawn where {expected} was expected"
    for got, want in zip(box, expected):
        assert abs(got - want) <= tolerance, f"{box} != {expected}"


# --- the picture lands where the recorded geometry says ------------------------

@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_native_ink_preview_is_placed_through_the_crop_and_rotation(rotate, owner):
    """The PNG preview is drawn as page content at the crop-local box the iPad
    recorded, on an offset crop box, and the viewer's own /Rotate carries it —
    so the picture appears exactly where the handwriting does on screen."""
    from gamma.pdf_export import annotate_pdf_result, native_ink_picture

    props = native_props(preview=upload_asset(owner, png_bytes(alpha=255), "png", "image/png"))
    picture = native_ink_picture(asset_file(props["preview_asset"]).parent, props)
    assert picture["source"] == "preview"

    result = annotate_pdf_result(page_pdf(crop=CROP, rotate=rotate), [],
                                 native_ink=[{"props": props, "picture": picture, "id": "b1"}])
    assert result["native_ink"] == 1
    assert result["annotations"] == 0
    # Display space: 120x80 crop-local points, turned with the page.
    close_to(colour_box(result["pdf"], (255, 0, 0)), display_box(BOUNDS, CROP, rotate))
    # The content stream draws it in unrotated user space: crop origin + x, and
    # y flipped from the crop's top.
    assert image_boxes(result["pdf"]) == [(CROP[0] + 100, CROP[3] - 200 - 80, CROP[0] + 220,
                                           CROP[3] - 200)]


def test_native_ink_picture_rotates_with_the_page(owner):
    """Two colours in one preview: after a quarter turn the COLOURS change
    place too, which a bounding box alone would not catch."""
    from gamma.pdf_export import annotate_pdf_result, native_ink_picture

    props = native_props(preview=upload_asset(owner, split_png_bytes(), "png", "image/png"))
    picture = native_ink_picture(asset_file(props["preview_asset"]).parent, props)

    upright = annotate_pdf_result(page_pdf(crop=CROP), [],
                                  native_ink=[{"props": props, "picture": picture, "id": "b"}])["pdf"]
    red, blue = colour_box(upright, (255, 0, 0)), colour_box(upright, (0, 0, 255))
    assert red[0] < blue[0] and abs(red[1] - blue[1]) < 2      # red left of blue

    turned = annotate_pdf_result(page_pdf(crop=CROP, rotate=90), [],
                                 native_ink=[{"props": props, "picture": picture, "id": "b"}])["pdf"]
    red, blue = colour_box(turned, (255, 0, 0)), colour_box(turned, (0, 0, 255))
    assert red[1] < blue[1] and abs(red[0] - blue[0]) < 2      # red ABOVE blue now


def test_native_ink_ignores_geometry_it_does_not_understand(owner):
    """A block claiming a coordinate space this writer has no mapping for is
    left off the page — never placed by guesswork (its picture can still be
    shown in the notes document, which needs no page position)."""
    from gamma.pdf_document import render_document
    from gamma.pdf_export import annotate_pdf_result, native_ink_geometry, native_ink_picture

    url = upload_asset(owner, png_bytes(), "png", "image/png")
    props = native_props(preview=url, space="pdf-crop-top-left-v2")
    assert native_ink_geometry(props) is None
    picture = native_ink_picture(asset_file(url).parent, props)
    assert picture is not None

    result = annotate_pdf_result(page_pdf(crop=CROP), [],
                                 native_ink=[{"props": props, "picture": picture, "id": "b"}])
    assert result["native_ink"] == 0 and image_boxes(result["pdf"]) == []
    # The document has no page frame to respect, so the picture is still there.
    page = {"id": "p", "content": "Notes", "properties": {}, "children": [
        {"id": "b", "content": "", "properties": props, "children": []}]}
    assert image_boxes(render_document([page], uploads_dir=asset_file(url).parent))


def test_native_ink_geometry_rejects_a_box_outside_its_frame():
    from gamma.pdf_export import native_ink_geometry

    outside = native_props(preview="/api/assets/" + "b" * 64 + ".png",
                           bounds={"x": 100, "y": 700, "width": 120, "height": 80})
    assert native_ink_geometry(outside) is None
    assert native_ink_geometry(native_props(bounds={"x": -1, "y": 0, "width": 10, "height": 10})) is None
    assert native_ink_geometry(native_props(page=0)) is None


def test_native_ink_is_drawn_on_the_page_it_names(owner):
    """``pdf_page`` is 1-based against the original document: a picture for
    page 2 belongs on page 2, and one pointing past the end is skipped."""
    from gamma.pdf_export import annotate_pdf_result, native_ink_picture

    url = upload_asset(owner, png_bytes(), "png", "image/png")
    # These pages have no offset crop box, so the declared frame is the page.
    second = native_props(preview=url, page=2, crop_box=(PAGE_W, PAGE_H))
    past_end = native_props(preview=url, page=9, crop_box=(PAGE_W, PAGE_H))
    groups = [{"props": props, "picture": native_ink_picture(asset_file(url).parent, props),
               "id": str(n)} for n, props in enumerate((second, past_end))]

    result = annotate_pdf_result(page_pdf(pages=2), [], native_ink=groups)
    assert result["native_ink"] == 1
    assert image_boxes(result["pdf"], page=1) == []
    assert image_boxes(result["pdf"], page=2) == [(100.0, 512.0, 220.0, 592.0)]


# --- which rendering is used, and when -----------------------------------------

def test_native_ink_picture_prefers_the_preview_then_the_replay(owner):
    """The preview is the block's own picture; the per-stroke derivative is the
    fallback for the page and the FIRST choice for the document (resolution)."""
    from gamma.pdf_export import native_ink_picture

    preview = upload_asset(owner, png_bytes(), "png", "image/png")
    drawing = upload_asset(owner, b"pkdrawing bytes", "pkdrawing", "application/octet-stream")
    digest = drawing.rsplit("/", 1)[-1].split(".", 1)[0]
    replay_url = upload_asset(owner, json.dumps(replay_document(digest, [
        ("s1", (100, 200, 60, 40), png_bytes(30, 10, (0, 200, 0))),
        ("s2", (300, 400, 90, 30), png_bytes(30, 10, (0, 0, 255)))])).encode(),
        "inkjson", "application/json")
    uploads = asset_file(preview).parent
    props = native_props(preview=preview, drawing=drawing, replay=replay_url)

    page_picture = native_ink_picture(uploads, props)
    assert page_picture["source"] == "preview" and page_picture["frame"] == (CROP_W, CROP_H)
    assert page_picture["draws"][0]["box"] == (100.0, 200.0, 120.0, 80.0)

    document_picture = native_ink_picture(uploads, props, prefer_replay=True, crop_to_content=True)
    assert document_picture["source"] == "replay" and document_picture["strokes"] == 2
    # Trimmed to the strokes' own bounds: the derivative's frame is the crop box.
    assert document_picture["frame"] == (290.0, 230.0)
    assert [d["box"] for d in document_picture["draws"]] == [(0.0, 0.0, 60.0, 40.0),
                                                             (200.0, 200.0, 90.0, 30.0)]


def test_native_ink_replay_is_used_when_the_preview_is_gone(owner):
    """A preview that is no longer on this server (a restored/partial copy) must
    not cost the annotation its picture: the derivative is drawn instead.

    The removed file is put back before the test ends — storage it did not
    create is not left changed, and no other test file sharing this worker's
    data directory sees a different library than the one it started with."""
    from gamma.pdf_export import annotate_pdf_result, native_ink_picture

    preview = private_preview(owner)
    drawing = upload_asset(owner, b"another drawing", "pkdrawing", "application/octet-stream")
    digest = drawing.rsplit("/", 1)[-1].split(".", 1)[0]
    replay_url = upload_asset(owner, json.dumps(replay_document(digest, [
        ("s1", (100, 200, 60, 40), png_bytes(30, 10, (0, 200, 0))),
        ("s2", (300, 400, 90, 30), png_bytes(30, 10, (0, 0, 255)))])).encode(),
        "inkjson", "application/json")
    uploads = asset_file(preview).parent
    props = native_props(preview=preview, drawing=drawing, replay=replay_url)
    path = asset_file(preview)
    stored = path.read_bytes()
    path.unlink()
    try:
        picture = native_ink_picture(uploads, props)
        assert picture["source"] == "replay"
        result = annotate_pdf_result(page_pdf(crop=CROP), [],
                                     native_ink=[{"props": props, "picture": picture, "id": "b"}])
        assert result["native_ink"] == 1
        # One image per stroke, each at its own crop-local box in user space.
        assert image_boxes(result["pdf"]) == [
            (CROP[0] + 100, CROP[3] - 200 - 40, CROP[0] + 160, CROP[3] - 200),
            (CROP[0] + 300, CROP[3] - 400 - 30, CROP[0] + 390, CROP[3] - 400)]
    finally:
        path.write_bytes(stored)


def test_native_ink_replay_from_another_drawing_is_stale_and_ignored(owner):
    """``source_sha256`` is the derivative's contract with the drawing it was
    rendered from: a mismatched one describes strokes that are no longer there,
    so it is skipped rather than drawn."""
    from gamma.pdf_export import annotate_pdf_result, native_ink_picture

    preview = upload_asset(owner, png_bytes(), "png", "image/png")
    drawing = upload_asset(owner, b"current drawing", "pkdrawing", "application/octet-stream")
    stale_url = upload_asset(owner, json.dumps(replay_document("f" * 64, [
        ("s1", (100, 200, 60, 40), png_bytes(30, 10, (0, 200, 0)))])).encode(),
        "inkjson", "application/json")
    uploads = asset_file(preview).parent

    stale = native_props(preview=preview, drawing=drawing, replay=stale_url)
    assert native_ink_picture(uploads, dict(stale, preview_asset=None)) is None
    assert native_ink_picture(uploads, stale)["source"] == "preview"
    plain = native_props(preview=preview, drawing=drawing)
    result = annotate_pdf_result(page_pdf(crop=CROP), [],
                                 native_ink=[{"props": plain, "picture": native_ink_picture(uploads, plain),
                                              "id": "b"}])
    assert result["native_ink"] == 1 and len(image_boxes(result["pdf"])) == 1


def test_native_ink_without_any_readable_picture_draws_nothing(owner):
    from gamma.pdf_export import annotate_pdf_result, native_ink_picture

    props = native_props(preview="/api/assets/" + "c" * 64 + ".png")
    uploads = asset_file(props["preview_asset"]).parent
    assert native_ink_picture(uploads, props) is None
    result = annotate_pdf_result(page_pdf(crop=CROP), [],
                                 native_ink=[{"props": props, "picture": None, "id": "b"}])
    assert result["native_ink"] == 0 and image_boxes(result["pdf"]) == []


def test_native_ink_preview_lets_the_page_show_through(owner):
    """Both renderings the iPad produces are PencilKit images on a TRANSPARENT
    background, and the PNG decoder bakes that onto white. Drawn normally the
    annotation's box would be an opaque white rectangle erasing the very text
    it was written over, so the picture is drawn with a Multiply blend: white
    lets the paper through, ink darkens it."""
    from gamma.pdf_export import annotate_pdf_result, native_ink_picture

    # A black band under the LEFT HALF of the annotation's box (user x 140..200
    # of the 140..260 the box covers; y 452..532).
    source = page_pdf(crop=CROP, black_rect=(140, 452, 200, 532))

    def draw(data):
        props = native_props(preview=upload_asset(owner, data, "png", "image/png"))
        picture = native_ink_picture(asset_file(props["preview_asset"]).parent, props)
        return annotate_pdf_result(source, [],
                                   native_ink=[{"props": props, "picture": picture, "id": "b"}])["pdf"]

    # A fully transparent preview must not hide the band (display (130, 240) is
    # over it; the box spans display x 100..220, y 200..280).
    transparent = draw(png_bytes(20, 10, (0, 0, 0), alpha=0))
    _width, _height, pixels = _bitmap(transparent)
    assert pixels[240][130] == (0, 0, 0)
    assert transparent[:8] == b"%PDF-1.4"   # /BM is a PDF 1.4 feature, so say so

    # An opaque preview paints its own colour where the paper is white and
    # darkens where it is not (red × black = black): ink, not a cut-out.
    solid = draw(png_bytes(20, 10, (255, 0, 0)))
    _width, _height, pixels = _bitmap(solid)
    assert pixels[240][190] == (255, 0, 0)   # right half: red on white paper
    assert pixels[240][130] == (0, 0, 0)     # left half: red over black stays black


# --- upstream vector ink is untouched ------------------------------------------

def test_upstream_ink_and_native_ink_coexist_on_one_page(owner):
    """The ``gamma-ink`` vector export keeps working, on a page that also has a
    native annotation: one /Ink annotation plus one drawn picture."""
    from gamma import ink as inkmod
    from gamma.pdf_export import annotate_pdf_result, native_ink_picture

    samples = [{"x": 100 + 10 * i, "y": 200 + 3 * i, "p": 0.5, "t": 16 * i} for i in range(5)]
    ink_file = inkmod.parse_ink({"format": "gamma-ink", "version": 1,
                                 "space": {"kind": "pdf-page", "page": 1,
                                           "width": PAGE_W, "height": PAGE_H},
                                 "strokes": [{"id": "s1", "ch": "xypt", "t0": 1,
                                              "pts": inkmod.encode_points(samples, "xypt")}]})
    url = upload_asset(owner, png_bytes(), "png", "image/png")
    props = native_props(preview=url)
    picture = native_ink_picture(asset_file(url).parent, props)

    result = annotate_pdf_result(page_pdf(), [],
                                 ink=[{"ink": ink_file, "note": "vector ink", "id": "g1"}],
                                 native_ink=[{"props": props, "picture": picture, "id": "b1"}])
    assert result["annotations"] == 1 and result["native_ink"] == 1
    subtypes = [str(a.get_object()["/Subtype"])
                for a in PdfReader(io.BytesIO(result["pdf"])).pages[0]["/Annots"]]
    assert subtypes == ["/Ink"]
    assert len(image_boxes(result["pdf"])) == 1


# --- the notes document --------------------------------------------------------

def test_notes_pdf_draws_the_native_picture_with_its_caption(owner):
    from gamma.pdf_document import render_document

    drawing = upload_asset(owner, b"pkdrawing", "pkdrawing", "application/octet-stream")
    digest = drawing.rsplit("/", 1)[-1].split(".", 1)[0]
    preview = upload_asset(owner, png_bytes(), "png", "image/png")
    replay_url = upload_asset(owner, json.dumps(replay_document(digest, [
        ("s1", (100, 200, 60, 40), png_bytes(30, 10, (0, 200, 0))),
        ("s2", (300, 400, 90, 30), png_bytes(30, 10, (0, 0, 255)))])).encode(),
        "inkjson", "application/json")
    props = dict(native_props(preview=preview, drawing=drawing, replay=replay_url), pdf_page=3)
    page = {"id": "p", "content": "Lecture", "properties": {}, "children": [
        {"id": "b", "content": "the derivation", "properties": props, "children": []}]}

    pdf = render_document([page], uploads_dir=asset_file(preview).parent)
    text = page_text(pdf)
    assert "handwriting, p. 3 · 2 strokes" in text
    assert "the derivation" in text
    boxes = image_boxes(pdf)
    assert len(boxes) == 2
    assert colour_box(pdf, (0, 200, 0)) and colour_box(pdf, (0, 0, 255))


def test_notes_pdf_says_so_when_no_preview_is_readable(owner):
    """Silence would be the one thing this must not do: the block IS
    handwriting, and the reason it cannot be shown is part of the export."""
    from gamma.pdf_document import render_document

    props = dict(native_props(preview="/api/assets/" + "d" * 64 + ".png"), pdf_page=7)
    page = {"id": "p", "content": "Lecture", "properties": {}, "children": [
        {"id": "b", "content": "", "properties": props, "children": []}]}
    pdf = render_document([page], uploads_dir=asset_file(props["preview_asset"]).parent)
    assert "handwriting, p. 7 · no preview available" in page_text(pdf)
    assert image_boxes(pdf) == []


def test_notes_pdf_switches_hold_the_native_picture_and_its_text_apart(owner):
    """Native handwriting is a PDF region, so the highlights switch governs it
    (like ink_url, and like the Markdown export); with highlights off the block
    keeps its own writing as a plain bullet."""
    from gamma.pdf_document import render_document

    url = upload_asset(owner, png_bytes(), "png", "image/png")
    props = dict(native_props(preview=url), pdf_page=2)
    page = {"id": "p", "content": "Lecture", "properties": {}, "children": [
        {"id": "b", "content": "my own words", "properties": props, "children": []}]}

    both = render_document([page], uploads_dir=asset_file(url).parent)
    assert image_boxes(both) and "handwriting, p. 2" in page_text(both)
    no_highlights = render_document([page], highlights=False, notes=True,
                                    uploads_dir=asset_file(url).parent)
    assert image_boxes(no_highlights) == [] and "handwriting" not in page_text(no_highlights)
    assert "my own words" in page_text(no_highlights)
    no_notes = render_document([page], highlights=True, notes=False,
                               uploads_dir=asset_file(url).parent)
    assert image_boxes(no_notes) and "my own words" not in page_text(no_notes)


def audio_props(segments=((42.0, "asset-a"), (41.0, "asset-b")), duration=None):
    props = {"type": "audio", "audio_state": "stopped",
             "segments": [{"id": str(uuid.uuid4()), "duration": seconds,
                           "asset": f"/api/assets/{key.ljust(64, 'e')}.m4a",
                           "start_time": 0} for seconds, key in segments]}
    if duration is not None:
        props["duration"] = duration
    return props


def test_notes_pdf_audio_is_text_durations_and_links(owner):
    """A PDF cannot play a recording, so the document carries what a reader can
    use instead of pretending: how long each segment is and where it lives."""
    from gamma.pdf_document import render_document

    first = audio_props([(42.0, "a")])
    page = {"id": "p", "content": "Seminar", "properties": {}, "children": [
        {"id": "rec", "content": "recorded during the seminar", "properties": first,
         "children": []}]}
    pdf = render_document([page])
    text = page_text(pdf)
    assert "audio recording · 1 segment · 0:42 total · audio not embedded" in text
    assert "Segment 1 · 0:42" in text
    assert "recorded during the seminar" in text
    assert link_targets(pdf) == [first["segments"][0]["asset"]]
    # Nothing is embedded: no /EmbeddedFile, no /Sound, no /Movie, no player.
    reader = PdfReader(io.BytesIO(pdf))
    names = reader.trailer["/Root"].get("/Names") or {}
    assert "/EmbeddedFiles" not in names
    assert b"/Sound" not in pdf and b"/Movie" not in pdf and b"/RichMedia" not in pdf


def test_notes_pdf_audio_several_segments_and_missing_durations():
    from gamma.pdf_document import render_document

    three = audio_props([(42.0, "a"), (41.0, "b"), (15.0, "c")])
    page = {"id": "p", "content": "Long seminar", "properties": {}, "children": [
        {"id": "rec", "content": "", "properties": three, "children": []}]}
    text = page_text(render_document([page]))
    assert "3 segments · 1:38 total" in text
    assert ["Segment 1 · 0:42", "Segment 2 · 0:41", "Segment 3 · 0:15"] == \
        [line for line in ("Segment 1 · 0:42", "Segment 2 · 0:41", "Segment 3 · 0:15") if line in text]

    empty = audio_props([])
    page = {"id": "p", "content": "Silence", "properties": {}, "children": [
        {"id": "rec", "content": "", "properties": empty, "children": []}]}
    assert "audio recording · no finalized segments" in page_text(render_document([page]))


def test_notes_pdf_audio_follows_the_notes_switch():
    from gamma.pdf_document import render_document

    props = audio_props([(30.0, "a")])
    page = {"id": "p", "content": "Seminar", "properties": {}, "children": [
        {"id": "rec", "content": "my summary", "properties": props, "children": []}]}
    assert "audio recording" in page_text(render_document([page], notes=True))
    notes_off = render_document([page], notes=False)
    assert "audio recording" not in page_text(notes_off)
    assert "my summary" not in page_text(notes_off)
    # The highlights switch is about marks on the paper, not about writing.
    assert "audio recording" in page_text(render_document([page], highlights=False, notes=True))


def test_audio_summary_never_invents_a_timeline():
    from gamma.pdf_document import audio_summary

    summary, lines = audio_summary({"type": "audio", "segments": [
        {"asset": "/api/assets/" + "0" * 64 + ".m4a"}]})
    assert summary == "audio recording · 1 segment · 0:00 total · audio not embedded"
    assert lines == [("Segment 1 · 0:00", "/api/assets/" + "0" * 64 + ".m4a")]
    # A remote or foreign reference stays plain text rather than a dead link.
    _, lines = audio_summary({"type": "audio", "segments": [
        {"asset": "https://example.invalid/x.m4a", "duration": 5}]})
    assert lines == [("Segment 1 · 0:05", None)]


def test_absolute_asset_link_makes_a_stored_ref_fetchable():
    """What a downloaded document needs: an origin, the path it was stored
    under, and the workspace it belongs to — nothing else."""
    from gamma.pdf_document import absolute_asset_link, audio_summary

    ref = "/api/assets/" + "a" * 64 + ".m4a"
    link = absolute_asset_link("http://gamma.example.com/", "ws-second")
    assert link(ref) == f"http://gamma.example.com{ref}?ws=ws-second"
    # A deployment's root path (GAMMA_PUBLIC_URL with a prefix, or a mounted
    # app) is kept: the reference goes after it, not at the host root.
    assert absolute_asset_link("https://host.example/gamma", "w")("/api/uploads/x.png") == \
        "https://host.example/gamma/api/uploads/x.png?ws=w"
    # No workspace named → no workspace parameter; nothing else is ever added.
    assert absolute_asset_link("https://host.example", None)(ref) == f"https://host.example{ref}"
    for bad in ("https://other.example/x.m4a", "data:audio/mp4;base64,AAAA", "x.m4a", ""):
        assert absolute_asset_link("https://host.example", "w")(bad) == bad
    for forbidden in ("share=", "token=", "session=", "sig="):
        assert forbidden not in link(ref)
    # The recording's segment lines go through it; foreign refs stay plain.
    _, lines = audio_summary({"type": "audio", "segments": [
        {"asset": ref, "duration": 5},
        {"asset": "https://example.invalid/x.m4a", "duration": 6}]}, link)
    assert lines[0][1] == f"http://gamma.example.com{ref}?ws=ws-second"
    assert lines[1][1] is None


# --- endpoints, end to end, over real stored files -----------------------------

def doc_page(client, pdf_bytes, title="Native page", ws=None):
    """Upload a real PDF and make it a page (the page the annotations target)."""
    uploaded = client.post("/api/uploads", params=_scope(ws),
                           files={"file": ("paper.pdf", pdf_bytes, "application/pdf")})
    assert uploaded.status_code == 200, uploaded.text
    doc_id = uploaded.json()["doc_id"]
    page = client.post(f"/api/blocks/by-doc/{doc_id}", params=_scope(ws),
                       json={"default_title": title})
    assert page.status_code == 200, page.text
    return page.json(), doc_id


def save_audio(client, page_id, segments, ws=None):
    """One native recording block in ``ws`` (ids + local ``.m4a`` assets)."""
    block_id = str(uuid.uuid4())
    saved = client.put(f"/api/blocks/{block_id}/audio", params=_scope(ws), json={
        "parent_id": page_id, "audio_state": "stopped", "segments": segments,
        "expected_revision": 0})
    assert saved.status_code == 200, saved.text
    return saved.json()


def save_native_ink(client, page_id, preview_url, *, page=1, bounds=BOUNDS,
                    crop_box=(CROP_W, CROP_H)):
    block_id = str(uuid.uuid4())
    saved = client.put(f"/api/blocks/{block_id}/ink", json={
        "parent_id": page_id, "pdf_page": page,
        "ink_asset": upload_asset(client, b"pkdrawing source", "pkdrawing",
                                  "application/octet-stream"),
        "preview_asset": preview_url, "bounds": dict(bounds),
        "crop_box": {"width": crop_box[0], "height": crop_box[1]}, "expected_revision": 0})
    assert saved.status_code == 200, saved.text
    return saved.json()


def test_export_pdf_endpoint_places_native_ink_and_never_writes_to_storage(owner):
    """The real path: a stored PDF (offset crop box, /Rotate 90), an annotation
    created through the native endpoint, and an export that must neither lose
    the handwriting nor touch a single stored byte."""
    page, doc_id = doc_page(owner, page_pdf(crop=CROP, rotate=90))
    preview = upload_asset(owner, png_bytes(alpha=255), "png", "image/png")
    save_native_ink(owner, page["id"], preview)

    source_url = page["properties"].get("source_url") or f"/api/uploads/{doc_id}.pdf"
    before_bytes = owner.get(source_url).content
    before_files = snapshot_uploads()

    response = owner.get(f"/api/pages/{page['id']}/export-pdf")
    assert response.status_code == 200, response.text
    assert response.headers["x-native-ink-drawn"] == "1"
    assert response.headers["x-annotations-written"] == "0"
    close_to(colour_box(response.content, (255, 0, 0)), display_box(BOUNDS, CROP, 90))
    assert response.content != before_bytes

    # highlights=0 is "a clean PDF": the picture is part of the annotation
    # layer, not of the original paper.
    plain = owner.get(f"/api/pages/{page['id']}/export-pdf", params={"highlights": 0})
    assert plain.headers["x-native-ink-drawn"] == "0"
    assert colour_box(plain.content, (255, 0, 0)) is None

    # The stored PDF and every stored asset are byte-for-byte what they were:
    # the export reads, it never rewrites the library.
    from gamma.db import pdf_upload_path
    assert owner.get(source_url).content == before_bytes
    assert pdf_upload_path(workspace_of("native-pdf-owner"), doc_id).read_bytes() == before_bytes
    assert snapshot_uploads() == before_files


def test_notes_pdf_renders_native_blocks_nested_below_the_page(owner):
    """Real libraries hold native blocks deeper than the page's own children
    (migrated or edited trees), and a block at depth > 0 is drawn with an
    outliner bullet. The caption line used to pass that "is there a bullet"
    flag where the bullet MARKER string belongs, so ``_bullet`` measured a
    bool and the whole notes export died before writing a page."""
    from gamma.pdf_document import render_document

    preview = upload_asset(owner, png_bytes(), "png", "image/png")
    ink = dict(native_props(preview=preview), pdf_page=4)
    audio = audio_props([(42.0, "a")])
    page = {"id": "p", "content": "Lecture", "properties": {}, "children": [
        {"id": "h", "content": "", "properties": {"highlight_id": "h1",
                                                  "quote": "the quoted passage",
                                                  "pdf_page": 4},
         "children": [
             {"id": "ink", "content": "written underneath", "properties": ink,
              "children": []},
             {"id": "rec", "content": "recorded underneath", "properties": audio,
              "children": []}]}]}

    pdf = render_document([page], uploads_dir=asset_file(preview).parent)
    text = page_text(pdf)
    assert "the quoted passage" in text
    assert "handwriting, p. 4" in text and "written underneath" in text
    assert "audio recording · 1 segment · 0:42 total · audio not embedded" in text
    assert "Segment 1 · 0:42" in text and "recorded underneath" in text
    assert image_boxes(pdf), "the nested annotation still shows its picture"
    assert link_targets(pdf) == [audio["segments"][0]["asset"]]

    # The nested blocks really were emitted as bullets: the same tree with them
    # as the page's own children (depth 0) draws no bullet markers, and each
    # bullet is one small filled rectangle, so nesting adds two paths.
    flat = {"id": "p", "content": "Lecture", "properties": {}, "children": [
        {"id": "h", "content": "", "properties": {"highlight_id": "h1",
                                                  "quote": "the quoted passage",
                                                  "pdf_page": 4}, "children": []},
        {"id": "ink", "content": "written underneath", "properties": ink, "children": []},
        {"id": "rec", "content": "recorded underneath", "properties": audio, "children": []}]}
    flat_pdf = render_document([flat], uploads_dir=asset_file(preview).parent)
    assert len(path_boxes(pdf)) - len(path_boxes(flat_pdf)) >= 2


def test_notes_pdf_failure_reports_and_logs_the_real_cause(owner, monkeypatch):
    """A failing notes export must surface its cause — and say so in the server
    log. ``log`` is a Logger, not a function: calling it raised a TypeError
    INSIDE the error handler, which replaced the real exception with a 500
    about ``'Logger' object is not callable``."""
    from gamma import logbuf

    page, _ = doc_page(owner, page_pdf(), title="Broken notes")
    cursor = logbuf.tail()[-1]["seq"] if logbuf.tail() else 0

    def explode(*args, **kwargs):
        raise RuntimeError("boom while typesetting")

    monkeypatch.setattr("gamma.routers.export.render_document", explode)
    response = owner.get(f"/api/pages/{page['id']}/export", params={"mode": "notes-pdf"})
    assert response.status_code == 400, response.text
    assert "boom while typesetting" in response.json()["detail"]

    logged = [e for e in logbuf.tail(cursor) if "boom while typesetting" in e["msg"]]
    assert logged, "the failure must reach the server log"
    assert logged[-1]["level"] == "ERROR"


def test_zotero_export_keeps_a_bare_pdf_when_annotating_fails(owner, monkeypatch):
    """The annotate step of a Zotero export is best-effort and its failure is
    logged — the same Logger-call bug turned that fallback into a 500 and
    dropped the PDF."""
    import zipfile

    page, _ = doc_page(owner, page_pdf(), title="Zotero fallback")
    block_id = str(uuid.uuid4())
    rect = {"x1": 100, "y1": 72, "x2": 300, "y2": 92, "width": PAGE_W, "height": PAGE_H,
            "pageNumber": 1}
    inserted = owner.post(f"/api/pages/{page['id']}/ops", json={
        "client": "test", "ops": [{"op": "insert", "id": block_id, "parent": page["id"],
                                   "content": "my note",
                                   "props": {"highlight_id": block_id, "quote": "quoted",
                                             "pdf_page": 1,
                                             "pdf_position": {"pageNumber": 1,
                                                              "boundingRect": dict(rect),
                                                              "rects": [dict(rect)]}}}]})
    assert inserted.status_code == 200, inserted.text

    def explode(*args, **kwargs):
        raise RuntimeError("no annotator today")

    monkeypatch.setattr("gamma.routers.export.annotate_pdf", explode)
    response = owner.get(f"/api/pages/{page['id']}/export", params={"mode": "zotero-rdf"})
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as bundle:
        pdfs = [name for name in bundle.namelist() if name.endswith(".pdf")]
        assert pdfs, bundle.namelist()
        assert bundle.read(pdfs[0]).startswith(b"%PDF")


def test_notes_pdf_endpoint_carries_handwriting_and_recording_text(owner, monkeypatch):
    """Both native kinds in one export: the picture drawn, the recording
    described with fetchable links, a native note beneath the handwriting — and
    the library untouched afterwards."""
    monkeypatch.delenv("GAMMA_PUBLIC_URL", raising=False)
    page, doc_id = doc_page(owner, page_pdf(), title="Seminar notes")
    preview = upload_asset(owner, png_bytes(), "png", "image/png")
    ink = save_native_ink(owner, page["id"], preview, page=2)
    note = str(uuid.uuid4())
    saved_note = owner.put(f"/api/blocks/{note}/note", json={
        "parent_id": ink["id"], "content": "check this step with the tutor",
        "expected_revision": 0})
    assert saved_note.status_code == 200, saved_note.text

    segments = [{"id": str(uuid.uuid4()),
                 "asset": upload_asset(owner, m4a_bytes(b"one"), "m4a", "audio/mp4"),
                 "duration": 42.0},
                {"id": str(uuid.uuid4()),
                 "asset": upload_asset(owner, m4a_bytes(b"two"), "m4a", "audio/mp4"),
                 "duration": 41.0}]
    save_audio(owner, page["id"], segments)

    before_files = snapshot_uploads()
    response = owner.get(f"/api/pages/{page['id']}/export",
                         params={"mode": "notes-pdf"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/pdf"
    text = page_text(response.content)
    assert "handwriting, p. 2" in text
    assert "check this step with the tutor" in text
    assert "audio recording · 2 segments · 1:23 total · audio not embedded" in text
    assert "Segment 1 · 0:42" in text and "Segment 2 · 0:41" in text
    assert image_boxes(response.content), "the preview must be a real image on the page"
    # The recording's links are absolute and name the exporting workspace.
    here = workspace_of(OWNER)
    assert sorted(link_targets(response.content)) == sorted(
        f"http://testserver{s['asset']}?ws={here}" for s in segments)
    assert snapshot_uploads() == before_files


def test_notes_pdf_audio_links_resolve_in_the_exporting_workspace(owner, monkeypatch):
    """The whole point, end to end and in a NON-default workspace: the URI a
    reader finds in the downloaded PDF must name the origin, the stored path
    and the exporting workspace — and actually fetch that file there. Fetched
    without ``?ws=`` it must not silently fall back to the reader's default
    workspace, and nothing credential-shaped may ride along."""
    monkeypatch.delenv("GAMMA_PUBLIC_URL", raising=False)
    from gamma import workspaces

    default = workspace_of(OWNER)
    second = workspaces.create("Native PDF second library", OWNER, kind="personal")["id"]
    assert second and second != default
    assert workspaces.default_workspace(OWNER) == default      # really non-default

    audio = m4a_bytes(b"audio recorded in the second workspace")
    page, _ = doc_page(owner, page_pdf(), title="Second library", ws=second)
    url = upload_asset(owner, audio, "m4a", "audio/mp4", ws=second)
    filename = url.rsplit("/", 1)[-1]
    save_audio(owner, page["id"], [{"id": str(uuid.uuid4()), "asset": url,
                                    "duration": 63.0}], ws=second)

    response = owner.get(f"/api/pages/{page['id']}/export",
                         params={"mode": "notes-pdf", "ws": second})
    assert response.status_code == 200, response.text

    # 1. The extracted link is exactly origin + stored path + exporting workspace.
    links = link_targets(response.content)
    assert links == [f"http://testserver/api/assets/{filename}?ws={second}"], links
    assert default not in links[0]
    # 2. No capability of any kind is baked into the file.
    for forbidden in ("share=", "token=", "session=", "sig=", "password="):
        assert forbidden not in links[0]
    assert "-notes.pdf" in response.headers["content-disposition"]

    # 3. Following it with a session returns the recorded bytes, from THAT
    #    workspace; the same path in the default workspace has no such file.
    followed = owner.get(f"/api/assets/{filename}", params={"ws": second})
    assert followed.status_code == 200 and followed.content == audio
    assert owner.get(f"/api/assets/{filename}").status_code == 404

    # 4. And the export itself changed nothing in either library.
    assert dangling_native_references() == []


def test_share_only_export_links_do_not_carry_the_share_token(owner, monkeypatch):
    """Exporting through a view share must not turn the download into a
    capability: the link names the workspace (a reader can be told where the
    audio is) but never the share token, so it grants nothing on its own."""
    monkeypatch.delenv("GAMMA_PUBLIC_URL", raising=False)
    from fastapi.testclient import TestClient
    from gamma.app import app

    page, _ = doc_page(owner, page_pdf(), title="Shared notes")
    url = upload_asset(owner, m4a_bytes(b"shared recording"), "m4a", "audio/mp4")
    save_audio(owner, page["id"], [{"id": str(uuid.uuid4()), "asset": url,
                                    "duration": 9.0}])
    token = owner.post(f"/api/share/{page['id']}",
                       json={"audience": "anyone", "role": "view"}).json()["token"]

    with TestClient(app) as anonymous:
        response = anonymous.get(f"/api/pages/{page['id']}/export",
                                 params={"mode": "notes-pdf", "share": token})
        assert response.status_code == 200, response.text
        links = link_targets(response.content)
        assert links == [f"http://testserver/api/assets/{url.rsplit('/', 1)[-1]}"
                         f"?ws={workspace_of(OWNER)}"], links
        assert token not in links[0] and "share=" not in links[0]
        # …which means the exported link itself grants nothing: no session, no
        # access, even for the viewer who could open the page a moment ago.
        assert anonymous.get(links[0]).status_code in (401, 403)


def test_folder_notes_pdf_writes_the_same_absolute_links(owner, monkeypatch):
    """The folder export shares the builder (one PDF for every page in the
    folder), so it advertises the same absolute, workspace-scoped links."""
    monkeypatch.delenv("GAMMA_PUBLIC_URL", raising=False)
    page, _ = doc_page(owner, page_pdf(), title="In a folder")
    url = upload_asset(owner, m4a_bytes(b"folder recording"), "m4a", "audio/mp4")
    save_audio(owner, page["id"], [{"id": str(uuid.uuid4()), "asset": url,
                                    "duration": 21.0}])
    tagged = owner.put(f"/api/blocks/{page['id']}", json={"properties": {"folder": "Classes"}})
    assert tagged.status_code == 200, tagged.text

    response = owner.get("/api/folders/export",
                         params={"name": "Classes", "mode": "notes-pdf"})
    assert response.status_code == 200, response.text
    assert link_targets(response.content) == [
        f"http://testserver/api/assets/{url.rsplit('/', 1)[-1]}?ws={workspace_of(OWNER)}"]


def test_notes_pdf_audio_links_use_the_configured_public_origin(owner, monkeypatch):
    """``GAMMA_PUBLIC_URL`` wins when a deployment pins its public origin (the
    same knob the MCP endpoints advertise by), including its path prefix."""
    monkeypatch.setenv("GAMMA_PUBLIC_URL", "https://papers.example.com/gamma/")
    page, _ = doc_page(owner, page_pdf(), title="Pinned origin")
    url = upload_asset(owner, m4a_bytes(b"pinned"), "m4a", "audio/mp4")
    save_audio(owner, page["id"], [{"id": str(uuid.uuid4()), "asset": url,
                                    "duration": 30.0}])
    response = owner.get(f"/api/pages/{page['id']}/export", params={"mode": "notes-pdf"})
    assert response.status_code == 200, response.text
    assert link_targets(response.content) == [
        f"https://papers.example.com/gamma/api/assets/{url.rsplit('/', 1)[-1]}"
        f"?ws={workspace_of(OWNER)}"]


def test_notes_pdf_audio_links_keep_a_deployment_root_path(owner, monkeypatch):
    """Served under a mounted root path, the export advertises that path (the
    reader's browser resolves the link against the deployment, not the host
    root). ``request.base_url`` carries the app root path."""
    monkeypatch.delenv("GAMMA_PUBLIC_URL", raising=False)
    from fastapi.testclient import TestClient
    from gamma.app import app

    page, _ = doc_page(owner, page_pdf(), title="Rooted")
    url = upload_asset(owner, m4a_bytes(b"rooted"), "m4a", "audio/mp4")
    save_audio(owner, page["id"], [{"id": str(uuid.uuid4()), "asset": url,
                                    "duration": 12.0}])

    with TestClient(app, root_path="/gamma") as rooted:
        assert rooted.post("/api/login", json={"username": OWNER,
                                               "password": "native-pdf-password"}).status_code == 200
        response = rooted.get(f"/api/pages/{page['id']}/export", params={"mode": "notes-pdf"})
        assert response.status_code == 200, response.text
    assert link_targets(response.content) == [
        f"http://testserver/gamma/api/assets/{url.rsplit('/', 1)[-1]}"
        f"?ws={workspace_of(OWNER)}"]


def test_export_pdf_with_notes_on_the_page_keeps_the_handwriting(owner):
    """``notes=1`` merges a second overlay (the painted note boxes) on top of
    the one carrying the picture: the handwriting must survive both."""
    page, _ = doc_page(owner, page_pdf(crop=CROP, rotate=90))
    preview = upload_asset(owner, png_bytes(alpha=255), "png", "image/png")
    save_native_ink(owner, page["id"], preview)

    response = owner.get(f"/api/pages/{page['id']}/export-pdf", params={"notes": 1})
    assert response.status_code == 200, response.text
    assert response.headers["x-native-ink-drawn"] == "1"
    close_to(colour_box(response.content, (255, 0, 0)), display_box(BOUNDS, CROP, 90))


def test_export_pdf_reports_and_skips_a_native_block_without_a_preview(owner):
    """A broken reference must degrade to "not exported", never to a 400.

    The block deliberately keeps pointing at the file while it is gone, so the
    asset is put back before the test ends — the workspace must not be left
    with a dangling reference for any other test file sharing this worker's
    data directory (``clean_workspace`` asserts exactly that)."""
    page, _ = doc_page(owner, page_pdf())
    url = private_preview(owner)
    save_native_ink(owner, page["id"], url)
    path = asset_file(url)
    stored = path.read_bytes()
    path.unlink()
    try:
        response = owner.get(f"/api/pages/{page['id']}/export-pdf")
        assert response.status_code == 200, response.text
        assert response.headers["x-native-ink-drawn"] == "0"
        assert image_boxes(response.content) == []
    finally:
        # Put the asset back: leaving the workspace with a dangling reference
        # would fail the whole-directory audit the migration fixtures run
        # (tests share one data directory per worker).
        path.write_bytes(stored)
