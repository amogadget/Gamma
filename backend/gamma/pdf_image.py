"""Uploaded PNG/JPEG → a PDF image XObject, without an imaging library.

Note boxes can contain ``![](/api/uploads/…)`` refs, and an exported note that
shows the URL instead of the picture is useless. Two paths:

* JPEG — embedded verbatim as ``/DCTDecode``; only the SOF header is parsed for
  the size and component count. Zero decoding cost.
* PNG — 8-bit gray/RGB/palette images are *also* embedded verbatim, because
  PDF's ``/Predictor 15`` FlateDecode is exactly PNG's row filtering. Anything
  with an alpha channel (the common case for pasted screenshots) or 16 bits per
  sample is unfiltered here and composited onto white, which is a pure-Python
  pixel loop — hence ``MAX_PIXELS``.

Interlaced (Adam7) PNGs are rejected rather than deinterlaced; browsers don't
produce them for clipboard pastes.
"""

import struct
import zlib

from PyPDF2.generic import (
    ArrayObject,
    ByteStringObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
)

from .logbuf import log
from .markdown_export import UPLOAD_RE

MAX_PIXELS = 2_500_000     # above this the pure-Python unfilter gets too slow
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _stream(data: bytes, width: int, height: int, colorspace, bpc: int,
            filt: str, parms=None) -> DecodedStreamObject:
    img = DecodedStreamObject()
    img.set_data(data)
    img.update({
        NameObject("/Type"): NameObject("/XObject"),
        NameObject("/Subtype"): NameObject("/Image"),
        NameObject("/Width"): NumberObject(width),
        NameObject("/Height"): NumberObject(height),
        NameObject("/ColorSpace"): colorspace,
        NameObject("/BitsPerComponent"): NumberObject(bpc),
        NameObject("/Filter"): NameObject(filt),
    })
    if parms:
        img[NameObject("/DecodeParms")] = parms
    return img


def _jpeg(data: bytes):
    i, n = 2, len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        if marker in _SOF:
            height, width = struct.unpack(">HH", data[i + 5:i + 9])
            comps = data[i + 9]
            space = {1: "/DeviceGray", 3: "/DeviceRGB", 4: "/DeviceCMYK"}.get(comps)
            if not space:
                return None
            return _stream(data, width, height, NameObject(space), 8, "/DCTDecode"), width, height
        i += 2 + length
    return None


def _png_chunks(data: bytes):
    i = 8
    while i + 8 <= len(data):
        length, tag = struct.unpack(">I4s", data[i:i + 8])
        yield tag, data[i + 8:i + 8 + length]
        i += 8 + length + 4


