#!/usr/bin/env python3
"""Generate a small PDF for manual PDF/Pencil coordinate regression checks.

No third-party dependencies. Usage: python3 scripts/make-coordinate-fixture.py
The PDF contains mixed page sizes, offset crop boxes, and every right-angle
rotation. Import the result through Files; mark each labeled target, zoom,
rotate the iPad, navigate away, and reopen the document.
"""
from pathlib import Path
import argparse


def make_pdf() -> bytes:
    specs = [
        ((0, 0, 612, 792), (0, 0, 612, 792), 0),
        ((0, 0, 792, 612), (0, 0, 792, 612), 0),
        ((0, 0, 612, 792), (40, 60, 572, 732), 0),
        ((0, 0, 612, 792), (40, 60, 572, 732), 90),
        ((0, 0, 612, 792), (40, 60, 572, 732), 180),
        ((0, 0, 612, 792), (40, 60, 572, 732), 270),
    ]
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for index, (media, crop, rotation) in enumerate(specs):
        page_id = len(objects) + 1
        stream_id = page_id + 1
        kids.append(f"{page_id} 0 R")
        x0, y0, x1, y1 = crop
        targets = [(x0 + 35, y0 + 35), (x1 - 35, y0 + 35),
                   (x0 + 35, y1 - 35), (x1 - 35, y1 - 35),
                   ((x0 + x1) / 2, (y0 + y1) / 2)]
        commands = ["0.5 w", "0.3 0.3 0.3 RG"]
        for number, (x, y) in enumerate(targets, 1):
            commands += [f"{x - 10} {y} m {x + 10} {y} l S",
                         f"{x} {y - 10} m {x} {y + 10} l S",
                         f"BT /F1 10 Tf {x - 15} {y + 15} Td (P{index + 1}-T{number}) Tj ET"]
        commands.append(f"BT /F1 12 Tf {x0 + 55} {y0 + 85} Td (Page {index + 1}; rotation {rotation}; crop origin {x0},{y0}) Tj ET")
        stream = "\n".join(commands).encode("ascii")
        box = lambda values: "[" + " ".join(map(str, values)) + "]"
        objects.append((f"<< /Type /Page /Parent 2 0 R /MediaBox {box(media)} "
                        f"/CropBox {box(crop)} /Rotate {rotation} "
                        f"/Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>").encode("ascii"))
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
    objects[1] = f"<< /Type /Pages /Count {len(specs)} /Kids [{' '.join(kids)}] >>".encode()
    result = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    startxref = len(result)
    result.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{startxref}\n%%EOF\n".encode())
    return bytes(result)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", nargs="?", type=Path, default=Path("coordinate-fixture.pdf"))
    args = parser.parse_args()
    args.output.write_bytes(make_pdf())
    print(f"Wrote six-page coordinate fixture to {args.output}")
