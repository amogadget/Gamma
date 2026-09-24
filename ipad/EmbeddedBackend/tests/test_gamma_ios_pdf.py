"""Adapter contract tests with an explicitly mocked native bridge.

These do NOT compile PDFKit or prove raster correctness on an Apple device.
Run: python -m unittest discover -s ipad/EmbeddedBackend/tests -p test_gamma_ios_pdf.py
Apple follow-up: real text + scanned/vector/form PDFs, offset crop boxes and
all four rotations; compare asymmetric colored corners / area crops and PDF
user occupancy bounds. Exercise concurrent open/text/render/close and malformed,
locked, large PDFs. Native tests belong to the embedded CPython build, not a
fragile Swift import of an extension absent from the main app target.
"""
import importlib.util
import math
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / "gamma_ios_pdf.py"


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.bridge = types.ModuleType("_gamma_ios_pdf")
        for name in ("open_data", "open_path", "close", "page_count", "page_geometry",
                     "page_text", "render", "occupancy", "outline"):
            setattr(self.bridge, name, Mock())
        self.handle = object()
        self.bridge.open_data.return_value = self.handle
        self.bridge.open_path.return_value = self.handle
        self.bridge.page_count.return_value = 2
        self.bridge.page_geometry.return_value = {
            "crop": (10, 20, 12, 23), "rotation": 90, "width": 3, "height": 2,
        }
        self.bridge.page_text.return_value = "文 café\nexample"
        # Distinct top/bottom rows make channel/order mistakes observable.
        self.pixels = bytes((255, 0, 0, 255)) * 3 + bytes((0, 0, 255, 255)) * 3
        self.bridge.render.return_value = {
            "width": 3, "height": 2, "stride": 12, "n_channels": 4,
            "buffer": self.pixels,
        }
        self.bridge.occupancy.return_value = [(10, 20, 11, 21), (11, 22, 12, 23)]
        spec = importlib.util.spec_from_file_location("gamma_ios_pdf_test_subject", SOURCE)
        self.provider = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"_gamma_ios_pdf": self.bridge}):
            spec.loader.exec_module(self.provider)

    def test_bytes_and_unicode_path_open_actual_bridge(self):
        for source in (b"%PDF-data", bytearray(b"%PDF-data"), memoryview(b"%PDF-data")):
            with self.provider.PdfDocument(source) as doc:
                self.assertEqual(len(doc), 2)
            self.bridge.open_data.assert_called_with(b"%PDF-data")
        with self.provider.PdfDocument(Path("/tmp/文.pdf")):
            pass
        self.bridge.open_path.assert_called_once_with("/tmp/文.pdf")

    def test_missing_native_extension_fails_import(self):
        spec = importlib.util.spec_from_file_location("gamma_ios_pdf_missing_native", SOURCE)
        provider = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"_gamma_ios_pdf": None}):
            with self.assertRaises(ModuleNotFoundError):
                spec.loader.exec_module(provider)

    def test_page_close_invalidates_dependent_text(self):
        with self.provider.PdfDocument(b"pdf") as doc:
            page = doc[0]
            text = page.get_textpage()
            page.close()
            page.close()
            with self.assertRaises(ValueError):
                text.get_text_bounded()
            self.assertEqual(len(doc), 2)

    def test_no_fake_data_when_native_fails(self):
        self.bridge.open_data.side_effect = ValueError("locked PDF")
        with self.assertRaisesRegex(ValueError, "locked"):
            self.provider.PdfDocument(b"%PDF-data")
        self.bridge.open_data.assert_called_once()

    def test_input_cap_checks_before_copy_and_open(self):
        with patch.object(self.provider, "MAX_INPUT_BYTES", 8):
            for source in (b"", b"a" * 9, memoryview(b"a" * 9)):
                with self.assertRaises(ValueError):
                    self.provider.PdfDocument(source)
        self.bridge.open_data.assert_not_called()

    def test_count_bounds_and_rotated_size(self):
        with self.provider.PdfDocument(b"pdf") as doc:
            for index in (-1, 2):
                with self.assertRaises(IndexError):
                    doc[index]
            with doc[0] as page:
                self.assertEqual(page.get_size(), (3, 2))
            with self.assertRaises(ValueError):
                page.get_size()

    def test_text_page_lifetimes_and_unicode(self):
        doc = self.provider.PdfDocument(b"pdf")
        page = doc[1]
        with page.get_textpage() as text:
            self.assertEqual(text.get_text_bounded(), "文 café\nexample")
        with self.assertRaises(ValueError):
            text.get_text_bounded()
        text = page.get_textpage()
        doc.close()
        doc.close()
        self.bridge.close.assert_called_once_with(self.handle)
        for call in (lambda: len(doc), text.get_text_bounded, page.get_size):
            with self.assertRaises(ValueError):
                call()

    def test_context_closes_on_exception(self):
        with self.assertRaises(RuntimeError):
            with self.provider.PdfDocument(b"pdf"):
                raise RuntimeError("caller error")
        self.bridge.close.assert_called_once_with(self.handle)

    def test_rgba_buffer_area_crop_and_bitmap_lifetime(self):
        with self.provider.PdfDocument(b"pdf") as doc:
            with doc[0] as page:
                bitmap = page.render(scale=1, rev_byteorder=True)
        self.assertEqual((bitmap.width, bitmap.height, bitmap.stride, bitmap.n_channels), (3, 2, 12, 4))
        self.assertEqual(bytes(bitmap.buffer), self.pixels)
        # logseq_graph_export uses these exact row/column offsets for crops.
        crop = bytes(bitmap.buffer)[bitmap.stride + 4:bitmap.stride + 8]
        self.assertEqual(crop, bytes((0, 0, 255, 255)))
        bitmap.close()
        with self.assertRaises(ValueError):
            bitmap.to_pil()

    def test_pillow_conversion_preserves_topdown_rgba_when_available(self):
        try:
            import PIL
        except ImportError:
            self.skipTest("Pillow optional")
        with self.provider.PdfDocument(b"pdf") as doc, doc[0] as page, page.render() as bitmap:
            image = bitmap.to_pil()
            self.assertEqual(image.getpixel((0, 0)), (255, 0, 0, 255))
            self.assertEqual(image.getpixel((0, 1)), (0, 0, 255, 255))

    def test_render_caps_and_explicit_rgba_only(self):
        with self.provider.PdfDocument(b"pdf") as doc, doc[0] as page:
            for scale in (0, -1, math.nan, math.inf, 1e300, 4096):
                with self.assertRaises(ValueError):
                    page.render(scale=scale)
            with self.assertRaises(ValueError):
                page.render(rev_byteorder=False)
        self.bridge.render.assert_not_called()

    def test_outline_levels_destinations_and_lifetime(self):
        self.bridge.outline.return_value = [(0, "文 Intro", 0), (1, "Child", 1),
                                            (0, "External", None)]
        with self.provider.PdfDocument(b"pdf") as doc:
            entries = list(doc.get_toc())
            self.assertEqual([(e.level, e.get_title(), e.get_dest().get_index()
                               if e.get_dest() else None) for e in entries],
                             self.bridge.outline.return_value)
        with self.assertRaises(ValueError):
            entries[0].get_title()
        with self.assertRaises(ValueError):
            doc.get_toc()

    def test_crop_validates_and_passes_display_margins_to_native(self):
        self.bridge.page_geometry.return_value.update(width=10000, height=20000)
        with self.provider.PdfDocument(b"pdf") as doc, doc[0] as page:
            page.render(scale=4, crop=(10, 19950, 9950, 20))
            self.bridge.render.assert_called_once_with(self.handle, 0, 4.0,
                                                       10.0, 19950.0, 9950.0, 20.0)
            for crop in ((0, 0, 0), (-1, 0, 0, 0), (math.nan, 0, 0, 0),
                         (0, math.inf, 0, 0), (10000, 0, 0, 0), (0, 0, 0, 20000)):
                with self.assertRaises(ValueError):
                    page.render(crop=crop)
        self.assertEqual(self.bridge.render.call_count, 1)

    def test_zero_crop_is_accepted_for_every_raster(self):
        with self.provider.PdfDocument(b"pdf") as doc, doc[0] as page:
            page.render(crop=(0, 0, 0, 0), rev_byteorder=True)
        self.bridge.render.assert_called_once_with(self.handle, 0, 1.0)

    def test_pixel_product_cap_separate_from_side_cap(self):
        self.bridge.page_geometry.return_value.update(width=3000, height=3000)
        with self.provider.PdfDocument(b"pdf") as doc, doc[0] as page:
            with self.assertRaises(ValueError):
                page.render()
        self.bridge.render.assert_not_called()

    def test_invalid_native_buffer_is_not_accepted(self):
        self.bridge.render.return_value["buffer"] = b"truncated"
        with self.provider.PdfDocument(b"pdf") as doc, doc[0] as page:
            with self.assertRaisesRegex(ValueError, "RGBA"):
                page.render()

    def test_occupancy_preserves_pdf_user_bounds_not_display_bounds(self):
        with self.provider.PdfDocument(b"pdf") as doc, doc[0] as page:
            boxes = [obj.get_bounds() for obj in page.get_objects(max_depth=1)]
            self.assertEqual(boxes, [(10, 20, 11, 21), (11, 22, 12, 23)])
            # Backend's rotation=90 mapper: (y-crop.bottom, x-crop.left).
            l, b, r, t = boxes[0]
            self.assertEqual(((t-20, l-10), (b-20, r-10)), ((1, 0), (0, 1)))
            with self.assertRaises(ValueError):
                page.get_objects(max_depth=2)
        self.bridge.occupancy.assert_called_once_with(self.handle, 0)


if __name__ == "__main__":
    unittest.main()
