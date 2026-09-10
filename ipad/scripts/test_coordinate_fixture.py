"""Portable structural checks; these do NOT validate PDFKit/PencilKit rendering."""
import importlib.util
from pathlib import Path
import re
import unittest

spec = importlib.util.spec_from_file_location("fixture", Path(__file__).with_name("make-coordinate-fixture.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class CoordinateFixtureTests(unittest.TestCase):
    def test_cross_reference_points_to_each_object(self):
        data = fixture.make_pdf()
        start = int(re.search(rb"startxref\n(\d+)", data).group(1))
        lines = data[start:].splitlines()
        self.assertEqual(lines[0], b"xref")
        count = int(lines[1].split()[1])
        for number, entry in enumerate(lines[3:3 + count - 1], 1):
            offset = int(entry.split()[0])
            self.assertTrue(data[offset:].startswith(f"{number} 0 obj\n".encode()))

    def test_declared_stream_lengths_are_exact(self):
        data = fixture.make_pdf()
        streams = re.findall(rb"<< /Length (\d+) >>\nstream\n(.*?)\nendstream", data, re.S)
        self.assertEqual(len(streams), 6)
        for length, stream in streams:
            self.assertEqual(int(length), len(stream))

    def test_fixture_exercises_coordinate_edge_cases(self):
        data = fixture.make_pdf()
        self.assertEqual(len(re.findall(rb"/Type /Page\b", data)), 6)
        self.assertIn(b"/MediaBox [0 0 792 612]", data)
        self.assertIn(b"/CropBox [40 60 572 732]", data)
        for rotation in (0, 90, 180, 270):
            self.assertIn(f"/Rotate {rotation}".encode(), data)
        for page in range(1, 7):
            for target in range(1, 6):
                self.assertIn(f"(P{page}-T{target})".encode(), data)


if __name__ == "__main__":
    unittest.main()
