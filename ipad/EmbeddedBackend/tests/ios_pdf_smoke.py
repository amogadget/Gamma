"""Run as an embedded-iOS test module, not a host/mock test."""
import concurrent.futures
import sys
import gamma_ios_pdf as pdf


def document(rotation=0, huge=False):
    # Deliberately offset crop and asymmetric colored shapes plus searchable text.
    stream = b"1 0 0 rg 30 40 40 30 re f 0 0 1 rg 170 250 20 20 re f BT /F1 14 Tf 50 160 Td (Gamma local Pencil Audio) Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 340] /CropBox [20 30 220 330] /Rotate %d /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>" % rotation).encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 2 >>",
        b"<< /Title (Parent) /Parent 6 0 R /Dest [3 0 R /Fit] /First 8 0 R /Last 8 0 R /Count 1 >>",
        b"<< /Title (Child) /Parent 7 0 R /A << /S /GoTo /D [3 0 R /Fit] >> >>",
    ]
    if huge:
        objects[2] = objects[2].replace(b"[0 0 240 340]", b"[0 0 10000 20000]").replace(
            b"[20 30 220 330]", b"[0 0 10000 20000]")
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for n, obj in enumerate(objects, 1):
        offsets.append(len(output)); output.extend(f"{n} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for off in offsets[1:]: output.extend(f"{off:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)


def check(rotation):
    with pdf.PdfDocument(document(rotation)) as doc:
        assert len(doc) == 1
        assert [(e.level, e.get_title(), e.get_dest().get_index()) for e in doc.get_toc()] == [
            (0, "Parent", 0), (1, "Child", 0)]
        with doc[0] as page:
            assert page.get_size() == ((300, 200) if rotation in (90, 270) else (200, 300))
            with page.get_textpage() as text:
                assert "Gamma local Pencil Audio" in text.get_text_bounded()
            with page.render(scale=1, rev_byteorder=True) as image:
                assert image.n_channels == 4 and len(image.buffer) == image.stride * image.height
                reds = [(x, y) for y in range(image.height) for x in range(image.width)
                        if image.buffer[y * image.stride + x * 4] > 200
                        and image.buffer[y * image.stride + x * 4 + 1] < 60
                        and image.buffer[y * image.stride + x * 4 + 2] < 60]
                assert len(reds) > 1000, (rotation, len(reds))
                xs, ys = zip(*reds)
                center = (sum(xs) / len(xs), sum(ys) / len(ys))
                expected = {0: (30, 275), 90: (25, 30), 180: (170, 25), 270: (275, 170)}[rotation]
                assert all(abs(a-b) < 2 for a,b in zip(center, expected)), (rotation, center, expected)
            # A rectangular render must equal slicing the same-scale full raster,
            # including rotated, offset page boxes and nonzero margins on all sides.
            with page.render(scale=2) as full, page.render(scale=2, crop=(7, 11, 13, 17)) as cropped:
                assert (cropped.width, cropped.height) == (full.width - 40, full.height - 56)
                expected_pixels = b"".join(full.buffer[y * full.stride + 14 * 4:
                    y * full.stride + (full.width - 26) * 4]
                    for y in range(34, full.height - 22))
                assert cropped.buffer == expected_pixels, rotation
            cells = [o.get_bounds() for o in page.get_objects(max_depth=1)]
            assert cells, rotation
            assert all(20 <= l < r <= 220 and 30 <= b < t <= 330 for l,b,r,t in cells)
            assert any(l <= 50 <= r and b <= 55 <= t for l,b,r,t in cells), (rotation, "red region missing")
    return rotation


assert sys.platform == "ios", "This smoke must run inside iOS CPython"
for angle in (0, 90, 180, 270): check(angle)
with pdf.PdfDocument(document(huge=True)) as doc, doc[0] as page:
    # Full page at 4x exceeds both caps; only this 50x60 PDF-unit region is allocated.
    with page.render(scale=4, crop=(20, 19920, 9930, 20)) as image:
        assert (image.width, image.height) == (200, 240)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    assert list(pool.map(check, (90, 0, 270, 180))) == [90, 0, 270, 180]
try:
    pdf.PdfDocument(b"not a PDF")
except ValueError:
    pass
else:
    raise AssertionError("Malformed PDF was accepted")
print("GAMMA_IOS_PDF_SMOKE_OK: real PDFKit text, rotated crop pixels, occupancy and concurrent calls", flush=True)
