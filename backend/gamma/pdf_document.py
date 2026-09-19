"""A note page typeset as a fresh PDF ("Notes as PDF" export).

``pdf_export``/``pdf_notes`` write *onto a paper*: highlights become
annotations, notes get painted into the free space around them. This module is
the other direction — the notes themselves as a document. It takes the block
subtrees the export driver walks (a note page, a paper's notes, or a whole
folder of them) and lays them out as a real PDF: title and metadata, nested
bullets, headings, quotes, code, tables of pasted images, typeset math.

No font file is embedded and no imaging or PDF-generation library is used:
``pdf_typeset`` measures and draws with the fonts every viewer has built in,
``vector_text`` + ``pdf_glyphs`` turn LaTeX and CJK into Type 3 text built
from glyph outlines, and ``pdf_image`` embeds the pasted uploads as image
XObjects — the same machinery the note boxes use.

Blocks carry markdown, so each block's content is parsed twice over: into
*chunks* (headings, paragraphs, quotes, list items, todos, fenced code, rules,
images, display math — the constructs the block editor renders live) and then
each chunk's text into styled inline spans (bold, italic, code, strike,
``==marked==``, links, ``$…$`` math). Links become real /Link annotations and
page titles become PDF bookmarks, so a folder export is navigable.

The two native (iPad) block kinds are here too, each rendered as what it
actually is (docs/dev/handwriting.md): a ``type: "pdf_ink"`` annotation shows
its readable picture — the high-resolution per-stroke replay derivative when
one exists, else the whole-block PNG preview, never strokes invented from a
raster, since Apple's PKDrawing cannot be opened here — under a caption naming
its page; a ``type: "audio"`` recording becomes its segment durations and links
to the stored ``.m4a`` files, because a PDF has no player and embedding audio
would only pretend otherwise. A downloaded document has no origin of its own, so
those links go through ``render_document``'s ``asset_link`` resolver: the export
endpoint passes ``absolute_asset_link``, and every link comes out absolute and
naming the workspace the export was made in (see that helper — no credentials,
and never a share token).

The whole page is drawn in ``pdf_typeset``'s y-down frame and flipped into user
space by one ``cm`` at the top of the content stream.
"""

import io
import re
from urllib.parse import quote

from PyPDF2 import PdfWriter
from PyPDF2.generic import DecodedStreamObject, DictionaryObject, NameObject

from . import vector_text
from .logbuf import log
from .native_ink import AUDIO_REF_RE
from .note_markup import MATH, TEXT, latex_spans
from .pdf_export import native_ink_image, native_ink_picture, parse_css_color
from .pdf_glyphs import GlyphFonts
from .pdf_image import XObjectStore
from .pdf_typeset import (
    BOLD,
    CODE_BG,
    HELV,
    ITALIC,
    LINK,
    MARK,
    MONO,
    PLAIN,
    STRIKE,
    Style,
    TEXT_COLOR,
    draw_spans,
    fill_rect,
    font_resources,
    line_metrics,
    merge,
    num,
    plain,
    resolve,
    span_width,
    spans_width,
    styled,
    wrap,
)

PAGE_W, PAGE_H = 595.28, 841.89          # A4
MARGIN_X = 56.0
MARGIN_TOP = 54.0
MARGIN_BOTTOM = 58.0
BODY_SIZE = 10.0
CODE_SIZE = 8.8
SMALL_SIZE = 8.2
TITLE_SIZE = 19.0
LEADING = 1.45                           # × font size, roomier than a note box
HEADING_SIZES = {1: 15.5, 2: 13.4, 3: 11.8, 4: 11.0, 5: 10.4, 6: 10.0}
INDENT = 15.0                            # per nesting level
MAX_INDENT_LEVELS = 8                    # deeper blocks stop marching right
BULLET_GAP = 8.5                         # bullet dot to text
BULLET_R = 1.15
QUOTE_PAD = 9.0                          # quote text inset from the bar
QUOTE_BAR = 2.4
CODE_PAD = 4.0
IMAGE_GAP = 4.0
PX_PT = 0.75                             # CSS px → pt: pasted screenshots are 96 dpi
DISPLAY_MATH_SCALE = 1.25
PARA_GAP = 2.5                           # between chunks of one block
BLOCK_GAP = 1.5                          # between sibling blocks
SECTION_GAP = 7.0                        # above a heading

MUTED = (0.45, 0.46, 0.51)
QUOTE_COLOR = (0.28, 0.29, 0.33)
RULE_COLOR = (0.80, 0.81, 0.84)
EMBED_BAR = (0.62, 0.68, 0.80)           # ![[synced block]] cards
TABLE_SIZE = 9.2
TABLE_PAD_X, TABLE_PAD_Y = 5.0, 3.2
TABLE_BORDER = (0.78, 0.79, 0.82)
TABLE_HEAD_BG = (0.955, 0.955, 0.962)
CODE_PAD_X, CODE_PAD_Y = 6.0, 5.0
CODE_BORDER = (0.84, 0.85, 0.87)
_CODE_STYLE = Style(MONO, None)

_FENCE_RE = re.compile(r"^\s*```")
_RULE_RE = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*)$")
_QUOTE_RE = re.compile(r"^\s{0,3}>\s?(.*)$")
_CALLOUT_RE = re.compile(r"^\[!(\w+)\][+-]?\s*(.*)$")
_TODO_RE = re.compile(r"^(\s*)(?:([-*+])\s+)?\[([ xX])\]\s+(.*)$")
_LIST_RE = re.compile(r"^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$")
# An ![](…) image — sized Obsidian-style (``![alt|300](url)``) or with the
# legacy Logseq ``{:width N}`` suffix — or an ![[id]] synced-block embed;
# each leaves the text flow as its own chunk.
_MEDIA_RE = re.compile(
    r"!\[(?P<alt>[^\]]*)\]\(\s*(?P<src>[^)\s]+)[^)]*\)(?:\{:width\s+(?P<pxw>\d+)\})?"
    r"|!\[\[(?P<refid>[a-zA-Z0-9_-]+)\]\]")
