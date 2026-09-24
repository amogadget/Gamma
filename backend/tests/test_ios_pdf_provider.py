"""Linux routing/adapter contracts, NOT proof of compiled PDFKit behavior.

The adapter is real; only its _gamma_ios_pdf bridge is mocked. Real native
text, crop/rotation, raster/occupancy and concurrency need Apple validation.
"""
import builtins
import importlib.util
import io
from pathlib import Path
import struct
import sys
import types
from unittest.mock import Mock
import zlib

import pytest
from PyPDF2 import PdfReader, PdfWriter

from gamma import logseq_graph_export, pdf_notes, pdf_provider, pdf_text


@pytest.mark.parametrize("platform,name", [
    ("ios", "gamma_ios_pdf"), ("darwin", "pypdfium2"),
    ("linux", "pypdfium2"), ("win32", "pypdfium2"),
])
def test_explicit_platform_selection(monkeypatch, platform, name):
    native = types.ModuleType("gamma_ios_pdf")
    desktop = types.ModuleType("pypdfium2")
    monkeypatch.setitem(sys.modules, "gamma_ios_pdf", native)
    monkeypatch.setitem(sys.modules, "pypdfium2", desktop)
    monkeypatch.setattr(sys, "platform", platform)
    assert pdf_provider.load_provider() is {"gamma_ios_pdf": native, "pypdfium2": desktop}[name]
    assert sys.modules["pypdfium2"] is desktop  # no compatibility alias


def test_ios_finalizers_never_import_pdfium(monkeypatch):
    real_import = builtins.__import__
    attempted = []

    def guarded(name, *args, **kwargs):
        if name.startswith("pypdfium2"):
            attempted.append(name)
            raise AssertionError("iOS must not import PDFium, even optionally")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(pdf_provider, "is_ios", lambda: True)
    monkeypatch.setattr(builtins, "__import__", guarded)
    pdf_text._serialize_finalizers()
    assert attempted == []  # also detects a swallowed import exception


@pytest.fixture
def native(monkeypatch):
    bridge = types.ModuleType("_gamma_ios_pdf")
    handle = object()
    for name in ("open_data", "open_path", "close", "page_count", "page_geometry",
                 "page_text", "render", "occupancy", "outline"):
        setattr(bridge, name, Mock())
    bridge.open_data.return_value = bridge.open_path.return_value = handle
    bridge.page_count.return_value = 1
    bridge.page_geometry.return_value = {
        "crop": (0, 0, 612, 792), "rotation": 0, "width": 612, "height": 792,
    }
    bridge.page_text.return_value = "文 café native text"
    bridge.occupancy.return_value = [(100, 600, 120, 620)]
    # Asymmetric top/bottom rows pin orientation and RGBA -> RGB handling.
    bridge.render.return_value = {
        "width": 3, "height": 2, "stride": 12, "n_channels": 4,
        "buffer": bytes((255, 0, 0, 255)) * 3 + bytes((0, 0, 255, 255)) * 3,
    }
    source = Path(__file__).resolve().parents[2] / "ipad/EmbeddedBackend/gamma_ios_pdf.py"
    spec = importlib.util.spec_from_file_location("gamma_ios_pdf", source)
    adapter = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "_gamma_ios_pdf", bridge)
    spec.loader.exec_module(adapter)
    monkeypatch.setitem(sys.modules, "gamma_ios_pdf", adapter)
    monkeypatch.setattr(pdf_provider, "is_ios", lambda: True)
    # Make accidental direct imports fail, without ever installing a fake alias.
    real_import = builtins.__import__
    attempted = []

    def guarded(name, *args, **kwargs):
        if name.startswith("pypdfium2"):
            attempted.append(name)
            raise AssertionError("iOS route imported PDFium")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded)
    yield bridge
    assert attempted == []


def blank_pdf():
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def position():
    rect = dict(x1=100, y1=72, x2=300, y2=92, width=612, height=792, pageNumber=1)
    return dict(pageNumber=1, boundingRect=rect, rects=[rect])


def png_rows(data):
    assert data.startswith(b"\x89PNG\r\n\x1a\n")
    offset, compressed = 8, b""
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        if data[offset + 4:offset + 8] == b"IDAT":
            compressed += data[offset + 8:offset + 8 + length]
        offset += 12 + length
    return zlib.decompress(compressed)


def test_text_sizes_count_and_render_route_real_adapter(native, monkeypatch):
    assert pdf_text.extract_pages(b"pdf") == ["文 café native text"]
    assert pdf_text.page_count(b"pdf") == 1
    assert pdf_text.page_sizes(b"pdf") == [(612, 792)]
    # Exercise the production no-Pillow encoder, not a substituted bitmap API.
    monkeypatch.setitem(sys.modules, "PIL", None)
    image, count = pdf_text.render_page(b"pdf", 1, max_side=792)
    data, mime, width, height = image
    assert (count, mime, width, height) == (1, "image/png", 3, 2)
    assert png_rows(data) == b"\0" + bytes((255, 0, 0, 255)) * 3 + b"\0" + bytes((0, 0, 255, 255)) * 3
    native.render.assert_called_once_with(native.open_data.return_value, 0, 1.0)
    assert native.close.call_count == 4


