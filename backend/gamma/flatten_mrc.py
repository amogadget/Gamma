"""Flatten MRC (mixed raster content) scans into one image per page.

Scanners that produce "searchable PDF" often store each page as two JPEG 2000
layers plus a **stencil mask at several times the layers' resolution** — the
text shapes need the resolution, the colours don't. It compresses beautifully
and renders terribly: pdf.js composites a masked image at the MASK's size, so a
1438x2122 foreground with a 5750x8489 mask becomes a 48.8 MP / 195 MB RGBA
bitmap. Measured on one such book that is ~2.0 s per page, every time the page
is drawn, and it is far over pdf.js's MAX_IMAGE_SIZE_TO_CACHE (10 MB decoded)
so the result is thrown away 5 s after each render and rebuilt on the next.

Deleting the mask on a copy dropped the worker's stall from 2058 ms to 74 ms —
that measurement is what this module acts on.

The rewrite is deliberately surgical. Only the image-bearing Form XObject is
replaced, with a single flat JPEG rendered by pdfium (which composites the
layers correctly, and skips the invisible OCR text because render mode 3 draws
nothing). The page's own content stream — the OCR text layer that search, text
selection and highlight anchoring all depend on — is never touched.
"""

import io

from .logbuf import log
from .pdfium_lock import PDFIUM_LOCK

# A mask only matters once the composite it forces is big enough to hurt.
# pdf.js turns the composite into RGBA, so this is ~4 bytes per pixel; 4 MP is
# 16 MB, already past the point where it is dropped from the cache.
MASK_PIXELS_TRIGGER = 4_000_000

# Rendered page width in pixels. 1280 keeps the decoded RGBA under pdf.js's
# 10 MB MAX_IMAGE_SIZE_TO_CACHE, which is what lets it keep the bitmap between
# renders; wider is sharper but is re-decoded on every draw.
DEFAULT_WIDTH = 1280
DEFAULT_QUALITY = 62


def _images_in(resources, depth=0):
    """Every image XObject reachable from a resource dict, Forms included."""
    out = []
    xo = resources.get("/XObject") if resources is not None else None
    if xo is None:
        return out
    for name, obj in xo.items():
        try:
            subtype = str(obj.get("/Subtype"))
        except Exception:
            continue
        if subtype == "/Image":
            out.append((name, obj))
        elif subtype == "/Form" and depth < 3 and "/Resources" in obj:
            out += _images_in(obj["/Resources"], depth + 1)
    return out


