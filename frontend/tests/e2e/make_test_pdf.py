#!/usr/bin/env python3
"""Generate a small multi-page PDF with a real text layer for the smoke test.

Pure stdlib (no pypdfium2/pikepdf), so it runs anywhere Python is available.
Each page paints several lines of selectable Helvetica text so the highlight
and text-selection flows have something to grab.
"""
import sys


def build_text_pdf(pages=4, lines_per_page=8):
    def content_stream(prefix):
        ops = ["BT", "/F1 12 Tf", "72 720 Td"]
        for i in range(lines_per_page):
            ops.append(f"({prefix} line {i + 1}: the quick brown fox jumps over the lazy dog) Tj")
            ops.append("0 -24 Td")
        ops.append("ET")
        return " ".join(ops).encode()

    # 1-based object table; index 0 is a placeholder.
    objects = [b""]
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(pages))
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {pages} >>".encode())
    font_obj = 3 + pages * 2
    for i in range(pages):
        page_num = 3 + i * 2
        content_num = page_num + 1
        stream = content_stream(f"page{i + 1}")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_num} 0 R "
            f"/Resources << /Font << /F1 {font_obj} 0 R >> >> >>".encode()
        )
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = [b"%PDF-1.4\n"]
    offsets = [0] * len(objects)
    for i in range(1, len(objects)):
        offsets[i] = sum(len(x) for x in out)
        out.append(f"{i} 0 obj\n".encode() + objects[i] + b"\nendobj\n")
    xref_pos = sum(len(x) for x in out)
    out.append(f"xref\n0 {len(objects)}\n".encode())
    out.append(b"0000000000 65535 f \n")
    for i in range(1, len(objects)):
        out.append(f"{offsets[i]:010d} 00000 n \n".encode())
    out.append(
        f"trailer\n<< /Size {len(objects)} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    )
    return b"".join(out)


if __name__ == "__main__":
    out_path = sys.argv[1] if len(sys.argv) > 1 else "test.pdf"
    pages = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    with open(out_path, "wb") as f:
        f.write(build_text_pdf(pages=pages))
    print(out_path)
