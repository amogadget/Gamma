"""Shared pieces of the three illustration generators (Python standard library)."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'docs/assets/branding'

# Every illustration reuses the hand-authored hero's Gamma mark, as one <defs> block.
_hero = (ASSETS / 'gamma-hero-light.svg').read_text(encoding='utf-8')
_mark = re.search(r'<g transform="translate\(140 300\) scale\(2\)">(.*?)\n  </g>', _hero, re.S).group(1)
MARK = f"""    <radialGradient id="markGlow" cx="24" cy="18" r="22" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#e8a020" stop-opacity="0.3"/>
      <stop offset="1" stop-color="#e8a020" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="markClip"><rect width="48" height="48" rx="11"/></clipPath>
    <g id="gammaMark">{_mark}
    </g>"""

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