def test_outline_routes_real_adapter(native):
    native.outline.return_value = [(0, " Intro ", 0), (1, "Nested 文", 2),
                                   (0, "External", None), (0, "", 0)]
    assert pdf_text.outline(b"pdf") == [(0, "Intro", 1), (1, "Nested 文", 3)]
    native.outline.assert_called_once_with(native.open_data.return_value)
    native.close.assert_called_once()


def test_region_render_does_not_allocate_huge_full_page(native):
    native.page_geometry.return_value.update(width=10000, height=20000)
    image, count = pdf_text.render_page(b"pdf", 1, box=(.1, .2, .11, .21))
    assert image is not None and count == 1
    args = native.render.call_args.args
    assert args[:3] == (native.open_data.return_value, 0, 4.0)
    assert args[3:] == pytest.approx((1000, 15800, 8900, 4000))


def test_empty_text_is_not_a_fallback(native, monkeypatch):
    native.page_text.return_value = ""
    fallback = Mock(side_effect=AssertionError("scans must not trigger fallback"))
    monkeypatch.setattr("PyPDF2.PdfReader", fallback)
    assert pdf_text.extract_pages(b"pdf") == [""]
    fallback.assert_not_called()
    assert native.close.call_count == 1


def test_native_open_failure_allows_existing_pypdf2_fallback(native):
    native.open_data.side_effect = ValueError("unreadable or locked PDF")
    kind, reader = pdf_text._open(blank_pdf())
    assert kind == "pypdf2" and len(reader.pages) == 1
    assert pdf_text.page_count(blank_pdf()) == 1
    assert pdf_text.page_sizes(blank_pdf()) == [(612, 792)]
    assert pdf_text.render_page(blank_pdf(), 1) == (None, 0)
    # Neither provider nor fallback can invent text or geometry for garbage.
    assert pdf_text.page_count(b"not a PDF") == 0
    assert pdf_text.page_sizes(b"not a PDF") == []


@pytest.mark.parametrize("error", [ModuleNotFoundError("missing bridge"), RuntimeError("broken bridge"),
                                 OSError("native library failed to load")])
def test_ios_installation_errors_are_not_input_fallback(monkeypatch, error):
    monkeypatch.setattr(pdf_provider, "is_ios", lambda: True)
    monkeypatch.setattr(pdf_provider, "load_provider", Mock(side_effect=error))
    fallback = Mock(side_effect=AssertionError("must not hide missing bridge"))
    monkeypatch.setattr("PyPDF2.PdfReader", fallback)
    with pytest.raises(type(error)):
        pdf_text._open(blank_pdf())
    fallback.assert_not_called()


def test_text_failure_after_open_does_not_retry_pypdf2(native, monkeypatch):
    native.page_text.side_effect = ValueError("text operation failed")
    fallback = Mock()
    monkeypatch.setattr("PyPDF2.PdfReader", fallback)
    with pytest.raises(ValueError, match="text operation"):
        pdf_text.extract_pages(b"pdf")
    fallback.assert_not_called()
    native.close.assert_called_once()


def test_notes_occupancy_routes_adapter_writer_stays_pypdf2(native):
    source = blank_pdf()
    output, drawn = pdf_notes.render_notes(source, [{"position": position(), "note": "native route note"}])
    assert drawn == 1
    assert "native route note" in PdfReader(io.BytesIO(output)).pages[0].extract_text()
    native.occupancy.assert_called_once_with(native.open_data.return_value, 0)
    native.close.assert_called_once()
    assert pdf_notes.PdfWriter is PdfWriter


def test_logseq_area_images_route_native_rgba_bitmap(native, tmp_path):
    source = tmp_path / "paper.pdf"
    source.write_bytes(blank_pdf())
    highlights = [{"area": True, "page": 1, "uuid": "area", "stamp": 123,
                   "position": {"boundingRect": dict(x1=1, y1=1, x2=3, y2=2, width=3, height=2)}}]
    images = logseq_graph_export.render_area_images(source, "paper", highlights, scale=1)
    assert len(images) == 1
    name, data = images[0]
    assert name == "assets/paper/1_area_123.png"
    assert struct.unpack(">II", data[16:24]) == (2, 1)
    assert png_rows(data) == b"\0" + bytes((0, 0, 255)) * 2
    native.open_path.assert_called_once_with(str(source))
    native.render.assert_called_once_with(native.open_path.return_value, 0, 1.0)
    native.close.assert_called_once()


def test_desktop_real_pdfium_and_existing_open_fallback(monkeypatch):
    import pypdfium2
    assert pdf_provider.load_provider() is pypdfium2
    source = blank_pdf()
    kind, doc = pdf_text._open(source)
    try:
        assert kind == "pdfium" and isinstance(doc, pypdfium2.PdfDocument)
    finally:
        doc.close()
    assert pdf_text.extract_pages(source) == [""]
    assert pdf_text.page_sizes(source) == [(612, 792)]
    image, count = pdf_text.render_page(source, 1, max_side=79)
    assert image is not None and count == 1
    monkeypatch.setattr(pdf_provider, "load_provider", Mock(side_effect=ImportError("missing PDFium")))
    kind, reader = pdf_text._open(source)
    assert kind == "pypdf2" and len(reader.pages) == 1
