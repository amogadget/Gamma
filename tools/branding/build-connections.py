"""Regenerate the light connections illustrations (Python standard library)."""
import base64
import xml.etree.ElementTree as ET

from branding import ROOT, MARK, write_svg, SCENE_LOGO, SCENE_SHADOW, SCENE_BACKGROUND

BRANDS = ROOT / 'frontend/src/shared/illustrations/brands'


def icon_path(name):
    return ET.parse(BRANDS / f'{name}.svg').getroot().find('{http://www.w3.org/2000/svg}path').attrib['d']


openai, claude, obsidian, notion = map(icon_path, ('openai', 'claude', 'obsidian', 'notion'))
zotero = base64.b64encode((BRANDS / 'zotero.png').read_bytes()).decode('ascii')

bg, card, ink, muted, edge, inset, chip, chipink = (
    ('#f6f4ef', '#ffffff', '#1a1a18', '#6b6a65', '#e3e0d8', '#f2f0ea', '#ecdfc4', '#5a4a24')
)
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080" role="img" aria-labelledby="title desc">
  <title id="title">Gamma PDF: your research, connected</title>
  <desc id="desc">Gamma in the middle of three connections. Left: an assistant prompt in Codex or Claude Code that mentions @Gamma and a paper card and asks how the blockade radius is measured; Gamma answers with papers and notes. Right: Obsidian, Notion and Zotero, with an Export arrow above and an Import arrow below. Bottom: the Gamma Connector browser extension saving a paper from a journal page, with the publisher sign-in saved per journal so the server can fetch its PDFs later.</desc>
  <defs>
{MARK.replace('#1a1a18', ink)}
    {SCENE_SHADOW}
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M2 2 8 5 2 8" fill="none" stroke="#e8a020" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  {SCENE_BACKGROUND}
  <g font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
    {SCENE_LOGO}
    <text x="120" y="235" font-size="72" font-weight="600" letter-spacing="-2" fill="{ink}">Your research. Connected.</text>
    <text x="122" y="288" font-size="28" fill="{muted}">Ask an assistant about your papers, save from the journal page,</text>
    <text x="122" y="326" font-size="28" fill="{muted}">and move notes to and from the tools you already use.</text>

    <!-- Each surrounding cluster has one box and its own connection to Gamma. -->
    <g fill="none" stroke="#e8a020" stroke-width="3" stroke-linecap="round">
      <path d="M800 550 H630" marker-end="url(#arrow)"/>
      <path d="M1130 520 H1300" marker-end="url(#arrow)"/>
      <path d="M1300 580 H1130" marker-end="url(#arrow)"/>
      <path d="M960 790 V678" stroke-dasharray="3 10" marker-end="url(#arrow)"/>
    </g>
    <text x="1215" y="502" text-anchor="middle" font-size="21" fill="{muted}">Export</text>
    <text x="1215" y="616" text-anchor="middle" font-size="21" fill="{muted}">Import</text>
    <text x="715" y="527" text-anchor="middle" font-size="21" fill="{muted}">Papers + notes</text>

    <!-- Assistants: a Codex-style prompt that mentions Gamma and a paper card. -->
    <rect x="140" y="360" width="480" height="380" rx="22" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
    <text x="184" y="412" font-size="24" font-weight="600" fill="{muted}">ASSISTANTS</text>
    <rect x="184" y="440" width="392" height="176" rx="16" fill="{inset}" stroke="{edge}" stroke-width="1.5"/>
    <rect x="202" y="460" width="112" height="36" rx="10" fill="{chip}"/>
    <text x="258" y="486" text-anchor="middle" font-size="22" font-weight="600" fill="{chipink}">@Gamma</text>
    <text x="326" y="486" font-size="24" fill="{ink}">in</text>
    <rect x="354" y="460" width="178" height="36" rx="10" fill="{card}" stroke="{edge}" stroke-width="1.5"/>
    <path d="M366 468 H378 L384 474 V488 H366 Z M378 468 V474 H384" fill="none" stroke="{muted}" stroke-width="1.6" stroke-linejoin="round"/>
    <text x="392" y="486" font-size="20" fill="{ink}">Rydberg arrays</text>
    <text x="202" y="530" font-size="24" fill="{ink}">how is the blockade radius</text>
    <text x="202" y="562" font-size="24" fill="{ink}">measured?</text>
    <rect x="330" y="540" width="2.5" height="28" fill="#e8a020"><animate attributeName="opacity" values="1;1;0;0" dur="1.1s" repeatCount="indefinite"/></rect>
    <path d="M202 598 H558" stroke="{edge}"/>
    <path d="{openai}" transform="translate(184 646) scale(1.75)" fill="#10a37f"/>
    <text x="238" y="678" font-size="26" font-weight="600" fill="{ink}">Codex</text>
    <path d="{claude}" transform="translate(340 646) scale(1.75)" fill="#c15f3c"/>
    <text x="394" y="678" font-size="26" font-weight="600" fill="{ink}">Claude Code</text>
    <text x="184" y="716" font-size="19" fill="{muted}">Any MCP client · one workspace you approve</text>

    <rect x="800" y="450" width="320" height="220" rx="22" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
    <use href="#gammaMark" transform="translate(936 480)"/>
    <text x="960" y="580" text-anchor="middle" font-size="42" font-weight="600" letter-spacing="-1" fill="{ink}">Gamma</text>
    <text x="960" y="625" text-anchor="middle" font-size="24" fill="{muted}">Papers + notes</text>

    <rect x="1300" y="380" width="480" height="340" rx="22" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
    <text x="1344" y="432" font-size="24" font-weight="600" fill="{muted}">NOTES &amp; REFERENCE MANAGERS</text>
    <path d="{obsidian}" transform="translate(1344 465) scale(2)" fill="#7c3aed"/>
    <text x="1420" y="503" font-size="34" font-weight="600" fill="{ink}">Obsidian</text>
    <path d="{notion}" transform="translate(1344 543) scale(2)" fill="{ink}"/>
    <text x="1420" y="581" font-size="34" font-weight="600" fill="{ink}">Notion</text>
    <image x="1344" y="621" width="48" height="48" href="data:image/png;base64,{zotero}"/>
    <text x="1420" y="659" font-size="34" font-weight="600" fill="{ink}">Zotero</text>
    <text x="1620" y="503" font-size="19" fill="{muted}">vault, wikilinks</text>
    <text x="1620" y="581" font-size="19" fill="{muted}">export zip</text>
    <text x="1620" y="659" font-size="19" fill="{muted}">RDF + annotations</text>

    <!-- The capture extension: one click saves the paper; a publisher sign-in is kept per journal. -->
    <g transform="translate(600 790)">
      <rect width="720" height="230" rx="22" fill="{card}" stroke="{edge}" stroke-width="1.5" filter="url(#shadow)"/>
      <path d="M0 46 H720" stroke="{edge}" stroke-width="1.5"/>
      <g fill="{edge}"><circle cx="28" cy="23" r="5"/><circle cx="48" cy="23" r="5"/><circle cx="68" cy="23" r="5"/></g>
      <rect x="100" y="12" width="590" height="22" rx="7" fill="{inset}"/>
      <text x="112" y="29" font-size="15" fill="{muted}">journals.aps.org/prl/abstract/10.1103/PhysRevLett…</text>
      <use href="#gammaMark" transform="translate(32 76)"/>
      <text x="104" y="88" font-size="30" font-weight="600" fill="{ink}">Gamma Connector</text>
      <rect x="104" y="106" width="196" height="36" rx="10" fill="{chip}"/>
      <path d="M120 124 H137 M131 118 137 124 131 130" fill="none" stroke="{chipink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="150" y="132" font-size="20" font-weight="600" fill="{chipink}">Save to Gamma</text>
      <text x="320" y="131" font-size="19" fill="{muted}">PDF, metadata, folder, labels</text>
      <!-- Cookie: the journal sign-in this browser holds, saved once per publisher. -->
      <g transform="translate(104 168)">
        <circle cx="12" cy="12" r="11" fill="none" stroke="{muted}" stroke-width="2"/>
        <g fill="{muted}"><circle cx="8" cy="9" r="1.8"/><circle cx="15" cy="8" r="1.5"/><circle cx="10" cy="15" r="1.6"/><circle cx="16" cy="14" r="1.8"/></g>
      </g>
      <text x="138" y="186" font-size="20" fill="{ink}">Publisher sign-in saved</text>
      <g font-size="17" font-weight="500">
        <rect x="374" y="166" width="88" height="30" rx="15" fill="{inset}" stroke="{edge}"/><text x="418" y="187" text-anchor="middle" fill="{muted}">✓ APS</text>
        <rect x="470" y="166" width="102" height="30" rx="15" fill="{inset}" stroke="{edge}"/><text x="521" y="187" text-anchor="middle" fill="{muted}">✓ Nature</text>
        <rect x="580" y="166" width="108" height="30" rx="15" fill="{inset}" stroke="{edge}"/><text x="634" y="187" text-anchor="middle" fill="{muted}">✓ Science</text>
      </g>
      <text x="138" y="214" font-size="17" fill="{muted}">so the server can fetch that journal's PDFs later, on its own</text>
    </g>
  </g>
</svg>
'''
write_svg('gamma-connections-light', svg)
