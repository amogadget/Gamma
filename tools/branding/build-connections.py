"""Regenerate the light/dark connections illustrations (Python standard library)."""
import base64
import xml.etree.ElementTree as ET

from branding import ROOT, MARK, write_svg

BRANDS = ROOT / 'frontend/src/shared/illustrations/brands'


def icon_path(name):
    return ET.parse(BRANDS / f'{name}.svg').getroot().find('{http://www.w3.org/2000/svg}path').attrib['d']


openai, claude, obsidian, notion = map(icon_path, ('openai', 'claude', 'obsidian', 'notion'))
zotero = base64.b64encode((BRANDS / 'zotero.png').read_bytes()).decode('ascii')

for theme in ('light', 'dark'):
    dark = theme == 'dark'
    bg, card, ink, muted, edge, inset, chip, chipink = (
        ('#1b1b1a', '#262624', '#f0ede6', '#a9a69e', '#3a3936', '#2f2f2c', '#3a3122', '#f0c470') if dark else
        ('#f6f4ef', '#ffffff', '#1a1a18', '#6b6a65', '#e3e0d8', '#f2f0ea', '#ecdfc4', '#5a4a24')
    )
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080" role="img" aria-labelledby="title desc">
  <title id="title">Gamma PDF: your research, connected</title>
  <desc id="desc">Gamma connects to three groups: ChatGPT and Claude plugins together on the left, Gamma Connector below, and Obsidian, Notion, and Zotero together on the right.</desc>
  <defs>
{MARK.replace('#1a1a18', ink)}
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000000" flood-opacity="{'0.24' if dark else '0.10'}"/>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M2 2 8 5 2 8" fill="none" stroke="#e8a020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <rect width="1920" height="1080" fill="{bg}"/>
  <g fill="none" stroke="#e8a020" stroke-width="3" opacity="0.18">
    <path d="M-50 920 C230 1130 610 1090 920 1010 S1520 1020 1980 1110"/>
    <path d="M-50 960 C260 1170 620 1130 960 1055 S1560 1070 1980 1150"/>
  </g>
  <g font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
    <use href="#gammaLogo" transform="translate(140 80) scale(0.6)"/>
    <text x="140" y="235" font-size="64" font-weight="600" letter-spacing="-2" fill="{ink}">Your research. Connected.</text>

    <!-- Each surrounding cluster has one box and one connection to Gamma. -->
    <g fill="none" stroke="#e8a020" stroke-width="3" stroke-linecap="round">
      <path d="M600 550 H800"/>
      <path d="M1120 550 H1320"/>
      <path d="M960 800 V678" stroke-dasharray="3 10" marker-end="url(#arrow)"/>
    </g>

    <rect x="140" y="380" width="460" height="340" rx="22" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
    <text x="184" y="437" font-size="26" font-weight="600" fill="{muted}">PLUGINS</text>
    <path d="{openai}" transform="translate(184 485) scale(2.25)" fill="{'#45c5a1' if dark else '#10a37f'}"/>
    <text x="264" y="525" font-size="36" font-weight="600" fill="{ink}">ChatGPT</text>
    <path d="{claude}" transform="translate(184 595) scale(2.25)" fill="{'#e5a185' if dark else '#c15f3c'}"/>
    <text x="264" y="635" font-size="36" font-weight="600" fill="{ink}">Claude</text>

    <rect x="800" y="450" width="320" height="220" rx="22" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
    <use href="#gammaMark" transform="translate(936 480)"/>
    <text x="960" y="580" text-anchor="middle" font-size="42" font-weight="600" letter-spacing="-1" fill="{ink}">Gamma</text>
    <text x="960" y="625" text-anchor="middle" font-size="24" fill="{muted}">Papers + notes</text>

    <rect x="1320" y="380" width="460" height="340" rx="22" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
    <text x="1364" y="437" font-size="26" font-weight="600" fill="{muted}">NOTES &amp; KNOWLEDGE BASES</text>
    <path d="{obsidian}" transform="translate(1364 477) scale(2)" fill="{'#a78bfa' if dark else '#7c3aed'}"/>
    <text x="1440" y="515" font-size="34" font-weight="600" fill="{ink}">Obsidian</text>
    <path d="{notion}" transform="translate(1364 555) scale(2)" fill="{ink}"/>
    <text x="1440" y="593" font-size="34" font-weight="600" fill="{ink}">Notion</text>
    <image x="1364" y="633" width="48" height="48" href="data:image/png;base64,{zotero}"/>
    <text x="1440" y="671" font-size="34" font-weight="600" fill="{ink}">Zotero</text>

    <!-- A compact browser card identifies the capture extension. -->
    <g transform="translate(690 800)">
      <rect width="540" height="174" rx="22" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
      <path d="M0 46 H540" stroke="{edge}" stroke-width="1.5"/>
      <g fill="{edge}"><circle cx="28" cy="23" r="5"/><circle cx="48" cy="23" r="5"/><circle cx="68" cy="23" r="5"/></g>
      <rect x="100" y="12" width="410" height="22" rx="7" fill="{inset}"/>
      <use href="#gammaMark" transform="translate(32 86)"/>
      <text x="104" y="96" font-size="32" font-weight="600" fill="{ink}">Gamma Connector</text>
      <rect x="104" y="117" width="210" height="34" rx="10" fill="{chip}"/>
      <path d="M120 134 H137 M131 128 137 134 131 140" fill="none" stroke="{chipink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="150" y="142" font-size="21" font-weight="600" fill="{chipink}">Save to Gamma</text>
    </g>
  </g>
</svg>
'''
    write_svg(f'gamma-connections-{theme}', svg)
