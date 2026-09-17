"""Regenerate the light/dark connections illustrations (Python standard library)."""
from pathlib import Path
import re
import base64
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
obsidian = ET.parse(ROOT / 'frontend/src/shared/illustrations/brands/obsidian.svg').getroot()[1].attrib['d']
notion = ET.parse(ROOT / 'frontend/src/shared/illustrations/brands/notion.svg').getroot()[1].attrib['d']
zotero = base64.b64encode((ROOT / 'frontend/src/shared/illustrations/brands/zotero.png').read_bytes()).decode('ascii')
hero = (ROOT / 'docs/assets/branding/gamma-hero-light.svg').read_text(encoding='utf-8')
mark = re.search(r'<g transform="translate\(140 300\) scale\(2\)">(.*?)\n  </g>', hero, re.S).group(1)

for theme in ('light', 'dark'):
    dark = theme == 'dark'
    bg, card, ink, muted, edge, inset, chip, chipink = (
        ('#1b1b1a', '#262624', '#f0ede6', '#a9a69e', '#3a3936', '#2f2f2c', '#3a3122', '#f0c470') if dark else
        ('#f6f4ef', '#ffffff', '#1a1a18', '#6b6a65', '#e3e0d8', '#f2f0ea', '#ecdfc4', '#5a4a24')
    )
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080" role="img" aria-labelledby="title desc">
  <title id="title">Gamma PDF: your research, connected</title>
  <desc id="desc">Save papers and web clips with Gamma Connector. Import and export Obsidian vaults and Zotero libraries, import Notion exports, and let Codex search and read your Gamma library with read-only access.</desc>
  <defs>
    <radialGradient id="markGlow" cx="24" cy="18" r="22" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#e8a020" stop-opacity="0.3"/>
      <stop offset="1" stop-color="#e8a020" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="markClip"><rect width="48" height="48" rx="11"/></clipPath>
    <g id="gammaMark">{mark}
    </g>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000000" flood-opacity="{'0.24' if dark else '0.10'}"/>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M2 2 8 5 2 8" fill="none" stroke="#e8a020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <rect width="1920" height="1080" fill="{bg}"/>
  <!-- Amber paths echo the original hero's knowledge curves. -->
  <g fill="none" stroke="#e8a020" stroke-width="3" opacity="0.18">
    <path d="M-50 860 C230 1070 610 1030 920 950 S1520 960 1980 1050"/>
    <path d="M-50 900 C260 1110 620 1070 960 995 S1560 1010 1980 1090"/>
  </g>
  <g font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
    <!-- Promise and browser capture, in the same editorial layout as the hero. -->
    <use href="#gammaMark" transform="translate(140 132) scale(1.5)"/>
    <text x="236" y="186" font-size="58" font-weight="700" letter-spacing="-1.5" fill="{ink}">Gamma<tspan dx="14" font-weight="400" fill="#e8a020">PDF</tspan></text>
    <text x="140" y="328" font-size="80" font-weight="600" letter-spacing="-2" fill="{ink}">Your research.</text>
    <text x="140" y="420" font-size="80" font-weight="600" letter-spacing="-2" fill="{ink}">Connected.</text>
    <text x="142" y="492" font-size="28" fill="{muted}">Bring your notes. Take your highlights with you.</text>
    <text x="142" y="534" font-size="28" fill="{muted}">Save the next paper straight from your browser.</text>

    <!-- The connector feeds the library; file exchanges are explicitly directional. -->
    <g fill="none" stroke="#e8a020" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M830 770 C950 770 900 600 1010 600" stroke-dasharray="3 10" marker-end="url(#arrow)"/>
      <path d="M1340 506 C1414 506 1408 308 1480 308" marker-end="url(#arrow)"/>
      <path d="M1490 350 C1436 350 1442 538 1350 538" marker-end="url(#arrow)"/>
      <path d="M1490 560 H1350" marker-end="url(#arrow)"/>
      <path d="M1340 604 C1430 604 1398 778 1480 778" marker-end="url(#arrow)"/>
      <path d="M1490 820 C1398 820 1420 642 1350 642" marker-end="url(#arrow)"/>
    </g>

    <rect x="140" y="620" width="690" height="294" rx="18" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
    <path d="M140 680 H830" stroke="{edge}" stroke-width="1.5"/>
    <g fill="{edge}"><circle cx="168" cy="650" r="6"/><circle cx="190" cy="650" r="6"/><circle cx="212" cy="650" r="6"/></g>
    <rect x="250" y="636" width="430" height="29" rx="8" fill="{inset}"/>
    <text x="272" y="656" font-size="17" fill="{muted}">arXiv / DOI / publisher page</text>
    <use href="#gammaMark" transform="translate(776 632) scale(0.75)"/>
    <text x="170" y="734" font-size="30" font-weight="600" fill="{ink}">Gamma Connector</text>
    <text x="170" y="774" font-size="23" fill="{muted}">One click. Paper, metadata, folder, labels.</text>
    <rect x="170" y="814" width="228" height="56" rx="12" fill="{chip}"/>
    <path d="M192 842 H209 M203 836 209 842 203 848" fill="none" stroke="{chipink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="224" y="850" font-size="22" font-weight="600" fill="{chipink}">Save to Gamma</text>
    <text x="425" y="849" font-size="21" fill="{muted}">Clip links and selections, too.</text>

    <text x="1020" y="185" font-size="20" font-weight="600" letter-spacing="2" fill="{muted}">AT HOME IN YOUR WORKFLOW</text>
    <rect x="1020" y="460" width="320" height="228" rx="18" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
    <use href="#gammaMark" transform="translate(1050 490) scale(1)"/>
    <text x="1115" y="526" font-size="38" font-weight="600" letter-spacing="-1" fill="{ink}">Gamma</text>
    <path d="M1050 556 H1310" stroke="{edge}" stroke-width="1.5"/>
    <rect x="1050" y="580" width="40" height="52" rx="5" fill="{inset}" stroke="{edge}"/>
    <path d="M1060 594 H1080 M1060 604 H1080 M1060 614 H1073" fill="none" stroke="#e8a020" stroke-width="3" stroke-linecap="round"/>
    <text x="1106" y="598" font-size="22" fill="{ink}">Papers + notes</text>
    <text x="1106" y="630" font-size="22" fill="{muted}">Linked highlights</text>
    <text x="1180" y="668" text-anchor="middle" font-size="18" fill="{muted}">Your library, on your machine</text>
'''
    for name, y, detail, action, color in [
        ('Obsidian', 240, 'Vaults, links + notes', 'Import + export', '#a78bfa' if dark else '#7c3aed'),
        ('Notion', 475, 'Pages + notes', 'Import', ink),
        ('Zotero', 710, 'Papers + annotations', 'Import + export', '#ef7771' if dark else '#c74440'),
    ]:
        svg += f'''    <rect x="1490" y="{y}" width="330" height="170" rx="18" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
'''
        if name == 'Obsidian':
            svg += f'    <path d="{obsidian}" transform="translate(1516 {y+26}) scale(1.65)" fill="{color}"/>\n'
        elif name == 'Notion':
            svg += f'    <path d="{notion}" transform="translate(1516 {y+26}) scale(1.65)" fill="{color}"/>\n'
        else:
            svg += f'    <image x="1512" y="{y+22}" width="48" height="48" href="data:image/png;base64,{zotero}"/>\n'
        svg += f'''    <text x="1570" y="{y+58}" font-size="32" font-weight="600" fill="{ink}">{name}</text>
    <text x="1518" y="{y+98}" font-size="23" fill="{muted}">{detail}</text>
    <rect x="1518" y="{y+116}" width="{'196' if name != 'Notion' else '108'}" height="34" rx="17" fill="{inset}"/>
    <text x="1534" y="{y+140}" font-size="20" font-weight="500" fill="{color}">{action}</text>
'''
    svg += f'''    <!-- Codex reads the authorized library through MCP. -->
    <path d="M1180 700 V768" fill="none" stroke="#e8a020" stroke-width="3" stroke-linecap="round" marker-end="url(#arrow)"/>
    <rect x="1020" y="780" width="320" height="170" rx="18" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
    <rect x="1048" y="806" width="42" height="36" rx="7" fill="{inset}"/>
    <path d="M1058 816 1066 824 1058 832 M1072 832 H1080" fill="none" stroke="{ink}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="1106" y="838" font-size="32" font-weight="600" fill="{ink}">Codex</text>
    <text x="1048" y="878" font-size="23" fill="{muted}">Search + read your library</text>
    <rect x="1048" y="896" width="196" height="34" rx="17" fill="{inset}"/>
    <text x="1064" y="920" font-size="20" font-weight="500" fill="{'#e8a020' if dark else chipink}">Read-only · MCP</text>
  </g>
</svg>
'''
    target = ROOT / f'docs/assets/branding/gamma-connections-{theme}.svg'
    target.write_text(svg, encoding='utf-8', newline='\n')
    ET.parse(target)
    print(target.relative_to(ROOT))
