"""A note page typeset as a fresh PDF ("Notes as PDF" export).

``pdf_export``/``pdf_notes`` write *onto a paper*: highlights become
annotations, notes get painted into the free space around them. This module is
the other direction — the notes themselves as a document. It takes the block
subtrees the export driver walks (a note page, a paper's notes, or a whole
folder of them) and lays them out as a real PDF: title and metadata, nested
bullets, headings, quotes, code, tables of pasted images, typeset math.

Nothing is embedded and no imaging or PDF-generation library is used:
``pdf_typeset`` measures and draws with the fonts every viewer has built in,
``vector_text`` turns LaTeX and CJK into vector paths, and ``pdf_image`` embeds
the pasted uploads as image XObjects — the same three the note boxes use.

Blocks carry markdown, so each block's content is parsed twice over: into
*chunks* (headings, paragraphs, quotes, list items, todos, fenced code, rules,
images, display math — the constructs the block editor renders live) and then
each chunk's text into styled inline spans (bold, italic, code, strike,
``==marked==``, links, ``$…$`` math). Links become real /Link annotations and
page titles become PDF bookmarks, so a folder export is navigable.

The whole page is drawn in ``pdf_typeset``'s y-down frame and flipped into user
space by one ``cm`` at the top of the content stream.
"""

import io
import re

from PyPDF2 import PdfWriter
from PyPDF2.generic import DecodedStreamObject, DictionaryObject, NameObject

from . import vector_text
from .logbuf import log
from .note_markup import MATH, TEXT, latex_spans
from .pdf_export import parse_css_color
from .pdf_image import XObjectStore
from .pdf_typeset import (
    BOLD,
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
CODE_BG = (0.955, 0.957, 0.965)
_CODE_STYLE = Style(MONO, None)

_FENCE_RE = re.compile(r"^\s*```")
_RULE_RE = re.compile(r"^\s*(?:-{3,}|\*{3,}|_{3,})\s*$")
_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*)$")
_QUOTE_RE = re.compile(r"^\s{0,3}>\s?(.*)$")
_CALLOUT_RE = re.compile(r"^\[!(\w+)\][+-]?\s*(.*)$")
_TODO_RE = re.compile(r"^(\s*)(?:([-*+])\s+)?\[([ xX])\]\s+(.*)$")
_LIST_RE = re.compile(r"^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(\s*([^)\s]+)[^)]*\)")

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

def inline(text: str, style: Style = PLAIN):
    """One line of markdown → styled spans (see pdf_typeset for the shape)."""
    out, pos = [], 0
    for m in _INLINE_RE.finditer(text):
        if m.start() > pos:
            out.append((TEXT, text[pos:m.start()], 0, style))
        pos = m.end()
        which = next(k for k in ("code", "dmath", "math", "bold", "italic", "strike",
                                 "mark", "embed", "ref", "link", "url")
                     if m.group(k) is not None)
        body = m.group(which)
        if which == "code":
            out.append((TEXT, body.strip("`"), 0, Style(style.bits | MONO, style.href)))
        elif which in ("math", "dmath"):
            tex = body.strip("$").strip() if body[0] == "$" else body[2:-2].strip()
            if tex:
                out.append((MATH, tex, 0, style))
        elif which in _WRAPPERS:
            marks = _WRAPPERS[which]
            out.extend(inline(body[marks:-marks],
                              Style(style.bits | _BITS[which], style.href)))
        elif which in ("embed", "ref"):
            # A page reference can't be followed outside Gamma; it still reads
            # as a reference, in link colour without a target.
            name = body.strip("![]").split("|")[0].strip()
            out.append((TEXT, name, 0, Style(style.bits | LINK, None)))
        elif which == "link":
            label, href = _LINK_PARTS.match(body).groups()
            out.extend(inline(label or href, Style(style.bits | LINK, href)))
        else:                                    # bare URL
            out.append((TEXT, body, 0, Style(style.bits | LINK, body)))
    if pos < len(text):
        out.append((TEXT, text[pos:], 0, style))
    return merge(out)


