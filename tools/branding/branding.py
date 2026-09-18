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
