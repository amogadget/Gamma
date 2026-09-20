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

# Light-theme colours of the workspace and library scenes and their dark counterparts.
DARK_PALETTE = {
    '#f6f4ef': '#1b1b1a', '#ffffff': '#272725', '#e3e0d8': '#45443f',
    '#1a1a18': '#f0ede6', '#6b6a65': '#a9a69e', '#f2f0ea': '#32312e',
    '#ecdfc4': '#493b23', '#5a4a24': '#f1cf88', '#9a6b18': '#e8b451',
    '#e1f1e9': '#253e32', '#287956': '#6fc89f',
}


def to_dark(svg, palette, shadow):
    """Swap every palette colour and deepen the card shadow (light -> dark flood-opacity)."""
    dark = re.sub(r'#[0-9a-f]{6}', lambda m: palette.get(m[0], m[0]), svg)
    return dark.replace(f'flood-opacity="{shadow}"', 'flood-opacity="0.24"')


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