def _text_chunks(text: str, style: Style, **extra):
    """A line of prose → its text chunk plus a chunk per ``![](…)`` image."""
    chunks, pos = [], 0
    for m in _IMAGE_RE.finditer(text):
        head = text[pos:m.start()]
        if head.strip():
            chunks.append({"kind": "text", "spans": inline(head, style), **extra})
        chunks.append({"kind": "image", "src": m.group(2), "alt": m.group(1)})
        pos = m.end()
    tail = text[pos:]
    if tail.strip() or not chunks:
        chunks.append({"kind": "text", "spans": inline(tail, style), **extra})
    return chunks


def chunks(md: str):
    """A block's markdown → the drawable chunks, in order.

    ``text`` chunks carry spans plus the flags the canvas draws them with
    (``quote``, ``todo``, ``bullet``, ``heading``); ``image``, ``math``,
    ``code`` and ``rule`` are their own kinds. Blank lines become ``gap``.
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
            out += _text_chunks(heading.group(2), Style(BOLD, None), heading=level)
            continue
        quote = _QUOTE_RE.match(line)
        if quote:
            body = quote.group(1)
            callout = _CALLOUT_RE.match(body.strip())
            if callout:                                 # > [!note] Title
                title = callout.group(2).strip() or callout.group(1).title()
                out.append({"kind": "text", "spans": inline(title, Style(BOLD, None)),
                            "quote": True})
                continue
            out += _text_chunks(body, Style(ITALIC, None), quote=True)
            continue
        todo = _TODO_RE.match(line)
        if todo:
            lead, marker, box, body = todo.groups()
            # "- [ ] x" is a list item too, so it lines up with its neighbours.
            out += _text_chunks(body, PLAIN, todo=box.lower() == "x",
                                sub=len(lead) // 2 + 1 if marker else 0)
            continue
        item = _LIST_RE.match(line)
        if item:
            marker = item.group(2)
            # "" = a dot; a numbered marker keeps its number.
            out += _text_chunks(item.group(3), PLAIN,
                                bullet=marker if marker[:1].isdigit() else "",
                                sub=len(item.group(1)) // 2 + 1)
            continue
        out += _text_chunks(line.strip(), PLAIN)
    return out


# --- the canvas --------------------------------------------------------------

class _Canvas:
    """Pages under construction: ops in the y-down frame, plus the fonts,
    images and link boxes each page ends up needing. Every draw call
    paginates itself, so callers never track the page break."""

    def __init__(self, writer: PdfWriter, uploads_dir=None):
        self.writer = writer
        self.images = XObjectStore(writer, uploads_dir)
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
                       fonts=self.page["fonts"], links=self.page["links"])
            self.y += height

    def _bullet(self, marker, x: float, base: float, size: float):
        """A dot for an unnumbered bullet, the number itself when there is one."""
        ops = self.page["ops"]
        if marker:
            spans = [(TEXT, marker, 0, Style(0, None))]
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

    def image(self, src: str, x: float, width: float, alt: str = ""):
        info = self.images.resolve(src)
        if not info:
            self.paragraph(inline(alt.strip() or "image", Style(ITALIC, None)),
                           x, width, SMALL_SIZE, color=MUTED)
            return
        name, px_w, px_h = info
        w = min(width, px_w * PX_PT)
        h = w * px_h / max(px_w, 1)
        cap = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM
        if h > cap:
            w, h = w * cap / h, cap
        self.need(h)
        # The frame has y running down, so flip the image matrix back.
        self.page["ops"].append(b"q %s 0 0 %s %s %s cm /%s Do Q" % (
            num(w), num(-h), num(x), num(self.y + h), name.encode()))
        self.page["xobjects"][name] = self.images.refs[name]
        self.y += h + IMAGE_GAP

    def display_math(self, tex: str, x: float, width: float, size: float = BODY_SIZE):
        drawn = vector_text.math(tex, size * DISPLAY_MATH_SCALE)
        if not drawn:                    # no ziamath, or it choked: approximate
            self.paragraph(plain(latex_spans(tex)), x, width, size)
            return
        ops, w, h, _ascent = drawn
        scale = min(1.0, width / w) if w else 1.0
        cap = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM
        if h * scale > cap:              # a page-taller equation is shrunk, not clipped
            scale = cap / h
        self.need(h * scale)
        self.page["ops"].append(b"q %s 0 0 %s %s %s cm" % (
            num(scale), num(scale), num(x + max(0.0, (width - w * scale) / 2)), num(self.y)))
        self.page["ops"].append(ops)
        self.page["ops"].append(b"Q")
        self.y += h * scale + IMAGE_GAP

    def code(self, lines, x: float, width: float):
        """A fenced block: monospaced lines on one continuous tint. Leading
        whitespace is drawn as an offset — wrapping drops spaces at the start
        of a line, and code that loses its indentation is unreadable."""
        self.gap(PARA_GAP)
        space = span_width(" ", CODE_SIZE, 0, _CODE_STYLE)
        for line in lines or [""]:
            body = (line or "").rstrip()
            offset = (len(body) - len(body.lstrip(" "))) * space
            self.paragraph([(TEXT, body.strip() or " ", 0, _CODE_STYLE)],
                           x + CODE_PAD + offset, width - 2 * CODE_PAD - offset,
                           CODE_SIZE, leading=1.3, background=CODE_BG,
                           bg_span=(x, x + width))
        self.gap(PARA_GAP)

    def bookmark(self, title: str, level: int = 0):
        if title.strip():
            self.outline.append((title.strip()[:120], self.index, level))

    # -- output --
    def write(self):
        """Flush the pages into the writer and return its PDF bytes."""
        total = len(self.pages)
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
            pdf_page[NameObject("/Contents")] = self.writer._add_object(stream)
            resources = DictionaryObject({
                NameObject("/Font"): font_resources(sorted(page["fonts"]))})
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
        spans = [(TEXT, label, 0, Style(0, None))]
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

def _meta_line(props: dict) -> str:
    meta = props.get("meta") if isinstance(props.get("meta"), dict) else {}
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
                 quote_bar=None, base_style: Style = PLAIN, bullet: bool = False):
    """One block's markdown, drawn into the column at ``x``. ``bullet`` puts an
    outliner dot beside the block's first line; ``quote_bar`` (a colour) runs a
    rule down every line, which is how a highlight's quoted passage reads."""
    first = True
    for chunk in chunks(md):
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
            cv.image(chunk["src"], x, width, chunk.get("alt", ""))
            continue
        if kind == "math":
            cv.display_math(chunk["tex"], x, width)
            continue

        level = chunk.get("heading")
        sub = chunk.get("sub", 0)
        size = HEADING_SIZES[level] if level else BODY_SIZE
        spans = chunk["spans"]
        if base_style.bits and not level:
            spans = [(k, p, lv, Style(st.bits | base_style.bits, st.href))
                     for k, p, lv, st in spans]
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


