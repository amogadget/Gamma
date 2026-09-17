"""Build the Link and organize story in Gamma's light/dark branding style."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'docs/assets/branding'
source = (ASSETS / 'gamma-connections-light.svg').read_text(encoding='utf-8')
mark = source[source.index('    <radialGradient'):source.index('    <filter')]

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080" role="img" aria-labelledby="title desc">
  <title id="title">Gamma PDF: find your papers, follow your ideas</title>
  <desc id="desc">Download a paper and Gamma automatically fills its title, authors, journal and year. Organize papers with hierarchical folders and cross-cutting labels, and search titles, notes and full PDF text. While reading, follow a reference to another paper, then use Back to return to your previous reading position.</desc>
  <defs>
MARK
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000000" flood-opacity="0.09"/>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M2 2 8 5 2 8" fill="none" stroke="#9a6b18" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
    <g id="folder" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <path d="M1 7 V3 H12 L17 7 H29 V25 H1 Z"/>
    </g>
    <g id="page" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
      <path d="M2 1 H15 L22 8 V29 H2 Z M15 1 V8 H22 M7 15 H17 M7 21 H17"/>
    </g>
    <g id="search" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
      <circle cx="11" cy="11" r="8"/><path d="M17 17 25 25"/>
    </g>
    <g id="check" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 9 7 14 18 3"/>
    </g>
  </defs>
  <rect width="1920" height="1080" fill="#f6f4ef"/>
  <g fill="none" stroke="#e8a020" stroke-width="3" opacity="0.22">
    <path d="M-60 920 C200 1160 510 1070 810 1000 S1400 920 1980 1080"/>
    <path d="M-60 985 C240 1210 590 1110 920 1055 S1530 1010 1980 1150"/>
  </g>
  <g font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
    <use href="#gammaMark" transform="translate(100 92) scale(1.2)"/>
    <text x="178" y="138" font-size="44" font-weight="700" letter-spacing="-1" fill="#1a1a18">Gamma<tspan dx="11" font-weight="400" fill="#e8a020">PDF</tspan></text>
    <text x="100" y="255" font-size="76" font-weight="600" letter-spacing="-2" fill="#1a1a18">Find your papers. Follow your ideas.</text>
    <text x="103" y="313" font-size="29" fill="#6b6a65">From the first download to the next connection — without losing your place.</text>

    <!-- Three stages, connected in reading order. -->
    <g font-size="25" font-weight="600" fill="#1a1a18">
      <text x="102" y="396"><tspan fill="#9a6b18">01</tspan><tspan dx="16">Bring a paper in</tspan></text>
      <text x="602" y="396"><tspan fill="#9a6b18">02</tspan><tspan dx="16">Make it easy to find</tspan></text>
      <text x="1212" y="396"><tspan fill="#9a6b18">03</tspan><tspan dx="16">Keep the ideas connected</tspan></text>
    </g>
    <g fill="none" stroke="#9a6b18" stroke-width="2.5" marker-end="url(#arrow)">
      <path d="M553 690 H587"/><path d="M1163 690 H1197"/>
    </g>

    <!-- Download: the title and bibliographic fields arrive with the paper. -->
    <rect x="100" y="428" width="450" height="520" rx="20" fill="#ffffff" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
    <rect x="126" y="455" width="398" height="54" rx="10" fill="#f2f0ea"/>
    <path d="M150 472 V490 M144 484 150 490 156 484 M140 496 H160" fill="none" stroke="#9a6b18" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="174" y="489" font-size="21" fill="#6b6a65">Paste an arXiv / DOI link</text>
    <circle cx="148" cy="548" r="17" fill="#e1f1e9"/>
    <use href="#check" x="138" y="540" color="#287956"/>
    <text x="177" y="556" font-size="23" font-weight="600" fill="#1a1a18">Paper downloaded</text>
    <path d="M126 585 H524" stroke="#e3e0d8"/>
    <text x="128" y="616" font-size="17" font-weight="600" letter-spacing="1.8" fill="#6b6a65">TITLE</text>
    <text x="128" y="650" font-size="23" font-weight="600" fill="#1a1a18">A quantum processor based on</text>
    <text x="128" y="679" font-size="23" font-weight="600" fill="#1a1a18">coherent transport of entangled</text>
    <text x="128" y="708" font-size="23" font-weight="600" fill="#1a1a18">atom arrays</text>
    <text x="128" y="748" font-size="17" font-weight="600" letter-spacing="1.8" fill="#6b6a65">AUTHORS</text>
    <text x="128" y="779" font-size="23" fill="#1a1a18">Bluvstein et al.</text>
    <text x="128" y="820" font-size="17" font-weight="600" letter-spacing="1.8" fill="#6b6a65">JOURNAL / YEAR</text>
    <text x="128" y="851" font-size="23" fill="#1a1a18">Nature · 2022</text>
    <rect x="126" y="875" width="398" height="45" rx="9" fill="#faf4e8"/>
    <text x="325" y="904" text-anchor="middle" font-size="21" font-weight="500" fill="#9a6b18">Metadata filled automatically</text>

    <!-- One search can be narrowed by folder and cross-cutting label. -->
    <rect x="600" y="428" width="560" height="520" rx="20" fill="#ffffff" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
    <rect x="626" y="455" width="508" height="54" rx="10" fill="#ffffff" stroke="#d8d4ca" stroke-width="1.5"/>
    <use href="#search" x="642" y="469" color="#9a6b18"/>
    <text x="684" y="489" font-size="24" fill="#1a1a18">coherent transport</text>
    <path d="M915 469 V494" stroke="#9a6b18" stroke-width="2"/>
    <rect x="1033" y="467" width="86" height="30" rx="6" fill="#f2f0ea"/>
    <text x="1076" y="488" text-anchor="middle" font-size="16" fill="#6b6a65">Ctrl F</text>
    <rect x="627" y="525" width="292" height="36" rx="18" fill="#ecdfc4"/>
    <use href="#folder" transform="translate(641 533) scale(0.72)" color="#9a6b18"/>
    <text x="674" y="550" font-size="20" fill="#5a4a24">qc / neutral-atom</text>
    <rect x="930" y="525" width="203" height="36" rx="18" fill="#e1f1e9"/>
    <text x="948" y="550" font-size="20" fill="#287956"># quantum-optics</text>
    <path d="M600 582 H1160 M795 582 V876" stroke="#e3e0d8"/>
    <text x="627" y="621" font-size="17" font-weight="600" letter-spacing="1.6" fill="#6b6a65">FOLDERS</text>
    <use href="#folder" transform="translate(626 648) scale(0.8)" color="#9a6b18"/>
    <text x="663" y="668" font-size="23" fill="#1a1a18">qc</text>
    <path d="M638 683 V766 M638 704 H652 M638 754 H652" fill="none" stroke="#d8d4ca" stroke-width="2"/>
    <rect x="654" y="683" width="129" height="37" rx="7" fill="#ecdfc4"/>
    <text x="663" y="708" font-size="18" fill="#5a4a24">neutral-atom</text>
    <text x="661" y="760" font-size="18" fill="#6b6a65">cavity-QED</text>
    <use href="#folder" transform="translate(626 793) scale(0.8)" color="#6b6a65"/>
    <text x="663" y="813" font-size="21" fill="#6b6a65">to-read</text>
    <text x="819" y="621" font-size="17" font-weight="600" letter-spacing="1.6" fill="#6b6a65">SEARCH RESULTS</text>
    <rect x="814" y="640" width="319" height="206" rx="10" fill="#faf4e8" stroke="#ecdfc4"/>
    <use href="#page" transform="translate(830 657) scale(0.8)" color="#9a6b18"/>
    <text x="866" y="677" font-size="21" font-weight="600" fill="#1a1a18">Atom arrays</text>
    <text x="831" y="716" font-size="20" fill="#6b6a65">“…based on</text>
    <rect x="829" y="727" width="267" height="31" rx="4" fill="#ffe4a0"/>
    <text x="834" y="750" font-size="22" fill="#5a4a24">coherent transport…”</text>
    <rect x="831" y="785" width="142" height="32" rx="16" fill="#e1f1e9"/>
    <text x="902" y="807" text-anchor="middle" font-size="17" fill="#287956">quantum-optics</text>
    <path d="M626 875 H1134" stroke="#e3e0d8"/>
    <text x="880" y="912" text-anchor="middle" font-size="21" fill="#6b6a65">Search titles, notes and full PDF text</text>

    <!-- References take the reader forward; Back restores the previous place. -->
    <rect x="1210" y="428" width="610" height="520" rx="20" fill="#f2f0ea" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
    <rect x="1240" y="455" width="418" height="209" rx="12" fill="#ffffff" stroke="#d8d4ca" stroke-width="1.5"/>
    <text x="1265" y="490" font-size="17" font-weight="600" letter-spacing="1.5" fill="#6b6a65">READING NOW</text>
    <text x="1265" y="529" font-size="26" font-weight="600" fill="#1a1a18">Coherent atom transport</text>
    <path d="M1265 550 H1633" stroke="#e3e0d8"/>
    <text x="1265" y="585" font-family="Georgia, 'Times New Roman', serif" font-size="23" fill="#6b6a65">A path toward fault-tolerant</text>
    <text x="1265" y="619" font-family="Georgia, 'Times New Roman', serif" font-size="23" fill="#6b6a65">quantum computation</text>
    <rect x="1510" y="595" width="65" height="34" rx="6" fill="#ecdfc4"/>
    <text x="1542" y="620" text-anchor="middle" font-size="22" font-weight="600" fill="#9a6b18">[12]</text>
    <path d="M1586 613 H1718 Q1752 613 1752 647 V693" fill="none" stroke="#9a6b18" stroke-width="2.5" marker-end="url(#arrow)"/>
    <text x="1730" y="650" text-anchor="end" font-size="18" fill="#9a6b18">Follow</text>
    <text x="1730" y="676" text-anchor="end" font-size="18" fill="#9a6b18">reference</text>
    <rect x="1350" y="706" width="440" height="141" rx="12" fill="#ffffff" stroke="#d8d4ca" stroke-width="1.5"/>
    <use href="#page" transform="translate(1374 727) scale(0.75)" color="#9a6b18"/>
    <text x="1407" y="748" font-size="17" font-weight="600" letter-spacing="1.3" fill="#6b6a65">LINKED PAPER</text>
    <text x="1374" y="786" font-size="26" font-weight="600" fill="#1a1a18">Quantum error correction</text>
    <path d="M1374 810 H1734 M1374 823 H1626" fill="none" stroke="#d8d4ca" stroke-width="5" stroke-linecap="round"/>
    <path d="M1340 787 H1294 Q1266 787 1266 757 V679" fill="none" stroke="#9a6b18" stroke-width="2.5" stroke-dasharray="5 7" marker-end="url(#arrow)"/>
    <rect x="1240" y="873" width="164" height="45" rx="10" fill="#ecdfc4"/>
    <path d="M1270 896 H1255 M1262 889 1255 896 1262 903" fill="none" stroke="#5a4a24" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="1328" y="904" text-anchor="middle" font-size="23" font-weight="600" fill="#5a4a24">Back</text>
    <text x="1423" y="903" font-size="21" fill="#6b6a65">Right where you left off.</text>

    <text x="960" y="1013" text-anchor="middle" font-size="25" fill="#6b6a65">A library you can find your way around. A reading trail you can retrace.</text>
  </g>
</svg>
'''.replace('MARK', mark.rstrip())

DARK = {
    '#f6f4ef': '#1b1b1a', '#ffffff': '#272725', '#e3e0d8': '#45443f',
    '#1a1a18': '#f0ede6', '#6b6a65': '#a9a69e', '#f2f0ea': '#32312e',
    '#ecdfc4': '#493b23', '#5a4a24': '#f1cf88', '#9a6b18': '#e8b451',
    '#e1f1e9': '#253e32', '#287956': '#6fc89f', '#d8d4ca': '#555248',
    '#faf4e8': '#332d22', '#ffe4a0': '#5a4524',
}

for theme in ('light', 'dark'):
    svg = SVG
    if theme == 'dark':
        svg = re.sub(r'#[0-9a-f]{6}', lambda m: DARK.get(m[0], m[0]), svg)
        svg = svg.replace('flood-opacity="0.09"', 'flood-opacity="0.24"')
    target = ASSETS / f'gamma-library-{theme}.svg'
    target.write_text(svg, encoding='utf-8', newline='\n')
    ET.parse(target)
    print(target.relative_to(ROOT))
