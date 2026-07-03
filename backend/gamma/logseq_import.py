"""Parsers for Logseq PDF-highlight exports (EDN + MD) and conversion to Gamma blocks."""

import json
import random
import re
import string


def parse_edn(text):
    """Minimal EDN parser covering Logseq's highlight export format."""
    pos = [0]

    def skip():
        while pos[0] < len(text):
            c = text[pos[0]]
            if c in ' \t\n\r,':
                pos[0] += 1
            elif c == ';':  # line comment
                while pos[0] < len(text) and text[pos[0]] != '\n':
                    pos[0] += 1
            else:
                break

    def val():
        skip()
        if pos[0] >= len(text):
            raise ValueError("unexpected end")
        c = text[pos[0]]
        if c == '{':
            return parse_map()
        if c in '([':
            close = ')' if c == '(' else ']'
            pos[0] += 1
            items = []
            while True:
                skip()
                if text[pos[0]] == close:
                    pos[0] += 1
                    return items
                items.append(val())
        if c == '"':
            return parse_str()
        if c == ':':
            return parse_kw()
        if c == '#':
            pos[0] += 1
            parse_sym()
            skip()
            return val()  # discard tag (e.g. #uuid → just the string)
        if c == '-' or c.isdigit():
            return parse_num()
        sym = parse_sym()
        if sym == 'true':
            return True
        if sym == 'false':
            return False
        if sym == 'nil':
            return None
        return sym

    def parse_map():
        pos[0] += 1  # '{'
        d = {}
        while True:
            skip()
            if text[pos[0]] == '}':
                pos[0] += 1
                return d
            k = val()
            v = val()
            d[k] = v

    def parse_str():
        pos[0] += 1  # '"'
        buf = []
        while pos[0] < len(text):
            c = text[pos[0]]
            if c == '"':
                pos[0] += 1
                return ''.join(buf)
            if c == '\\':
                pos[0] += 1
                esc = text[pos[0]]
                buf.append({'n': '\n', 't': '\t', 'r': '\r', '"': '"', '\\': '\\', '/': '/'}.get(esc, esc))
            else:
                buf.append(c)
            pos[0] += 1
        raise ValueError("unterminated string")

    def parse_kw():
        pos[0] += 1  # ':'
        return parse_sym()

    def parse_sym():
        start = pos[0]
        while pos[0] < len(text) and text[pos[0]] not in ' \t\n\r,{}()[]"':
            pos[0] += 1
        return text[start:pos[0]]

    def parse_num():
        start = pos[0]
        if text[pos[0]] == '-':
            pos[0] += 1
        while pos[0] < len(text) and (text[pos[0]].isdigit() or text[pos[0]] == '.'):
            pos[0] += 1
        s = text[start:pos[0]]
        return float(s) if '.' in s else int(s)

    return val()


def make_block_id():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))


# Logseq named colors → app rgba colors (closest match)
_LOGSEQ_COLORS = {
    'yellow': 'rgba(255, 226, 143, 0.65)',
    'orange': 'rgba(255, 226, 143, 0.65)',
    'red':    'rgba(255, 226, 143, 0.65)',
    'green':  'rgba(170, 235, 170, 0.65)',
    'blue':   'rgba(155, 205, 255, 0.65)',
    'purple': 'rgba(230, 180, 255, 0.65)',
    'pink':   'rgba(230, 180, 255, 0.65)',
}


def map_color(c):
    """Map a Logseq color name to the app's closest rgba color."""
    return _LOGSEQ_COLORS.get(str(c).lower().strip(), 'rgba(255, 226, 143, 0.65)')