def _emit_block(cv: _Canvas, node: dict, depth: int, highlights: bool, notes: bool):
    """One block and its subtree. Mirrors the Markdown export's switches: with
    highlights off a highlight block keeps its own writing as a plain bullet;
    with notes off only the quoted passages remain."""
    props = node.get("properties") or {}
    content = (node.get("content") or "").strip()
    is_highlight = bool(props.get("highlight_id"))
    is_link = bool(props.get("link_url"))
    if is_highlight or is_link:
        if not highlights:
            props, is_highlight, is_link = {}, False, False
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
    meta = _meta_line(props)
    if meta:
        cv.gap(2.0)
        cv.paragraph(inline(meta), MARGIN_X, width, SMALL_SIZE + 0.6, color=MUTED)
    source = props.get("source_url") or ""
    doi = (props.get("meta") or {}).get("doi") if isinstance(props.get("meta"), dict) else None
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
                    notes: bool = True) -> bytes:
    """Page trees (``markdown_export.build_tree`` nodes) → a PDF document, one
    page starting on a fresh sheet. ``highlights``/``notes`` are the export
    dialog's switches; ``uploads_dir`` is where ``/api/uploads/…`` refs are
    read from (without it images degrade to their alt text)."""
    writer = PdfWriter()
    canvas = _Canvas(writer, uploads_dir)
    for n, page in enumerate(pages):
        if n:
            canvas.page_break()
        _emit_page(canvas, page, highlights, notes)
    return canvas.write()