_ALT_WIDTH_RE = re.compile(r"(.*?)\|(\d+)(?:x\d+)?$")
_DELIM_CELL_RE = re.compile(r":?-+:?")

# One pass over a line of markdown. Order matters: ** before *, ![[ before [[.
_INLINE_RE = re.compile(
    r"(?P<code>``[^`]+``|`[^`\n]+`)"
    r"|(?P<dmath>\$\$[^\n]+?\$\$)"
    r"|(?P<math>\$[^$\n]+?\$|\\\([^\n]+?\\\))"
    r"|(?P<bold>\*\*(?=\S).+?(?<=\S)\*\*|__(?=\S).+?(?<=\S)__)"
    r"|(?P<italic>\*(?=\S)[^*\n]+?(?<=\S)\*|(?<![\w_])_(?=\S)[^_\n]+?(?<=\S)_(?![\w_]))"
    r"|(?P<strike>~~(?=\S).+?(?<=\S)~~)"
    r"|(?P<mark>==(?=\S).+?(?<=\S)==)"
    r"|(?P<embed>!\[\[[^\]]+\]\])"
    r"|(?P<ref>\[\[[^\]]+\]\])"
    r"|(?P<link>\[[^\]]*\]\(\s*[^)\s]+[^)]*\))"
    r"|(?P<url>https?://[^\s<>()\[\]]+)"
)
_LINK_PARTS = re.compile(r"\[([^\]]*)\]\(\s*([^)\s]+)")
_WRAPPERS = {"bold": 2, "italic": 1, "strike": 2, "mark": 2}
_BITS = {"bold": BOLD, "italic": ITALIC, "strike": STRIKE, "mark": MARK}


# --- markdown → chunks -------------------------------------------------------

def _ref_label(name: str, resolver) -> str:
    """What a [[ref]] chip reads as: the referenced block's first line when the
    resolver knows it (same as the editor), the raw id otherwise."""
    if resolver:
        ref = resolver(name)
        first = ((ref or {}).get("content") or "").strip().split("\n")[0].strip()
        if first:
            return first[:80]
    return name


def inline(text: str, style: Style = PLAIN, resolver=None):
    """One line of markdown → styled spans (see pdf_typeset for the shape)."""
    out, pos = [], 0
    for m in _INLINE_RE.finditer(text):
        if m.start() > pos:
            out.append((TEXT, text[pos:m.start()], 0, style))
        pos = m.end()
        which = m.lastgroup
        body = m.group(which)
        if which == "code":
            out.append((TEXT, body.strip("`"), 0, styled(style, MONO)))
        elif which in ("math", "dmath"):
            tex = body.strip("$").strip() if body[0] == "$" else body[2:-2].strip()
            if tex:
                out.append((MATH, tex, 0, style))
        elif which in _WRAPPERS:
            marks = _WRAPPERS[which]
            out.extend(inline(body[marks:-marks], styled(style, _BITS[which]), resolver))
        elif which in ("embed", "ref"):
            # A page reference can't be followed outside Gamma; it still reads
            # as a reference — with the referenced block's text when the
            # resolver knows it — in link colour without a target.
            name = body.strip("![]").split("|")[0].strip()
            out.append((TEXT, _ref_label(name, resolver), 0, Style(style.bits | LINK, None)))
        elif which == "link":
            label, href = _LINK_PARTS.match(body).groups()
            out.extend(inline(label or href, styled(style, LINK, href=href), resolver))
        else:                                    # bare URL
            out.append((TEXT, body, 0, styled(style, LINK, href=body)))
    if pos < len(text):
        out.append((TEXT, text[pos:], 0, style))
    return merge(out)


def _text_chunks(text: str, style: Style, resolver=None, **extra):
    """A line of prose → its text chunk plus a chunk per ``![](…)`` image and
    per ``![[id]]`` synced-block embed."""
    chunks, pos = [], 0
    for m in _MEDIA_RE.finditer(text):
        head = text[pos:m.start()]
        if head.strip():
            chunks.append({"kind": "text", "spans": inline(head, style, resolver), **extra})
        if m.group("refid"):
            chunks.append({"kind": "embed", "id": m.group("refid")})
        else:
            alt, pxw = m.group("alt"), m.group("pxw")
            pipe = _ALT_WIDTH_RE.fullmatch(alt or "")
            if pipe:                             # Obsidian ![alt|300](url)
                alt, pxw = pipe.group(1), pxw or pipe.group(2)
            chunks.append({"kind": "image", "src": m.group("src"), "alt": alt,
                           "px_w": int(pxw) if pxw else None})
        pos = m.end()
    tail = text[pos:]
    if tail.strip() or not chunks:
        chunks.append({"kind": "text", "spans": inline(tail, style, resolver), **extra})
    return chunks


def _split_row(line: str):
    """A GFM table row → its trimmed cells (outer pipes dropped, ``\\|`` kept
    as a literal pipe)."""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", s)]