def _unfilter(raw: bytes, height: int, bpp: int, stride: int) -> bytearray:
    """Undo PNG row filters. Sequential by construction — see MAX_PIXELS."""
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        ftype = raw[pos]
        cur = bytearray(raw[pos + 1:pos + 1 + stride])
        pos += 1 + stride
        if ftype == 1:
            for i in range(bpp, stride):
                cur[i] = (cur[i] + cur[i - bpp]) & 255
        elif ftype == 2:
            for i in range(stride):
                cur[i] = (cur[i] + prev[i]) & 255
        elif ftype == 3:
            for i in range(stride):
                left = cur[i - bpp] if i >= bpp else 0
                cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 255
        elif ftype == 4:
            for i in range(stride):
                a = cur[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                cur[i] = (cur[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out += cur
        prev = cur
    return out


def _to_rgb(samples: bytearray, width: int, height: int, ctype: int, depth: int) -> bytes:
    """Decoded samples → packed RGB, alpha composited onto white."""
    step = depth // 8
    chans = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    stride = width * chans * step
    out = bytearray(width * height * 3)
    o = 0
    for y in range(height):
        row = y * stride
        for x in range(width):
            p = row + x * chans * step
            if ctype in (0, 4):
                g = samples[p]
                r = b = g
                alpha = samples[p + step] if ctype == 4 else 255
            else:
                r, g, b = samples[p], samples[p + step], samples[p + 2 * step]
                alpha = samples[p + 3 * step] if ctype == 6 else 255
            if alpha != 255:
                inv = 255 - alpha
                r = (r * alpha + 255 * inv) // 255
                g = (g * alpha + 255 * inv) // 255
                b = (b * alpha + 255 * inv) // 255
            out[o] = r
            out[o + 1] = g
            out[o + 2] = b
            o += 3
    return bytes(out)


def _png(data: bytes):
    header, idat, plte = None, bytearray(), None
    for tag, body in _png_chunks(data):
        if tag == b"IHDR":
            header = struct.unpack(">IIBBBBB", body[:13])
        elif tag == b"IDAT":
            idat += body
        elif tag == b"PLTE":
            plte = body
        elif tag == b"IEND":
            break
    if not header or not idat:
        return None
    width, height, depth, ctype, _comp, _filt, interlace = header
    if interlace or width * height > MAX_PIXELS:
        return None

    if depth == 8 and ctype in (0, 2, 3):
        # Verbatim: /Predictor 15 makes the viewer undo the PNG row filters.
        colors = {0: 1, 2: 3, 3: 1}[ctype]
        if ctype == 3:
            if not plte:
                return None
            # ByteStringObject, NOT create_string_object: a text string gets
            # re-encoded (UTF-16 once a byte isn't PDFDocEncodable), which
            # scrambles the palette and paints the image a solid colour.
            space = ArrayObject([NameObject("/Indexed"), NameObject("/DeviceRGB"),
                                 NumberObject(len(plte) // 3 - 1),
                                 ByteStringObject(plte)])
        else:
            space = NameObject("/DeviceGray" if ctype == 0 else "/DeviceRGB")
        parms = DictionaryObject({
            NameObject("/Predictor"): NumberObject(15),
            NameObject("/Colors"): NumberObject(colors),
            NameObject("/BitsPerComponent"): NumberObject(8),
            NameObject("/Columns"): NumberObject(width),
        })
        return _stream(bytes(idat), width, height, space, 8, "/FlateDecode", parms), width, height

    if depth not in (8, 16) or ctype not in (0, 2, 4, 6):
        return None
    chans = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    bpp = max(1, chans * depth // 8)
    stride = width * chans * depth // 8
    samples = _unfilter(zlib.decompress(bytes(idat)), height, bpp, stride)
    rgb = _to_rgb(samples, width, height, ctype, depth)
    return (_stream(zlib.compress(rgb, 6), width, height, NameObject("/DeviceRGB"),
                    8, "/FlateDecode"), width, height)


def image_xobject(path):
    """Image file → (XObject stream, pixel width, pixel height), or None when
    the format isn't one we can embed. Never raises: a broken image must not
    take the whole export down with it."""
    try:
        data = path.read_bytes()
        if data[:8] == _PNG_MAGIC:
            return _png(data)
        if data[:2] == b"\xff\xd8":
            return _jpeg(data)
    except Exception as e:
        log.warning(f"[pdf-image] could not embed {getattr(path, 'name', path)}: {e}")
    return None


class XObjectStore:
    """Uploaded images referenced by notes → PDF XObjects, one per file.

    Both PDF writers embed the same pasted pictures, so both register them
    here: ``resolve`` maps an ``/api/uploads/…`` reference to the
    ``(resource name, pixel width, pixel height)`` the caller draws with, and
    ``refs`` holds the indirect objects for the page's /XObject dictionary.
    Unresolvable refs are remembered as ``None`` so a broken image is looked
    up (and logged) once.
    """

    def __init__(self, writer, uploads_dir):
        self.writer, self.dir = writer, uploads_dir
        self.by_src = {}        # src → (name, px_w, px_h) or None
        self.refs = {}          # name → indirect object

    def resolve(self, src: str):
        if src in self.by_src:
            return self.by_src[src]
        info = None
        match = UPLOAD_RE.search(src or "")
        if match and self.dir is not None:
            path = self.dir / match.group(1)
            if path.is_file():
                built = image_xobject(path)
                if built:
                    stream, px_w, px_h = built
                    name = f"GmIm{len(self.refs)}"
                    self.refs[name] = self.writer._add_object(stream)
                    info = (name, px_w, px_h)
                else:
                    log.info(f"[pdf-image] unsupported image format: {match.group(1)}")
        self.by_src[src] = info
        return info
