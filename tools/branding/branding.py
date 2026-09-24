"""Shared pieces of the three illustration generators (Python standard library)."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'docs/assets/branding'

# The mark is independent of the hero composition.
_mark = (ROOT / 'design/brand/marks/favicon.svg').read_text(encoding='utf-8').strip()
ET.fromstring(_mark)  # The editable source must also open as a standalone SVG.
_mark = re.sub(r'\bwidth="32" height="32"', 'width="48" height="48"', _mark, count=1)
MARK = f'<g id="gammaMark">{_mark}</g>'
_logo = (ROOT / 'design/brand/compositions/logo.svg').read_text(encoding='utf-8').strip()
_logo = re.fullmatch(r'<svg\b[^>]*>(.*)</svg>', _logo, re.S).group(1)
_logo = _logo.replace('{{gamma-mark}}', _mark).replace('{{logo-text}}', '#1a1a18')
MARK += f'<g id="gammaLogo">{_logo}</g>'

# Shared framing for the README feature illustrations (1920 x 1080).
SCENE_LOGO = f'<g transform="translate(120 92) scale(0.5)">{_logo}</g>'
SCENE_SHADOW = '''<filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000000" flood-opacity="0.10"/>
    </filter>'''
SCENE_BACKGROUND = '''<rect width="1920" height="1080" fill="#f6f4ef"/>
  <g fill="none" stroke="#e8a020" stroke-width="3" opacity="0.22">
    <path d="M-60 920 C200 1160 510 1070 810 1000 S1400 920 1980 1080"/>
    <path d="M-60 985 C240 1210 590 1110 920 1055 S1530 1010 1980 1150"/>
  </g>'''


def scene_heading(title_lines, sub_lines):
    """A README scene's heading: 72 px title lines and 28 px introductory lines, each (y, text)."""
    out = [f'<text x="120" y="{y}" font-size="72" font-weight="600" letter-spacing="-2" fill="#1a1a18">{text}</text>'
           for y, text in title_lines]
    out += [f'<text x="122" y="{y}" font-size="28" fill="#6b6a65">{text}</text>' for y, text in sub_lines]
    return '\n    '.join(out)


def write_svg(stem, svg):
    target = ASSETS / f'{stem}.svg'
    target.write_text(svg, encoding='utf-8', newline='\n')
    ET.parse(target)
    print(target.relative_to(ROOT))


# ---- Typing, the same in every scene -------------------------------------------------
# A typed line is one <text> whose characters are <tspan>s switched on one after another
# (SMIL, calcMode discrete), so the glyphs sit where the viewer's font puts them; the
# caret and an optional name tag hop along estimated advances, and textLength pins the
# line to that estimate so the caret ends on the last letter in any system font.
FONT = "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
MONO = "'Cascadia Code', Consolas, 'Courier New', monospace"
_THIN, _WIDE = set("iljtfIr.,:;'|!()[]"), set('mwMW')


def _advance(ch, size, mono):
    if mono:
        return 0.6 * size
    if ch == ' ':
        return 0.28 * size
    if ch in _THIN:
        return 0.3 * size
    if ch in _WIDE:
        return 0.86 * size
    if ch.isupper():
        return 0.66 * size
    return 0.54 * size


def _moments(text, start, end):
    """When each character lands: a jittered per-key rhythm, slower after spaces and
    punctuation, scaled so the last key falls at `end`. Deterministic per text."""
    state = sum(ord(c) * (i + 7) for i, c in enumerate(text)) & 0xFFFFFFFF
    weights = []
    for i, ch in enumerate(text):
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        w = 0.6 + 0.8 * (state / 0x7FFFFFFF)
        if i and text[i - 1] == ' ':
            w *= 1.6
        if i and text[i - 1] in '.,;:?!':
            w *= 2.2
        weights.append(w)
    total = sum(weights)
    t, out = start, []
    for w in weights:
        t += (end - start) * w / total
        out.append(t)
    return out


def typewriter(text, x, y, loop, start, end, size=24, fill='#1a1a18', family=FONT, caret='#e8a020', label=None):
    """SVG for `text` typed at (x, y) between `start` and `end` seconds of a `loop`-second
    animation, gone again 0.3 s before the loop restarts. `label` = (name, colour) draws
    a collaborator's tag hanging under the caret."""
    mono = family == MONO
    ts = _moments(text, start, end)
    k = lambda t: f'{t / loop:.4f}'
    off = loop - 0.3
    spans, pos, xs = [], x, [x]
    for i, ch in enumerate(text):
        glyph = {'<': '&lt;', '>': '&gt;', '&': '&amp;'}.get(ch, ch)
        spans.append(f'<tspan opacity="0">{glyph}<animate attributeName="opacity" calcMode="discrete" values="0;1;0;0" keyTimes="0;{k(ts[i])};{k(off)};1" dur="{loop}s" repeatCount="indefinite"/></tspan>')
        pos += _advance(ch, size, mono)
        xs.append(pos)
    width = pos - x
    # One value per moment: parked at x until `start`, then a key per character, then back.
    hops = [x, x, *xs[1:], x, x]
    caret_x = ';'.join(f'{v:.1f}' for v in hops)
    caret_k = ';'.join([k(0), k(start), *(k(t) for t in ts), k(off), '1'])
    out = [f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" fill="{fill}" textLength="{width:.1f}" lengthAdjust="spacing" xml:space="preserve">{"".join(spans)}</text>',
           # The caret: visible from just before the first key until a moment after the last.
           f'<g opacity="0"><rect x="{x}" y="{y - size + 2}" width="2.5" height="{size + 6}" fill="{caret}">'
           f'<animate attributeName="x" calcMode="discrete" values="{caret_x}" keyTimes="{caret_k}" dur="{loop}s" repeatCount="indefinite"/>'
           f'<animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.55;1" dur="1.1s" repeatCount="indefinite"/></rect>'
           f'<animate attributeName="opacity" calcMode="discrete" values="0;1;0;0" keyTimes="0;{k(max(0, start - 0.25))};{k(min(off, end + 0.8))};1" dur="{loop}s" repeatCount="indefinite"/></g>']
    if label:
        name, colour = label
        w = int(len(name) * 11 + 26)
        out.append(f'<g opacity="0"><g><rect x="-12" y="{y + 10}" width="{w}" height="29" rx="6" fill="{colour}"/>'
                   f'<text x="{w / 2 - 12:.0f}" y="{y + 31}" text-anchor="middle" font-family="{FONT}" font-size="18" font-weight="600" fill="#ffffff">{name}</text>'
                   f'<animateTransform attributeName="transform" type="translate" calcMode="discrete" values="{";".join(f"{v:.1f} 0" for v in hops)}" keyTimes="{caret_k}" dur="{loop}s" repeatCount="indefinite"/></g>'
                   f'<animate attributeName="opacity" calcMode="discrete" values="0;1;0;0" keyTimes="0;{k(max(0, start - 0.25))};{k(off)};1" dur="{loop}s" repeatCount="indefinite"/></g>')
    return ''.join(out)