def chunks(md: str, resolver=None):
    """A block's markdown → the drawable chunks, in order.

    ``text`` chunks carry spans plus the flags the canvas draws them with
    (``quote``, ``todo``, ``bullet``, ``heading``); ``image``, ``embed``,
    ``table``, ``math``, ``code`` and ``rule`` are their own kinds. Blank
    lines become ``gap``. ``resolver`` (id → {content, page_title} or None)
    gives [[refs]] their referenced text.
    """
    lines = (md or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out, i = [], 0
    while i < len(lines):
        line, stripped = lines[i], lines[i].strip()
        if _FENCE_RE.match(line):                       # fenced code
            body, i = [], i + 1
            while i < len(lines) and not _FENCE_RE.match(lines[i]):
                body.append(lines[i])
                i += 1
            out.append({"kind": "code", "lines": body})
            i += 1
            continue
        if stripped.startswith("$$"):                   # display math, maybe multi-line
            rest = stripped[2:]
            if rest.endswith("$$") and rest[:-2].strip():
                tex, i = rest[:-2], i + 1
            else:
                parts, i = [rest], i + 1
                while i < len(lines) and "$$" not in lines[i]:
                    parts.append(lines[i])
                    i += 1
                if i < len(lines):
                    parts.append(lines[i].split("$$")[0])
                    i += 1
                tex = "\n".join(parts)
            if tex.strip():
                out.append({"kind": "math", "tex": tex.strip()})
            continue
        if "|" in stripped and i + 1 < len(lines):      # GFM table
            delim = _split_row(lines[i + 1])
            head = _split_row(stripped)
            if ("-" in lines[i + 1] and len(delim) == len(head)
                    and all(_DELIM_CELL_RE.fullmatch(c) for c in delim)):
                aligns = [("center" if c.startswith(":") and c.endswith(":")
                           else "right" if c.endswith(":") else "left") for c in delim]
                rows = [[inline(c, Style(BOLD, None), resolver) for c in head]]
                i += 2
                while i < len(lines) and "|" in lines[i] and lines[i].strip():
                    rows.append([inline(c, PLAIN, resolver) for c in _split_row(lines[i])])
                    i += 1
                out.append({"kind": "table", "rows": rows, "aligns": aligns})
                continue
        i += 1
        if not stripped:
            out.append({"kind": "gap"})
            continue
        if _RULE_RE.match(line):
            out.append({"kind": "rule"})
            continue
        heading = _HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            out += _text_chunks(heading.group(2), Style(BOLD, None), resolver, heading=level)
            continue
        quote = _QUOTE_RE.match(line)
        if quote:
            body = quote.group(1)
            callout = _CALLOUT_RE.match(body.strip())
            if callout:                                 # > [!note] Title
                title = callout.group(2).strip() or callout.group(1).title()
                out.append({"kind": "text", "spans": inline(title, Style(BOLD, None), resolver),
                            "quote": True})
                continue
            out += _text_chunks(body, Style(ITALIC, None), resolver, quote=True)
            continue
        todo = _TODO_RE.match(line)
        if todo:
            lead, marker, box, body = todo.groups()
            # "- [ ] x" is a list item too, so it lines up with its neighbours.
            out += _text_chunks(body, PLAIN, resolver, todo=box.lower() == "x",
                                sub=len(lead) // 2 + 1 if marker else 0)
            continue
        item = _LIST_RE.match(line)
        if item:
            marker = item.group(2)
            # "" = a dot; a numbered marker keeps its number.
            out += _text_chunks(item.group(3), PLAIN, resolver,
                                bullet=marker if marker[:1].isdigit() else "",
                                sub=len(item.group(1)) // 2 + 1)
            continue
        out += _text_chunks(line.strip(), PLAIN, resolver)
    return out


# --- the canvas --------------------------------------------------------------

class _Canvas:
    """Pages under construction: ops in the y-down frame, plus the fonts,
    images and link boxes each page ends up needing. Every draw call
    paginates itself, so callers never track the page break."""

    def __init__(self, writer: PdfWriter, uploads_dir=None, resolve_ref=None,
                 asset_link=None):
        self.writer = writer
        self.uploads_dir = uploads_dir
        self.images = XObjectStore(writer, uploads_dir)
        self.glyphs = GlyphFonts(writer)
        self.resolve_ref = resolve_ref   # [[id]] → {content, page_title} | None
        self.asset_link = asset_link     # stored /api/… ref → the URL to write
        self.pages = []
        self.outline = []          # (title, page index, level) → PDF bookmarks
        self._new_page()

    # -- page bookkeeping --
    def _new_page(self):
        self.pages.append({"ops": [], "fonts": {HELV}, "xobjects": {}, "links": []})
        self.y = MARGIN_TOP

    @property
    def page(self):
        return self.pages[-1]

    @property
    def index(self):
        return len(self.pages) - 1

    def room(self) -> float:
        return PAGE_H - MARGIN_BOTTOM - self.y

    def at_top(self) -> bool:
        return not self.page["ops"]

    def page_break(self):
        if not self.at_top():
            self._new_page()

    def need(self, height: float):
        """Break the page unless ``height`` fits (or nothing is on it yet)."""
        if height > self.room() and not self.at_top():
            self._new_page()

    def gap(self, height: float):
        if not self.at_top():
            self.y += height

    # -- drawing --
    def paragraph(self, spans, x: float, width: float, size: float = BODY_SIZE,
                  color=TEXT_COLOR, leading: float = LEADING, bullet=None,
                  bar=None, background=None, bg_span=None, todo=None):
        """Wrap ``spans`` into the column at ``x`` and draw them, breaking the
        page between lines. ``bar`` (a colour) draws a quote rule down the left
        of every line, ``background`` a fill behind them — over the column by
        default, over ``bg_span`` (x0, x1) when the text is inset inside it."""
        lines = wrap(resolve(spans, size, width), width, size)
        for n, (indent, line) in enumerate(lines):
            ascent, height = line_metrics(line, size, leading)
            self.need(height)
            ops = self.page["ops"]
            if background:
                bx0, bx1 = bg_span or (x - CODE_PAD, x + width + CODE_PAD)
                fill_rect(ops, bx0, self.y, bx1, self.y + height, background)
            if bar:
                fill_rect(ops, x - QUOTE_PAD, self.y, x - QUOTE_PAD + QUOTE_BAR,
                          self.y + height, bar)
            if n == 0:
                if bullet is not None:
                    self._bullet(bullet, x, self.y + ascent, size)
                if todo is not None:
                    self._checkbox(todo, x, self.y + ascent, size)
            draw_spans(ops, x + indent, self.y + ascent, line, size, color=color,
                       fonts=self.page["fonts"], links=self.page["links"],
                       glyphs=self.glyphs)
            self.y += height

    def _bullet(self, marker, x: float, base: float, size: float):
        """A dot for an unnumbered bullet, the number itself when there is one."""
        ops = self.page["ops"]
        if marker:
            spans = [(TEXT, marker, 0, PLAIN)]
            draw_spans(ops, x - BULLET_GAP - span_width(marker, size * 0.92), base,
                       spans, size * 0.92, color=MUTED, fonts=self.page["fonts"])
            return
        cx, cy = x - BULLET_GAP, base - size * 0.28
        fill_rect(ops, cx - BULLET_R, cy - BULLET_R, cx + BULLET_R, cy + BULLET_R, MUTED)

    def _checkbox(self, checked: bool, x: float, base: float, size: float):
        ops, side = self.page["ops"], size * 0.62
        x0, y0 = x - BULLET_GAP - side * 0.5, base - side * 0.9
        ops.append(b"%s %s %s RG 0.7 w %s %s %s %s re S" % (
            num(MUTED[0]), num(MUTED[1]), num(MUTED[2]),
            num(x0), num(y0), num(side), num(side)))
        if checked:
            ops.append(b"%s %s %s RG 1.1 w %s %s m %s %s l %s %s l S" % (
                num(MUTED[0]), num(MUTED[1]), num(MUTED[2]),
                num(x0 + side * 0.2), num(y0 + side * 0.55),
                num(x0 + side * 0.42), num(y0 + side * 0.8),
                num(x0 + side * 0.82), num(y0 + side * 0.22)))

    def rule(self, x: float, width: float, color=RULE_COLOR, thickness: float = 0.6):
        self.need(6.0)
        self.y += 3.0
        fill_rect(self.page["ops"], x, self.y, x + width, self.y + thickness, color)
        self.y += 3.0

    def image(self, src: str, x: float, width: float, alt: str = "", px_w=None):
        """``px_w`` is the editor's ``{:width N}`` (CSS px) — the drawn width,
        still capped at the column."""
        info = self.images.resolve(src)
        if not info:
            self.paragraph(inline(alt.strip() or "image", Style(ITALIC, None)),
                           x, width, SMALL_SIZE, color=MUTED)
            return
        name, nat_w, nat_h = info
        w = min(width, (px_w or nat_w) * PX_PT)
        h = w * nat_h / max(nat_w, 1)
        cap = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM
        if h > cap:
            w, h = w * cap / h, cap
        self.need(h)
        # The frame has y running down, so flip the image matrix back.
        self.page["ops"].append(b"q %s 0 0 %s %s %s cm /%s Do Q" % (
            num(w), num(-h), num(x), num(self.y + h), name.encode()))
        self.page["xobjects"][name] = self.images.refs[name]
        self.y += h + IMAGE_GAP

    def ink(self, ink_url: str, x: float, width: float) -> bool:
        """A handwriting group drawn as vector strokes, fitted to the column
        (never enlarged). False when the ink file is missing or unreadable —
        the caller falls back to text."""
        from . import ink as inkmod
        ink_file = inkmod.read_upload(self.uploads_dir, ink_url)
        box = inkmod.bounding_box(ink_file) if ink_file else None
        if not box:
            return False
        bw, bh = box[2] - box[0], box[3] - box[1]
        scale = min(1.0, width / bw) if bw else 1.0
        cap = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM
        if bh * scale > cap:
            scale = cap / bh
        h = bh * scale
        self.need(h)
        top = self.y
        self.page["ops"].append(inkmod.pdf_path_ops(
            ink_file, lambda px, py: (x + (px - box[0]) * scale, top + (py - box[1]) * scale), scale))
        self.y += h + IMAGE_GAP
        return True

    def native_ink(self, props: dict, x: float, width: float) -> dict | None:
        """A native (iPad) PencilKit annotation's picture, fitted to the column
        (never enlarged). → ``{"source", "strokes"}`` for the caption, or None
        when neither its PNG preview nor a replay derivative is readable.

        A document has no page position to preserve, so resolution wins: the
        per-stroke ``.inkjson`` derivative is preferred (the web's Notes pane
        makes the same choice, with the block's whole-block PNG as its
        fallback), trimmed to the strokes' own bounds. Nothing is invented —
        Apple's PKDrawing cannot be drawn here, so a block with neither
        rendering is reported as such by the caller and its vector ink is never
        faked from a picture."""
        picture = native_ink_picture(self.uploads_dir, props, prefer_replay=True,
                                     crop_to_content=True)
        if not picture:
            return None
        frame_w, frame_h = picture["frame"]
        scale = min(1.0, width / frame_w) if frame_w else 1.0
        cap = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM
        if frame_h * scale > cap:
            scale = cap / frame_h
        if scale <= 0:
            return None
        self.need(frame_h * scale)
        top = self.y
        drawn = 0
        for draw in picture["draws"]:
            built = native_ink_image(self.writer, draw["data"])
            if not built:
                continue
            name, ref = built
            bx, by, bw, bh = draw["box"]
            w, h = bw * scale, bh * scale
            if w <= 0 or h <= 0:
                continue
            # The y-down frame, like image(): the picture's top edge sits at
            # top + by·scale, so the flipped matrix flips about that edge.
            self.page["ops"].append(b"q %s 0 0 %s %s %s cm /%s Do Q" % (
                num(w), num(-h), num(x + bx * scale), num(top + (by + bh) * scale),
                name.encode("ascii")))
            self.page["xobjects"][name] = ref
            drawn += 1
        if not drawn:
            return None
        self.y += frame_h * scale + IMAGE_GAP
        return {"source": picture["source"], "strokes": picture.get("strokes")}

    def display_math(self, tex: str, x: float, width: float, size: float = BODY_SIZE):
        drawn = vector_text.math(tex, size * DISPLAY_MATH_SCALE)
        if not drawn:                    # no ziamath, or it choked: approximate
            self.paragraph(plain(latex_spans(tex)), x, width, size)
            return
        drawing, w, h, _ascent = drawn
        scale = min(1.0, width / w) if w else 1.0
        cap = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM
        if h * scale > cap:              # a page-taller equation is shrunk, not clipped
            scale = cap / h
        self.need(h * scale)
        self.page["ops"].append(b"q %s 0 0 %s %s %s cm" % (
            num(scale), num(scale), num(x + max(0.0, (width - w * scale) / 2)), num(self.y)))
        self.page["ops"].append(self.glyphs.draw(drawing))
        self.page["ops"].append(b"Q")
        self.y += h * scale + IMAGE_GAP

    def code(self, lines, x: float, width: float):
        """A fenced block as a bordered card (the editor's code look): tinted,
        stroked, one card segment per page it spans. Leading whitespace is
        drawn as an x offset — wrapping drops spaces at the start of a line,
        and code that loses its indentation is unreadable."""
        self.gap(PARA_GAP)
        size = CODE_SIZE
        space = span_width(" ", size, 0, _CODE_STYLE)
        inner = width - 2 * CODE_PAD_X
        flat = []                                 # (x offset, wrapped line)
        for line in lines or [""]:
            body = (line or "").rstrip()
            offset = min((len(body) - len(body.lstrip(" "))) * space, inner * 0.5)
            spans = [(TEXT, body.strip() or " ", 0, _CODE_STYLE)]
            for indent, wline in wrap(resolve(spans, size, inner - offset),
                                      inner - offset, size, hang=0.0):
                flat.append((offset + indent, wline))
        line_h, ascent = size * 1.3, size * 0.82
        i = 0
        while i < len(flat):
            if self.room() < line_h + 2 * CODE_PAD_Y and not self.at_top():
                self.page_break()
            n = min(len(flat) - i,
                    max(1, int((self.room() - 2 * CODE_PAD_Y) // line_h)))
            seg_h = n * line_h + 2 * CODE_PAD_Y
            ops = self.page["ops"]
            fill_rect(ops, x, self.y, x + width, self.y + seg_h, CODE_BG)
            ops.append(b"%s %s %s RG 0.7 w %s %s %s %s re S" % (
                num(CODE_BORDER[0]), num(CODE_BORDER[1]), num(CODE_BORDER[2]),
                num(x), num(self.y), num(width), num(seg_h)))
            yy = self.y + CODE_PAD_Y
            for offset, wline in flat[i:i + n]:
                draw_spans(ops, x + CODE_PAD_X + offset, yy + ascent, wline, size,
                           fonts=self.page["fonts"], links=self.page["links"],
                           glyphs=self.glyphs)
                yy += line_h
            self.y += seg_h
            i += n
        self.gap(PARA_GAP)

    def table(self, rows, aligns, x: float, width: float):
        """A GFM table (``rows`` = span lists, header first): measured column
        widths, wrapped cells, a light grid, the header tinted bold and
        repeated when a page break falls inside the table."""
        if not rows:
            return
        size = TABLE_SIZE
        ncols = max(len(r) for r in rows)
        rows = [list(r) + [[] for _ in range(ncols - len(r))] for r in rows]
        aligns = (list(aligns or []) + ["left"] * ncols)[:ncols]
        # Natural column widths, then squeezed proportionally into the column.
        measured = [[resolve(c, size, width) for c in row] for row in rows]
        nat = [max(spans_width(measured[r][c], size) for r in range(len(rows)))
               + 2 * TABLE_PAD_X + 1.0 for c in range(ncols)]
        total = sum(nat)
        if total <= width:
            col_w = nat
        else:
            col_w = [max(26.0, w * width / total) for w in nat]
            squeeze = sum(col_w)
            if squeeze > width:
                col_w = [w * width / squeeze for w in col_w]
        cells, heights = [], []                  # wrapped lines + row heights
        for r, row in enumerate(rows):
            row_cells, row_h = [], size * 1.3
            for c in range(ncols):
                inner = max(8.0, col_w[c] - 2 * TABLE_PAD_X)
                lines = wrap(resolve(row[c], size, inner), inner, size, hang=0.0)
                metrics = [line_metrics(line, size, 1.3) for _i, line in lines]
                row_cells.append((lines, metrics, inner))
                row_h = max(row_h, sum(h for _a, h in metrics))
            cells.append(row_cells)
            heights.append(row_h + 2 * TABLE_PAD_Y)

        def draw_row(r):
            ops, y0 = self.page["ops"], self.y
            if r == 0:
                fill_rect(ops, x, y0, x + sum(col_w), y0 + heights[0], TABLE_HEAD_BG)
            cx = x
            for c in range(ncols):
                lines, metrics, inner = cells[r][c]
                ly = y0 + TABLE_PAD_Y
                for (indent, line), (ascent, h) in zip(lines, metrics):
                    lw = indent + spans_width(line, size)
                    shift = (inner - lw if aligns[c] == "right"
                             else (inner - lw) / 2 if aligns[c] == "center" else 0.0)
                    draw_spans(ops, cx + TABLE_PAD_X + indent + max(0.0, shift),
                               ly + ascent, line, size,
                               fonts=self.page["fonts"], links=self.page["links"],
                               glyphs=self.glyphs)
                    ly += h
                ops.append(b"%s %s %s RG 0.6 w %s %s %s %s re S" % (
                    num(TABLE_BORDER[0]), num(TABLE_BORDER[1]), num(TABLE_BORDER[2]),
                    num(cx), num(y0), num(col_w[c]), num(heights[r])))
                cx += col_w[c]
            self.y = y0 + heights[r]

        self.gap(PARA_GAP)
        # Never leave the header stranded at the bottom of a page.
        self.need(heights[0] + (heights[1] if len(rows) > 1 else 0.0))
        for r in range(len(rows)):
            if r and heights[r] > self.room() and not self.at_top():
                self.page_break()
                draw_row(0)
            draw_row(r)
        self.gap(PARA_GAP)

    def bookmark(self, title: str, level: int = 0):
        if title.strip():
            self.outline.append((title.strip()[:120], self.index, level))

    # -- output --
    def write(self):
        """Flush the pages into the writer and return its PDF bytes."""
        total = len(self.pages)
        self.glyphs.finalize()
        glyph_fonts = self.glyphs.resources()
        for n, page in enumerate(self.pages):
            self._footer(page, n + 1, total)
            # add_blank_page returns the page it was handed, not the clone that
            # ends up in the writer — take that one, or the content is dropped.
            self.writer.add_blank_page(PAGE_W, PAGE_H)
            pdf_page = self.writer.pages[-1]
            body = (b"q 1 0 0 -1 0 %s cm\n" % num(PAGE_H)
                    + b"\n".join(page["ops"]) + b"\nQ")
            stream = DecodedStreamObject()
            stream.set_data(body)
            # Streams must be indirect objects or the file is unreadable.
            pdf_page[NameObject("/Contents")] = self.writer._add_object(stream.flate_encode())
            fonts = font_resources(sorted(page["fonts"]))
            fonts.update({NameObject("/" + name): ref for name, ref in glyph_fonts.items()})
            resources = DictionaryObject({NameObject("/Font"): fonts})
            if page["xobjects"]:
                resources[NameObject("/XObject")] = DictionaryObject(
                    {NameObject("/" + name): ref for name, ref in page["xobjects"].items()})
            pdf_page[NameObject("/Resources")] = resources
            self._link_annotations(n, page["links"])
        self._bookmarks()
        out = io.BytesIO()
        self.writer.write(out)
        return out.getvalue()

    def _footer(self, page, number: int, total: int):
        if total < 2:
            return
        label = f"{number} / {total}"
        size = SMALL_SIZE - 0.6
        spans = [(TEXT, label, 0, PLAIN)]
        draw_spans(page["ops"], (PAGE_W - span_width(label, size)) / 2,
                   PAGE_H - MARGIN_BOTTOM + 26, spans, size, color=MUTED,
                   fonts=page["fonts"])

    def _link_annotations(self, index: int, links):
        if not links:
            return
        try:
            from PyPDF2.generic import AnnotationBuilder
        except ImportError:                      # older PyPDF2: text stays, link doesn't
            log.info("[pdf-document] no AnnotationBuilder; links are not clickable")
            return
        for x0, y0, x1, y1, href in links:
            try:
                self.writer.add_annotation(
                    page_number=index,
                    annotation=AnnotationBuilder.link(
                        rect=(x0, PAGE_H - y1, x1, PAGE_H - y0), url=href))
            except Exception as e:
                log.info(f"[pdf-document] could not link {href[:60]}: {e}")

    def _bookmarks(self):
        # Nesting is relative, not by heading number: a page whose notes start
        # at "##" still hangs its sections off the page's own bookmark.
        stack = []                     # [(level, bookmark)], outermost first
        for title, index, level in self.outline:
            while stack and stack[-1][0] >= level:
                stack.pop()
            try:
                item = self.writer.add_outline_item(
                    title, index, parent=stack[-1][1] if stack else None)
            except Exception as e:
                log.info(f"[pdf-document] outline entry failed: {e}")
                return
            stack.append((level, item))


# --- block tree → canvas -----------------------------------------------------

def _meta(props: dict) -> dict:
    meta = props.get("meta")
    return meta if isinstance(meta, dict) else {}


def _meta_line(meta: dict) -> str:
    parts = []
    authors = meta.get("authors")
    if isinstance(authors, list) and authors:
        names = [str(a) for a in authors[:6]]
        parts.append(", ".join(names) + (" et al." if len(authors) > 6 else ""))
    elif authors:
        parts.append(str(authors))
    for key in ("venue", "year"):
        if meta.get(key):
            parts.append(str(meta[key]))
    return " · ".join(parts)


def _emit_chunks(cv: _Canvas, md: str, x: float, width: float, color=TEXT_COLOR,
                 quote_bar=None, base_style: Style = PLAIN, bullet: bool = False,
                 nested: bool = False):
    """One block's markdown, drawn into the column at ``x``. ``bullet`` puts an
    outliner dot beside the block's first line; ``quote_bar`` (a colour) runs a
    rule down every line, which is how a highlight's quoted passage reads.
    ``nested`` marks the inside of an ![[embed]] card, where further embeds
    degrade to reference text so transclusion can't recurse."""
    first = True
    for chunk in chunks(md, cv.resolve_ref):
        kind = chunk["kind"]
        if kind == "gap":
            cv.gap(PARA_GAP)
            continue
        if kind == "rule":
            cv.rule(x, width)
            continue
        if kind == "code":
            cv.code(chunk["lines"], x, width)
            continue
        if kind == "image":
            cv.image(chunk["src"], x, width, chunk.get("alt", ""),
                     px_w=chunk.get("px_w"))
            continue
        if kind == "table":
            cv.table(chunk["rows"], chunk["aligns"], x, width)
            continue
        if kind == "embed":
            ref = cv.resolve_ref(chunk["id"]) if (cv.resolve_ref and not nested) else None
            content = ((ref or {}).get("content") or "").strip()
            if content:
                # The synced block's own content, as a card: a soft bar down
                # the left plus a muted source line, like the editor's card.
                cv.gap(PARA_GAP)
                _emit_chunks(cv, content, x + QUOTE_PAD, width - QUOTE_PAD,
                             quote_bar=EMBED_BAR, nested=True)
                title = ((ref or {}).get("page_title") or "").strip()
                if title:
                    cv.paragraph(inline(f"from {title}", Style(ITALIC, None)),
                                 x + QUOTE_PAD, width - QUOTE_PAD, SMALL_SIZE,
                                 color=MUTED, bar=EMBED_BAR)
                cv.gap(PARA_GAP)
            else:                      # unresolved: reads as a reference
                cv.paragraph([(TEXT, _ref_label(chunk["id"], cv.resolve_ref), 0,
                               Style(LINK, None))], x, width)
            continue
        if kind == "math":
            cv.display_math(chunk["tex"], x, width)
            continue

        level = chunk.get("heading")
        sub = chunk.get("sub", 0)
        size = HEADING_SIZES[level] if level else BODY_SIZE
        spans = chunk["spans"]
        if base_style.bits and not level:
            spans = [(k, p, lv, styled(st, base_style.bits)) for k, p, lv, st in spans]
        # A ">" quote inside a plain block gets its own grey rule; inside a
        # highlight the highlight's own bar already runs down the column.
        quoted = bool(chunk.get("quote")) and quote_bar is None
        bar = quote_bar or (RULE_COLOR if quoted else None)
        cx = x + sub * INDENT + (QUOTE_PAD if quoted else 0)
        if level:
            # A heading needs its section under it, not stranded at the bottom
            # of a page.
            cv.gap(SECTION_GAP)
            cv.need(size * LEADING * 2.6)
            cv.bookmark("".join(p for k, p, _lv, _st in spans if k == TEXT), level)
        marker = chunk.get("bullet")
        if marker is None and bullet and first and not level and not quoted:
            marker = ""
        cv.paragraph(spans, cx, width - (cx - x), size,
                     color=QUOTE_COLOR if quoted else color, bar=bar,
                     bullet=marker, todo=chunk.get("todo"))
        first = False


def _clock(seconds: float) -> str:
    """A recording duration as ``h:mm:ss`` / ``m:ss`` — the shape a player
    shows. Whole seconds, from the finalized segments' own durations: the
    document repeats a recording's timeline, it never invents one."""
    total = max(0, int(round(float(seconds))))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def absolute_asset_link(base_url: str, workspace: str | None = None):
    """``render_document``'s ``asset_link``: a stored local reference
    (``/api/assets/<hash>.m4a``) → the URL an exported document must carry.

    A downloaded PDF has no origin: a bare ``/api/assets/…`` resolves against
    whatever base the reader's viewer happens to assume, and the same file
    fetched without ``?ws=`` comes from the READER's default workspace rather
    than the one the export was made in. So the link is absolute and names its
    workspace explicitly. ``base_url`` may carry a deployment's root path
    (``https://host/gamma``) — the reference is appended to it verbatim.

    Nothing else is added: no session, no credentials, and NEVER a share token.
    An exported file is not a capability — a reader still needs their own
    Gamma session (or membership) and access to that workspace, and a view
    share must not turn into durable access to the workspace's assets just
    because someone exported the notes. Non-local references (``https://…``,
    ``data:``, a bare name) pass through untouched."""
    base = str(base_url or "").strip().rstrip("/")
    ws = str(workspace).strip() if workspace else ""

    def link(ref):
        if not isinstance(ref, str) or not ref.startswith("/api/"):
            return ref
        url = f"{base}{ref}"
        if not ws:
            return url
        return f"{url}{'&' if '?' in url else '?'}ws={quote(ws)}"

    return link


def audio_summary(props: dict, link=None) -> tuple[str, list[tuple[str, str | None]]]:
    """A native recording's text for the notes document: a one-line summary
    (segment count and total duration) plus one line per finalized segment,
    each linked to its stored ``.m4a``.

    A PDF has no audio player, so the recording is NOT embedded and no playback
    is implied — the document carries what a reader can actually use: how long
    each segment is and where the file lives. ``link`` (``render_document``'s
    asset-link resolver, i.e. ``absolute_asset_link`` at the export endpoint)
    rewrites that local reference into the URL a reader of the downloaded file
    needs; without it the stored reference is written as-is, which is what a
    standalone document wants. Durations come from the finalized segments (or
    the server-derived ``duration``); a block with no segments says so rather
    than showing a made-up ``0:00``, and an asset reference that is not a local
    ``/api/assets/<hash>.m4a`` stays plain text — never a dead link."""
    segments = [s for s in (props.get("segments") or []) if isinstance(s, dict)]
    durations = []
    for segment in segments:
        value = segment.get("duration")
        durations.append(float(value) if isinstance(value, (int, float))
                         and not isinstance(value, bool) and value > 0 else 0.0)
    total = props.get("duration")
    if not isinstance(total, (int, float)) or isinstance(total, bool) or total <= 0:
        total = sum(durations)
    if segments:
        summary = (f"audio recording · {len(segments)} segment"
                   f"{'s' if len(segments) != 1 else ''} · {_clock(total)} total"
                   " · audio not embedded")
    else:
        summary = "audio recording · no finalized segments"
    lines = []
    for n, segment in enumerate(segments, 1):
        asset = segment.get("asset")
        href = asset if isinstance(asset, str) and AUDIO_REF_RE.fullmatch(asset) else None
        if href is not None and link is not None:
            href = link(href)
        lines.append((f"Segment {n} · {_clock(durations[n - 1])}", href))
    return summary, lines


def _emit_block(cv: _Canvas, node: dict, depth: int, highlights: bool, notes: bool):
    """One block and its subtree. Mirrors the Markdown export's switches: with
    highlights off a highlight block keeps its own writing as a plain bullet;
    with notes off only the quoted passages remain."""
    props = node.get("properties") or {}
    content = (node.get("content") or "").strip()
    is_highlight = bool(props.get("highlight_id"))
    is_link = bool(props.get("link_url"))
    is_ink = bool(props.get("ink_url"))
    # Native (iPad) annotations: handwriting is a PDF region too, so the
    # highlights switch governs it exactly as it does for ink_url and
    # highlights (the Markdown export's rule); a recording follows the notes
    # switch instead, because it is writing, not a mark on the paper.
    is_native_ink = props.get("type") == "pdf_ink"
    is_audio = props.get("type") == "audio"
    if is_highlight or is_link or is_ink or is_native_ink:
        if not highlights:
            props, is_highlight, is_link, is_ink, is_native_ink = {}, False, False, False, False
        if not notes:
            content = ""
    elif not notes:
        content = ""

    # Indentation stops after a few levels: a deep outline would otherwise
    # march its text off the right margin.
    x = MARGIN_X + min(depth, MAX_INDENT_LEVELS) * INDENT
    width = PAGE_W - MARGIN_X - x
    emitted = False

    if is_link:
        label = content or (props.get("quote") or "").strip() or props["link_url"]
        cv.gap(BLOCK_GAP)
        cv.paragraph(inline(label, Style(LINK, props["link_url"])), x, width,
                     bullet="" if depth else None)
        emitted = True
    elif is_ink:
        cv.gap(BLOCK_GAP)
        drawn = cv.ink(props["ink_url"], x + QUOTE_PAD, width - QUOTE_PAD)
        page_no = props.get("pdf_page")
        if drawn and page_no is not None:
            cv.paragraph([(TEXT, f"handwriting, p. {page_no}", 0, PLAIN)],
                         x + QUOTE_PAD, width - QUOTE_PAD, SMALL_SIZE, color=MUTED)
        emitted = drawn
        if content:
            cv.gap(BLOCK_GAP)
            inset = QUOTE_PAD if emitted else 0
            _emit_chunks(cv, content, x + inset, width - inset, bullet=bool(depth or inset))
            emitted = True
    elif is_native_ink:
        cv.gap(BLOCK_GAP)
        drawn = cv.native_ink(props, x + QUOTE_PAD, width - QUOTE_PAD)
        page_no = props.get("pdf_page")
        if drawn:
            caption = f"handwriting, p. {page_no}" if page_no else "handwriting"
            if drawn.get("strokes"):
                caption += f" · {drawn['strokes']} strokes"
        else:
            # Explicit, not silent: the block really is handwriting, and the
            # picture it renders with is simply not on this server any more.
            caption = (f"handwriting, p. {page_no} · no preview available" if page_no
                       else "handwriting · no preview available")
        # ``bullet`` is the MARKER to draw ("" = the outliner dot, a string =
        # that number, None = none) — not the "nested?" flag the content lines
        # take, which is why a nested block crashed here before.
        cv.paragraph([(TEXT, caption, 0, PLAIN)], x + QUOTE_PAD, width - QUOTE_PAD,
                     SMALL_SIZE, color=MUTED, bullet="" if depth else None)
        emitted = True
        if content:
            cv.gap(BLOCK_GAP)
            _emit_chunks(cv, content, x + QUOTE_PAD, width - QUOTE_PAD, bullet=True)
            emitted = True
    elif is_highlight:
        quote = (props.get("quote") or "").strip()
        bar = tuple(max(0.0, c * 0.7) for c in parse_css_color(props.get("color"))[:3])
        if quote:
            cv.gap(BLOCK_GAP)
            _emit_chunks(cv, quote, x + QUOTE_PAD, width - QUOTE_PAD,
                         color=QUOTE_COLOR, quote_bar=bar,
                         base_style=Style(ITALIC, None))
            page_no = props.get("pdf_page")
            if page_no is not None:
                cv.paragraph([(TEXT, f"p. {page_no}", 0, PLAIN)],
                             x + QUOTE_PAD, width - QUOTE_PAD, SMALL_SIZE,
                             color=MUTED, bar=bar)
            emitted = True
        if content:
            cv.gap(BLOCK_GAP)
            inset = QUOTE_PAD if emitted else 0
            _emit_chunks(cv, content, x + inset, width - inset, bullet=bool(depth or inset))
            emitted = True
    elif is_audio and notes:
        summary, segments = audio_summary(props, cv.asset_link)
        cv.gap(BLOCK_GAP)
        cv.paragraph([(TEXT, summary, 0, PLAIN)], x, width, SMALL_SIZE,
                     color=MUTED, bullet="" if depth else None)
        for label, href in segments:
            cv.paragraph([(TEXT, label, 0, Style(LINK, href) if href else PLAIN)],
                         x + QUOTE_PAD, width - QUOTE_PAD, SMALL_SIZE, color=MUTED)
        emitted = True
        if content:
            cv.gap(BLOCK_GAP)
            _emit_chunks(cv, content, x, width, bullet=True)
            emitted = True
    elif content:
        cv.gap(BLOCK_GAP)
        _emit_chunks(cv, content, x, width, bullet=bool(depth))
        emitted = True

    # A block with nothing to show doesn't consume an indent level, so its
    # children stay where they are rather than drifting right (the Markdown
    # export does the same).
    child_depth = depth + 1 if emitted else depth
    for child in node.get("children") or []:
        _emit_block(cv, child, child_depth, highlights, notes)


def _emit_page(cv: _Canvas, page: dict, highlights: bool, notes: bool):
    props = page.get("properties") or {}
    title = re.sub(r"\s+", " ", page.get("content") or "").strip() or "Untitled"
    width = PAGE_W - 2 * MARGIN_X

    cv.bookmark(title)
    cv.paragraph(inline(title, Style(BOLD, None)), MARGIN_X, width, TITLE_SIZE,
                 leading=1.2)
    meta = _meta(props)
    meta_line = _meta_line(meta)
    if meta_line:
        cv.gap(2.0)
        cv.paragraph(inline(meta_line), MARGIN_X, width, SMALL_SIZE + 0.6, color=MUTED)
    source = props.get("source_url") or ""
    doi = meta.get("doi")
    link = f"https://doi.org/{doi}" if doi else (source if source.startswith("http") else "")
    if link:
        cv.gap(1.0)
        cv.paragraph([(TEXT, link, 0, Style(LINK, link))], MARGIN_X, width,
                     SMALL_SIZE, color=MUTED)
    cv.gap(4.0)
    cv.rule(MARGIN_X, width)
    cv.gap(4.0)

    for child in page.get("children") or []:
        _emit_block(cv, child, 0, highlights, notes)


def render_document(pages, uploads_dir=None, highlights: bool = True,
                    notes: bool = True, resolve_ref=None, asset_link=None) -> bytes:
    """Page trees (``markdown_export.build_tree`` nodes) → a PDF document, one
    page starting on a fresh sheet. ``highlights``/``notes`` are the export
    dialog's switches; ``uploads_dir`` is where ``/api/uploads/…`` refs are
    read from (without it images degrade to their alt text); ``resolve_ref``
    (block id → {content, page_title} | None) lets [[refs]] read as their
    target's text and ``![[embeds]]`` render the synced block's content.

    ``asset_link`` (a stored local reference → the URL to write) is how the
    export endpoint turns the recording links into absolute, workspace-scoped
    URLs a reader of the downloaded file can follow (``absolute_asset_link``).
    Left out, the references are written exactly as stored — the standalone
    rendering this function also is."""
    writer = PdfWriter()
    canvas = _Canvas(writer, uploads_dir, resolve_ref, asset_link)
    for n, page in enumerate(pages):
        if n:
            canvas.page_break()
        _emit_page(canvas, page, highlights, notes)
    return canvas.write()
