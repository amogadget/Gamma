"""Regenerate the light/dark 'read from any place' illustrations: one library on the
server, edited from the iPad, and the edit reaching every other device as it is typed."""
from branding import MARK, DARK_PALETTE, to_dark, write_svg, typewriter

LOOP = 8  # seconds: a note is typed on the shared page, the sync runs, every device shows it
K = lambda *ts: ';'.join(f'{t / LOOP:.4f}' for t in ts)  # keyTimes from seconds
TYPE_START, TYPE_END = 0.8, 3.8
LANDED = TYPE_END + 0.6  # when the other devices show the new line


def landed_line(x, y, w):
    """A device's screen gets the new note line once the round has run."""
    return (f'<rect x="{x}" y="{y}" width="{w}" height="6" rx="3" fill="#e8a020" opacity="0">'
            + f'<animate attributeName="opacity" values="0;0;0.9;0.9;0" keyTimes="{K(0, LANDED, LANDED + 0.25, LOOP - 0.3, LOOP)}" dur="{LOOP}s" repeatCount="indefinite"/></rect>')


svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080" role="img" aria-labelledby="title desc">
  <title id="title">Gamma PDF: read from any place</title>
  <desc id="desc">One library on the lab server, open on the office desktop, an iPad with a pencil and a phone. A note is typed on the shared page from the iPad; the sync button between the devices spins, and the new line appears on every other device's screen.</desc>
  <defs>