def mask_burden(pdf) -> int:
    """Largest stencil-mask pixel count in the document, 0 if it has none.

    Sampling: scanners apply the same structure to every page, so a handful of
    pages settles it without decoding the whole file.
    """
    worst = 0
    n = len(pdf.pages)
    for idx in {0, n // 4, n // 2, (3 * n) // 4, n - 1}:
        if idx < 0 or idx >= n:
            continue
        try:
            resources = pdf.pages[idx].get("/Resources")
        except Exception:
            continue
        for _, img in _images_in(resources):
            for key in ("/Mask", "/SMask"):
                m = img.get(key)
                if m is None or not hasattr(m, "get"):
                    continue
                try:
                    worst = max(worst, int(m.Width) * int(m.Height))
                except Exception:
                    pass
    return worst


def needs_flattening(path) -> bool:
    """True when this PDF carries oversized stencil masks."""
    try:
        import pikepdf

        with pikepdf.open(str(path)) as pdf:
            return mask_burden(pdf) >= MASK_PIXELS_TRIGGER
    except Exception as e:
        log.debug("flatten check failed for %s: %s", path, e)
        return False


def _form_to_replace(page):
    """The Form XObject holding the masked images, or None.

    Only a page whose images all live in one Form is rewritten — that is the
    shape these scanners emit, and anything else is left alone rather than
    guessed at.
    """
    resources = page.get("/Resources")
    xo = resources.get("/XObject") if resources is not None else None
    if xo is None:
        return None
    forms = []
    for name, obj in xo.items():
        try:
            subtype = str(obj.get("/Subtype"))
        except Exception:
            return None
        if subtype == "/Image":
            return None  # images drawn straight onto the page: not our shape
        if subtype == "/Form":
            forms.append((name, obj))
    if len(forms) != 1:
        return None
    name, form = forms[0]
    imgs = _images_in(form.get("/Resources"))
    if not imgs:
        return None
    if not any(img.get("/Mask") is not None or img.get("/SMask") is not None for _, img in imgs):
        return None
    return form


def flatten(src_path, dst_path, width=DEFAULT_WIDTH, quality=DEFAULT_QUALITY, progress=None) -> bool:
    """Write a flattened copy of src_path. False when nothing was rewritten."""
    import pikepdf
    import pypdfium2 as pdfium
    from PIL import Image  # noqa: F401  (pdfium hands back a PIL image)

    pdf = pikepdf.open(str(src_path))
    total = len(pdf.pages)

    # Pass 1 (pikepdf only): which pages carry a mask-bearing Form to replace.
    candidates = []  # (page_index, form, bw, bh, x0, y0)
    progress_pages = set()  # page indices that advance the progress report
    for i, page in enumerate(pdf.pages):
        form = _form_to_replace(page)
        if form is None:
            continue
        try:
            bbox = form.get("/BBox")
            bw = float(bbox[2]) - float(bbox[0])
            bh = float(bbox[3]) - float(bbox[1])
            if bw <= 0 or bh <= 0:
                continue
            candidates.append((i, form, bw, bh, float(bbox[0]), float(bbox[1])))
            progress_pages.add(i)
        except Exception as e:
            log.warning("flatten: page %d left as-is (%s)", i + 1, e)
            progress_pages.add(i)

    if not candidates:
        pdf.close()
        return False

    # Pass 2 (pdfium, under the lock): render each candidate page to a PIL
    # image. Only the native calls hold the lock; the JPEG encode and the
    # pikepdf rewrite below run outside it.
    rendered = []  # (page_index, form, bw, bh, x0, y0, img)
    with PDFIUM_LOCK:
        render_doc = pdfium.PdfDocument(str(src_path))
        try:
            for i, form, bw, bh, x0, y0 in candidates:
                try:
                    rp = render_doc[i]
                    pw, _ph = rp.get_size()
                    if pw <= 0:
                        progress_pages.discard(i)  # original loop `continue`s here
                        continue
                    bitmap = rp.render(scale=width / pw, grayscale=True)
                    rendered.append((i, form, bw, bh, x0, y0, bitmap.to_pil()))
                except Exception as e:
                    log.warning("flatten: page %d left as-is (%s)", i + 1, e)
        finally:
            try:
                render_doc.close()
            except Exception:
                pass

    # Pass 3 (Pillow + pikepdf, no pdfium): encode and rewrite each page.
    rewritten = 0
    for i, form, bw, bh, x0, y0, img in rendered:
        try:
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=quality, optimize=True)
            data = buf.getvalue()

            stream = pikepdf.Stream(pdf, data)
            stream.Type = pikepdf.Name("/XObject")
            stream.Subtype = pikepdf.Name("/Image")
            stream.Width, stream.Height = img.size
            stream.ColorSpace = pikepdf.Name("/DeviceGray")
            stream.BitsPerComponent = 8
            stream.Filter = pikepdf.Name("/DCTDecode")

            form.write(
                f"q {bw:.4f} 0 0 {bh:.4f} {x0:.4f} {y0:.4f} cm /ImFlat Do Q".encode()
            )
            form.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(ImFlat=stream))
            rewritten += 1
        except Exception as e:
            log.warning("flatten: page %d left as-is (%s)", i + 1, e)

    # Progress mirrors the original single loop: every candidate page advances
    # it — whether it rendered/rewrote or was logged as left-as-is — while a
    # skipped page (bad bbox/pw) does not. Emitted after the rewrite, in
    # ascending page order, matching the original callback sequence.
    if progress:
        for i in sorted(progress_pages):
            if (i + 1) % 25 == 0:
                progress(i + 1, total)

    if not rewritten:
        pdf.close()
        return False
    pdf.save(str(dst_path), linearize=False)
    pdf.close()
    return True