def parse_logseq_md(text):
    """Parse a Logseq PDF-highlights .md file into a block tree."""
    lines = text.split('\n')

    def count_tabs(line):
        n = 0
        while n < len(line) and line[n] == '\t':
            n += 1
        return n

    root = {'content': '', 'indent': -1, 'properties': {}, 'children': []}
    stack = [root]
    i = 0
    # skip front-matter (lines before first bare `-` or tab-indented block)
    while i < len(lines):
        l = lines[i].rstrip()
        if re.match(r'^\t*- ?', l):
            break
        i += 1

    while i < len(lines):
        line = lines[i].rstrip()
        tabs = count_tabs(line)
        rest = line[tabs:]

        if rest == '-' or rest.startswith('- '):
            content = rest[2:].strip() if rest.startswith('- ') else ''
            props = {}
            j = i + 1
            # consume property continuation lines (same tab depth + 2 spaces)
            prop_prefix = '\t' * tabs + '  '
            while j < len(lines):
                pl = lines[j].rstrip()
                if pl.startswith(prop_prefix) and not pl[len(prop_prefix):].startswith('- '):
                    prop_body = pl[len(prop_prefix):]
                    if ':: ' in prop_body:
                        k, v = prop_body.split(':: ', 1)
                        props[k.strip()] = v.strip()
                    j += 1
                else:
                    break
            i = j
            block = {'content': content, 'indent': tabs, 'properties': props, 'children': []}
            while len(stack) > 1 and stack[-1]['indent'] >= tabs:
                stack.pop()
            stack[-1]['children'].append(block)
            stack.append(block)
        else:
            i += 1

    return root['children']


def _collect_notes(block):
    """Return note text from direct non-annotation children."""
    return [c['content'] for c in block.get('children', [])
            if c['properties'].get('ls-type') != 'annotation' and c['content']]


def md_to_ordered_blocks(md_blocks, edn_by_quote, edn_by_uuid):
    """
    Walk the MD tree in document order and produce import blocks.
    Matched annotations → highlight blocks (EDN position data).
    Unmatched annotations / plain blocks → plain note blocks.
    Returns (ordered_blocks, used_edn_quotes).
    """
    ordered = []
    used_quotes = set()

    def make_highlight(edn, notes, color_name):
        bid = make_block_id()
        ordered.append({
            'id': bid,
            'content': notes,
            'properties': json.dumps({
                'highlight_id': bid,
                'color': map_color(color_name or edn.get('color', 'yellow')),
                'quote': edn['quote'],
                'pdf_page': edn['page'],
                'pdf_position': edn['position'],
            }),
        })
        used_quotes.add(edn['quote'])

    def make_note(content):
        if content:
            ordered.append({'id': make_block_id(), 'content': content, 'properties': json.dumps({})})

    def process(block):
        props = block['properties']
        content = block['content'].strip()
        is_annotation = props.get('ls-type') == 'annotation'

        if is_annotation and content:
            notes = '\n'.join(_collect_notes(block)).strip()
            uid = props.get('id', '')
            edn = edn_by_uuid.get(uid) or edn_by_quote.get(content.strip())
            if edn:
                make_highlight(edn, notes, props.get('hl-color'))
            else:
                # Still a real highlight — just no bounding box in this EDN snapshot
                page = props.get('hl-page', '')
                bid = make_block_id()
                ordered.append({
                    'id': bid,
                    'content': notes,
                    'properties': json.dumps({
                        'highlight_id': bid,
                        'color': map_color(props.get('hl-color', 'yellow')),
                        'quote': content,
                        'pdf_page': int(page) if page else None,
                        'pdf_position': None,
                    }),
                })
            # Recurse only into annotation children
            for child in block.get('children', []):
                if child['properties'].get('ls-type') == 'annotation':
                    process(child)
        elif content and not is_annotation and not content.startswith('#') and content not in ('-', ''):
            make_note(content)
            for child in block.get('children', []):
                process(child)
        else:
            for child in block.get('children', []):
                process(child)

    for block in md_blocks:
        process(block)
    return ordered, used_quotes


def edn_highlight_position(h):
    """Extract (page, position dict) from an EDN highlight entry."""
    pos_edn = h.get('position', {})
    page = h.get('page') or pos_edn.get('page') or 1
    bounding = pos_edn.get('bounding', {})
    rects = pos_edn.get('rects', [])

    def add_page(r):
        return {**r, 'pageNumber': page}

    return page, {
        'pageNumber': page,
        'boundingRect': add_page(bounding),
        'rects': [add_page(r) for r in rects],
    }


def edn_highlight_to_block(h):
    bid = make_block_id()
    page, pdf_position = edn_highlight_position(h)
    props = h.get('properties', {})
    quote = (h.get('content') or {}).get('text', '')
    return {
        'id': bid,
        'content': '',
        'properties': json.dumps({
            'highlight_id': bid,
            'color': map_color(props.get('color', 'yellow')),
            'quote': quote,
            'pdf_page': page,
            'pdf_position': pdf_position,
        }),
    }