MARK
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#000000" flood-opacity="0.10"/>
    </filter>
    <g id="server" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="36" height="12" rx="4"/><rect x="2" y="21" width="36" height="12" rx="4"/>
      <circle cx="9" cy="9" r="1.6" fill="currentColor"/><circle cx="9" cy="27" r="1.6" fill="currentColor"/>
      <path d="M16 9 H31 M16 27 H31"/>
    </g>
    <g id="sync" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 12 A8 8 0 0 1 18.5 7.5 M20 4 V9 H15"/><path d="M20 12 A8 8 0 0 1 5.5 16.5 M4 20 V15 H9"/>
    </g>
    <g id="pencil" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 21 L17 7 L21 11 L7 25 L2 26 Z M14 10 L18 14"/>
    </g>
    <g id="lines" fill="#cfccc4">
      <rect x="0" y="0" width="150" height="6" rx="3"/><rect x="0" y="14" width="150" height="6" rx="3"/><rect x="0" y="28" width="110" height="6" rx="3"/>
    </g>
  </defs>
  <rect width="1920" height="1080" fill="#f6f4ef"/>
  <!-- Warm paper and amber curves match the opening hero. -->
  <g fill="none" stroke="#e8a020" stroke-width="3" opacity="0.22">
    <path d="M-60 900 C220 1140 560 1040 820 970 S1440 930 1980 1060"/>
    <path d="M-60 960 C260 1180 620 1090 880 1020 S1520 1000 1980 1120"/>
  </g>
  <g font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
    <use href="#gammaLogo" transform="translate(120 132) scale(0.6)"/>
    <text x="120" y="338" font-size="80" font-weight="600" letter-spacing="-2" fill="#1a1a18">Read from</text>
    <text x="120" y="430" font-size="80" font-weight="600" letter-spacing="-2" fill="#1a1a18">any place.</text>
    <text x="122" y="500" font-size="28" fill="#6b6a65">One library on your server, open on every device.</text>
    <text x="122" y="542" font-size="28" fill="#6b6a65">A note written on one is on all of them as you type.</text>
    <g font-size="22" font-weight="500" fill="#5a4a24">
      <rect x="122" y="596" width="176" height="44" rx="22" fill="#ecdfc4"/><text x="210" y="625" text-anchor="middle">Any browser</text>
      <rect x="314" y="596" width="184" height="44" rx="22" fill="#ecdfc4"/><text x="406" y="625" text-anchor="middle">iPad + Pencil</text>
      <rect x="514" y="596" width="134" height="44" rx="22" fill="#ecdfc4"/><text x="581" y="625" text-anchor="middle">Desktop</text>
    </g>
    <text x="122" y="700" font-size="23" fill="#6b6a65">Reading position, tabs and zoom follow your account everywhere.</text>

    <!-- The server holds the one library; the page is being edited from the iPad. -->
    <rect x="1000" y="140" width="780" height="400" rx="20" fill="#ffffff" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
    <use href="#server" x="1032" y="170" color="#9a6b18"/>
    <text x="1088" y="197" font-size="30" font-weight="600" fill="#1a1a18">Lab NAS</text>
    <rect x="1240" y="170" width="214" height="40" rx="20" fill="#ecdfc4"/>
    <text x="1347" y="197" text-anchor="middle" font-size="21" font-weight="500" fill="#5a4a24">Quantum lab</text>
    <circle cx="1650" cy="190" r="6" fill="#43a77c"><animate attributeName="opacity" values="1;0.35;1" dur="2.4s" repeatCount="indefinite"/></circle>
    <text x="1666" y="197" font-size="21" fill="#6b6a65">3 online</text>
    <path d="M1000 230 H1780" stroke="#e3e0d8" stroke-width="1.5"/>
    <!-- The paper itself: a page thumbnail with its highlight, left of the notes. -->
    <rect x="1032" y="262" width="160" height="220" rx="8" fill="#ffffff" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
    <rect x="1050" y="284" width="90" height="7" rx="3.5" fill="#8d8a82"/>
    <rect x="1050" y="298" width="60" height="5" rx="2.5" fill="#b9b6ae"/>
    <g fill="#cfccc4">
      <rect x="1050" y="318" width="124" height="5" rx="2.5"/><rect x="1050" y="331" width="124" height="5" rx="2.5"/><rect x="1050" y="344" width="98" height="5" rx="2.5"/>
      <rect x="1050" y="357" width="124" height="5" rx="2.5"/><rect x="1050" y="370" width="124" height="5" rx="2.5"/><rect x="1050" y="383" width="110" height="5" rx="2.5"/>
      <rect x="1050" y="396" width="124" height="5" rx="2.5"/><rect x="1050" y="409" width="124" height="5" rx="2.5"/><rect x="1050" y="422" width="80" height="5" rx="2.5"/>
      <rect x="1050" y="435" width="124" height="5" rx="2.5"/><rect x="1050" y="448" width="124" height="5" rx="2.5"/><rect x="1050" y="461" width="60" height="5" rx="2.5"/>
    </g>
    <rect x="1047" y="354" width="130" height="11" rx="3" fill="#ffe28f" opacity="0.85"/>
    <rect x="1047" y="367" width="78" height="11" rx="3" fill="#ffe28f" opacity="0.85"/>
    <text x="1112" y="510" text-anchor="middle" font-size="16" font-weight="600" letter-spacing="1.5" fill="#6b6a65">PDF</text>
    <text x="1222" y="272" font-size="18" font-weight="600" letter-spacing="2" fill="#6b6a65">PAPERS / ATOM ARRAYS</text>
    <text x="1222" y="316" font-size="28" font-weight="600" fill="#1a1a18">Coherence in atom arrays</text>
    <rect x="1222" y="338" width="6" height="52" rx="3" fill="#f3c65f"/>
    <text x="1246" y="360" font-family="Georgia, 'Times New Roman', serif" font-size="22" font-style="italic" fill="#6b6a65">“Repeated measurements reveal</text>
    <text x="1246" y="388" font-family="Georgia, 'Times New Roman', serif" font-size="22" font-style="italic" fill="#6b6a65">the coherence time of the array.”</text>
    <circle cx="1232" cy="431" r="5" fill="#a5a197"/>
    <text x="1252" y="439" font-size="24" fill="#1a1a18">Compare the two trapping geometries.</text>
    <circle cx="1232" cy="483" r="5" fill="#a5a197">
      <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="{K(0, TYPE_START - 0.3, TYPE_START - 0.2, LOOP - 0.3, LOOP)}" dur="{LOOP}s" repeatCount="indefinite"/>
    </circle>
    {typewriter('Add the lifetime data', 1252, 491, LOOP, TYPE_START, TYPE_END, label=('iPad', '#287956'))}

    <!-- Every device reads the same library; the sync sits where their lines meet. -->
    <g fill="none" stroke="#e8a020" stroke-width="2.5" opacity="0.7">
      <path d="M1390 540 V596"/>
      <path d="M1070 700 V650 Q1070 634 1086 634 H1350"/>
      <path d="M1390 668 V700"/>
      <path d="M1710 700 V650 Q1710 634 1694 634 H1430"/>
    </g>
    <circle cx="1390" cy="634" r="34" fill="#ffffff" stroke="#e8a020" stroke-width="2.5" filter="url(#shadow)"/>
    <use href="#sync" x="1378" y="622" color="#e8a020">
      <animateTransform attributeName="transform" type="rotate" values="0 1390 634;0 1390 634;1080 1390 634;1080 1390 634" keyTimes="{K(0, TYPE_START, LANDED + 0.4, LOOP)}" dur="{LOOP}s" repeatCount="indefinite"/>
    </use>
    <g transform="translate(960 700)">
      <rect width="220" height="150" rx="18" fill="#ffffff" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
      <rect x="28" y="26" width="164" height="76" rx="8" fill="#f2f0ea" stroke="#d8d4ca" stroke-width="2"/>
      <use href="#lines" transform="translate(40 40) scale(0.9)"/>
      {landed_line(40, 82, 96)}
      <path d="M92 102 V114 H128 V102" fill="none" stroke="#d8d4ca" stroke-width="2"/>
      <text x="110" y="136" text-anchor="middle" font-size="19" fill="#6b6a65">Office desktop</text>
    </g>
    <g transform="translate(1280 700)">
      <rect width="220" height="150" rx="18" fill="#ffffff" stroke="#e8a020" stroke-width="2" filter="url(#shadow)"/>
      <rect x="50" y="20" width="120" height="92" rx="10" fill="#f2f0ea" stroke="#d8d4ca" stroke-width="2"/>
      <use href="#lines" transform="translate(64 34) scale(0.62)"/>
      <rect x="64" y="76" width="0" height="4" rx="2" fill="#e8a020">
        <animate attributeName="width" values="0;0;70;70;0" keyTimes="{K(0, TYPE_START, TYPE_END, LOOP - 0.3, LOOP)}" dur="{LOOP}s" repeatCount="indefinite"/>
      </rect>
      <use href="#pencil" x="146" y="44" color="#9a6b18"/>
      <text x="110" y="136" text-anchor="middle" font-size="19" fill="#6b6a65">iPad + pencil</text>
    </g>
    <g transform="translate(1600 700)">
      <rect width="220" height="150" rx="18" fill="#ffffff" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
      <rect x="82" y="16" width="56" height="100" rx="10" fill="#f2f0ea" stroke="#d8d4ca" stroke-width="2"/>
      <use href="#lines" transform="translate(92 34) scale(0.24)"/>
      <use href="#lines" transform="translate(92 52) scale(0.24)"/>
      {landed_line(92, 72, 30)}
      <text x="110" y="136" text-anchor="middle" font-size="19" fill="#6b6a65">Phone</text>
    </g>
    <text x="1390" y="920" text-anchor="middle" font-size="24" fill="#6b6a65">Same page, every screen — as you type.</text>
  </g>
</svg>
'''.replace('MARK', MARK)

write_svg('gamma-anywhere-light', svg)
palette = {**DARK_PALETTE, '#8d8a82': '#8a877f', '#b9b6ae': '#5b5952', '#ffe28f': '#b98a2a', '#d8d4ca': '#4c4a43', '#cfccc4': '#4c4a43', '#a5a197': '#7d7a72', '#f3c65f': '#b98a2a'}
write_svg('gamma-anywhere-dark', to_dark(svg, palette, '0.10'))
