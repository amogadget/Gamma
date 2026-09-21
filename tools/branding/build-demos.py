"""Abstract, animated counterparts of the recorded README demos (an experiment next to
the WebP recordings, never a replacement): the idea of each interaction drawn in the
branding style, looping with SMIL so it plays inside a plain <img>. Light only: they
sit in the user guide, where a themed pair is not worth the extra files."""
from branding import MARK, FONT, MONO, write_svg, typewriter

W, H = 1600, 1000
MATH = "'Cambria Math', Cambria, Georgia, 'Times New Roman', serif"


def keytimes(loop, *ts):
    return ';'.join(f'{t / loop:.4f}' for t in ts)


def anim(attr, values, loop, *ts):
    return f'<animate attributeName="{attr}" values="{values}" keyTimes="{keytimes(loop, *ts)}" dur="{loop}s" repeatCount="indefinite"/>'


def show(loop, start, end, fade=0.15):
    """Opacity 0 → 1 at `start`, back to 0 at `end` (end may be the loop's end)."""
    if end >= loop:
        return anim('opacity', '0;0;1;1', loop, 0, start, start + fade, loop)
    return anim('opacity', '0;0;1;1;0;0', loop, 0, start, start + fade, end, end + fade, loop)


def typed(text, x, y, loop, start, end, size=24, family=FONT):
    """The shared typewriter; kept as a name so scenes read as before."""
    return typewriter(text, x, y, loop, start, end, size=size, family=family)


def pointer(points, loop, times):
    """The cursor dot travelling through (x, y) waypoints at the given seconds."""
    if times[-1] < loop:  # keyTimes must end at 1: hold the last waypoint, then jump back for the restart
        points, times = [*points, points[-1], points[0]], [*times, loop - 0.01, loop]
    values = ';'.join(f'{x} {y}' for x, y in points)
    return (f'<g><circle r="9" fill="#e8a020" opacity="0.9"/><circle r="4" fill="#ffffff"/>'
            f'<animateTransform attributeName="transform" type="translate" values="{values}" keyTimes="{keytimes(loop, *times)}" dur="{loop}s" repeatCount="indefinite"/></g>')


def frame(title):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">
  <title id="title">{title}</title>'''


def paper(x, y, w, h, lines, seed=0):
    """A paper page: title bars and body lines of varied length."""
    out = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="#ffffff" filter="url(#shadow)"/>',
           f'<rect x="{x + 50}" y="{y + 54}" width="{w * 0.55:.0f}" height="14" rx="4" fill="#8d8a82"/>',
           f'<rect x="{x + 50}" y="{y + 80}" width="{w * 0.4:.0f}" height="9" rx="4" fill="#8d8a82"/>']
    for i in range(lines):
        length = [1, 1, 0.86, 1, 0.94, 1, 0.7][(i + seed) % 7]
        out.append(f'<rect x="{x + 50}" y="{y + 130 + i * 24}" width="{(w - 100) * length:.0f}" height="9" rx="4.5" fill="#cfccc4"/>')
    return '\n'.join(out)


def head(w=W, h=H):
    """Defs, background and the amber wave, drawn for 1600 x 1000 and scaled to the canvas."""
    return f'''
  <defs>
MARK
    <filter id="shadow" x="-10%" y="-10%" width="125%" height="125%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#000000" flood-opacity="0.10"/>
    </filter>
  </defs>
  <rect width="{w}" height="{h}" fill="#f6f4ef"/>
  <g fill="none" stroke="#e8a020" stroke-width="3" opacity="0.2" transform="scale({w / 1600:.4f} {h / 1000:.4f})">
    <path d="M-60 880 C220 1100 560 1000 820 940 S1300 900 1660 1010"/>
  </g>'''


def annotate():
    """One line highlighted, one note typed under it, one stroke drawn: nothing else."""
    loop, W, H = 9, 1400, 620
    body = []
    # The selection sweeps one line, then it is yellow.
    body.append('<rect x="150" y="279" width="0" height="24" rx="4" fill="#9bcdff" opacity="0.6">'
                + anim('width', '0;0;420;420;0;0', loop, 0, 0.5, 1.6, 2.0, 2.01, loop) + '</rect>')
    body.append('<rect x="150" y="279" width="420" height="24" rx="4" fill="#ffe28f" opacity="0">'
                + anim('opacity', '0;0;0.85;0.85;0', loop, 0, 2.0, 2.15, loop - 0.3, loop) + '</rect>')
    body.append(pointer([(150, 291), (150, 291), (570, 291), (570, 291)], loop, [0, 0.5, 1.6, 2.2]))
    # The highlight lands in the notes as a block; a comment is typed under it.
    body.append('<g>'
                '<path d="M572 291 C660 291 660 250 740 250" fill="none" stroke="#e8a020" stroke-width="2.5" stroke-dasharray="2 9" stroke-linecap="round"/>'
                '<circle cx="770" cy="250" r="5" fill="#e8a020"/>'
                '<rect x="790" y="218" width="470" height="64" rx="10" fill="#f2f0ea"/><rect x="790" y="218" width="6" height="64" rx="3" fill="#ffe28f"/>'
                '<text x="812" y="246" font-family="Georgia, serif" font-size="20" font-style="italic" fill="#6b6a65">“decoherence is dominated by</text>'
                '<text x="812" y="272" font-family="Georgia, serif" font-size="20" font-style="italic" fill="#6b6a65">intermediate-state scattering”</text>'
                + show(loop, 2.2, loop) + '</g>')
    body.append('<g><circle cx="800" cy="316" r="5" fill="#8d8a82"/>' + typed('Key claim.', 822, 323, loop, 2.8, 4.2, 22) + show(loop, 2.6, loop) + '</g>')
    # A circle drawn around the figure becomes an ink block.
    body.append('<path d="M232 404 C300 372 470 368 500 412 C528 458 320 488 232 462 C196 450 200 420 232 404" fill="none" stroke="#e8a020" stroke-width="4" stroke-linecap="round" stroke-dasharray="900" stroke-dashoffset="900">'
                + anim('stroke-dashoffset', '900;900;0;0;900', loop, 0, 5.2, 6.8, loop - 0.3, loop)
                + anim('opacity', '0;0;1;1;0', loop, 0, 5.1, 5.2, loop - 0.3, loop) + '</path>')
    body.append('<g><circle cx="800" cy="386" r="5" fill="#8d8a82"/>'
                '<rect x="822" y="364" width="180" height="46" rx="10" fill="#f2f0ea"/>'
                '<path d="M842 394 C854 372 874 372 884 384 C892 394 872 402 862 396" fill="none" stroke="#e8a020" stroke-width="3" stroke-linecap="round"/>'
                f'<text x="902" y="393" font-family="{FONT}" font-size="19" fill="#6b6a65">ink · p. 3</text>'
                + show(loop, 7.0, loop) + '</g>')
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">
  <title id="title">Highlight a line, note it, draw on the page</title>
  <desc id="desc">One line of a paper is selected and turns yellow; it appears as a block in the notes and a comment is typed under it. Then a circle is drawn around the figure and becomes an ink block.</desc>{head(W, H)}
  <g font-family="{FONT}">
    {paper(100, 100, 500, 440, 5)}
    <rect x="200" y="360" width="360" height="130" rx="8" fill="none" stroke="#d6d3cb" stroke-width="2"/>
    <path d="M230 470 C300 400 380 392 520 398" stroke="#b9b6ae" stroke-width="3" fill="none"/>
    <rect x="740" y="100" width="560" height="440" rx="14" fill="#ffffff" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
    <text x="776" y="156" font-size="24" font-weight="600" fill="#1a1a18">Notes</text>
    <path d="M776 180 H1264" stroke="#e3e0d8" stroke-width="1.5"/>
    {''.join(body)}
  </g>
</svg>
'''
    return 'gamma-demo-annotate', svg


def notes():
    loop = 12
    body = []
    # Raw math typed, then rendered in place once the caret leaves it.
    text = typed('$$ N(t) = N_0 e^{-\\Gamma t} $$', 160, 330, loop, 0.6, 3.6, 26, family=MONO)
    body.append('<g>' + text + anim('opacity', '1;1;0;0;1', loop, 0, 3.9, 4.1, loop - 0.3, loop) + '</g>')
    body.append('<g>'
                '<rect x="150" y="290" width="330" height="70" rx="10" fill="#f2f0ea"/>'
                f'<text x="180" y="337" font-family="{MATH}" font-size="38" font-style="italic" fill="#1a1a18">N(t) = N<tspan font-size="24" dy="8">0</tspan><tspan dy="-8" dx="6">e</tspan><tspan font-size="24" dy="-18" dx="2">−<tspan fill="#e8a020" font-weight="600">Γ</tspan>t</tspan></text>'
                + show(loop, 4.0, loop) + '</g>')
    # The live preview that floats above raw math while the caret is inside.
    body.append('<g>'
                '<rect x="160" y="248" width="260" height="52" rx="10" fill="#ffffff" stroke="#e3e0d8" filter="url(#shadow)"/>'
                f'<text x="184" y="284" font-family="{MATH}" font-size="28" font-style="italic" fill="#1a1a18">N(t) = N<tspan font-size="18" dy="6">0</tspan><tspan dy="-6" dx="4">e</tspan><tspan font-size="18" dy="-14" dx="2">−Γt</tspan></text>'
                + show(loop, 1.6, 3.8) + '</g>')
    # A callout typed as markdown, rendered as a box.
    text = typed('> [!note] Ask Maya about the detuning sweep', 160, 428, loop, 4.6, 7.6, 22, family=MONO)
    body.append('<g>' + text + anim('opacity', '1;1;0;0;1', loop, 0, 7.9, 8.1, loop - 0.3, loop) + '</g>')
    body.append('<g>'
                '<rect x="150" y="396" width="620" height="76" rx="10" fill="#e6efff"/><rect x="150" y="396" width="6" height="76" rx="3" fill="#3a7bd5"/>'
                '<path d="M176 414 a9 9 0 1 0 0.01 0 M176 419 v6 M176 411 v1" fill="none" stroke="#3a7bd5" stroke-width="2" stroke-linecap="round"/>'
                f'<text x="196" y="421" font-family="{FONT}" font-size="18" font-weight="600" fill="#3a7bd5">NOTE</text>'
                f'<text x="176" y="452" font-family="{FONT}" font-size="22" fill="#1a1a18">Ask Maya about the detuning sweep</text>'
                + show(loop, 8.0, loop) + '</g>')
    # A picture pasted, then resized by its grip.
    body.append('<g>'
                '<rect x="150" y="510" width="300" height="190" rx="10" fill="#f2f0ea" stroke="#e3e0d8">'
                + anim('width', '300;300;300;440;440;300', loop, 0, 8.6, 9.6, 10.6, loop - 0.3, loop) + '</rect>'
                '<path d="M180 660 L180 550 M180 660 L420 660" stroke="#b9b6ae" stroke-width="2" fill="none">'
                + anim('d', 'M180 660 L180 550 M180 660 L420 660;M180 660 L180 550 M180 660 L420 660;M180 660 L180 550 M180 660 L420 660;M180 660 L180 550 M180 660 L560 660;M180 660 L180 550 M180 660 L560 660;M180 660 L180 550 M180 660 L420 660', loop, 0, 8.6, 9.6, 10.6, loop - 0.3, loop) + '</path>'
                '<path d="M184 640 C240 580 300 570 410 578" stroke="#e8a020" stroke-width="3.5" fill="none" stroke-linecap="round">'
                + anim('d', 'M184 640 C240 580 300 570 410 578;M184 640 C240 580 300 570 410 578;M184 640 C240 580 300 570 410 578;M184 640 C280 580 380 570 550 578;M184 640 C280 580 380 570 550 578;M184 640 C240 580 300 570 410 578', loop, 0, 8.6, 9.6, 10.6, loop - 0.3, loop) + '</path>'
                '<rect x="444" y="580" width="8" height="50" rx="4" fill="#e8a020">'
                + anim('x', '444;444;444;584;584;444', loop, 0, 8.6, 9.6, 10.6, loop - 0.3, loop) + '</rect>'
                f'<text x="150" y="730" font-family="{FONT}" font-size="18" fill="#6b6a65">![figure|300](…)' + anim('opacity', '1;1;0;0;1', loop, 0, 10.5, 10.6, loop - 0.3, loop) + '</text>'
                f'<text x="150" y="730" font-family="{FONT}" font-size="18" fill="#6b6a65">![figure|440](…)' + anim('opacity', '0;0;1;1;0', loop, 0, 10.5, 10.6, loop - 0.3, loop) + '</text>'
                + show(loop, 8.6, loop) + '</g>')
    body.append(pointer([(700, 340), (700, 340), (450, 605), (590, 605), (590, 605), (700, 340)], loop, [0, 9.4, 9.6, 10.6, 11.2, loop]))
    svg = frame('Type markdown and math; it renders in place') + f'''
  <desc id="desc">In a notes page a display equation is typed as LaTeX with a live preview floating above it and renders in place when the caret leaves; a callout is typed as markdown and becomes a boxed note; a pasted figure is widened by dragging its edge grip, which writes the width into the image link.</desc>{head()}
  <g font-family="{FONT}">
    <text x="100" y="80" font-size="34" font-weight="600" fill="#1a1a18">Notes that render as you type</text>
    <text x="100" y="116" font-size="20" fill="#6b6a65">Markdown, LaTeX, callouts and pictures — the block you are on stays raw, the rest renders.</text>
    <rect x="100" y="160" width="1400" height="780" rx="14" fill="#ffffff" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
    <text x="140" y="216" font-size="26" font-weight="600" fill="#1a1a18">Lab notes</text>
    <path d="M140 244 H1460" stroke="#e3e0d8" stroke-width="1.5"/>
    <circle cx="130" cy="326" r="5" fill="#8d8a82"/>
    <circle cx="130" cy="434" r="5" fill="#8d8a82"/>
    <circle cx="130" cy="600" r="5" fill="#8d8a82"/>
    {''.join(body)}
    <g font-size="18" fill="#6b6a65">
      <text x="860" y="330">Bracket pairs coloured, \\command autocomplete,</text>
      <text x="860" y="358">Tab hops between {{ }} arguments.</text>
      <text x="860" y="430">Obsidian-style callouts, tables edited in place,</text>
      <text x="860" y="458">[[page]] mentions and ![[block]] embeds.</text>
      <text x="860" y="600">Paste a screenshot; drag the grip to size it.</text>
    </g>
  </g>
</svg>
'''
    return 'gamma-demo-notes', svg


def search():
    loop = 10
    body = []
    body.append(typed('3000 qubit', 180, 236, loop, 0.6, 2.2, 26))
    # The folder chip narrows the results.
    body.append('<g>'
                '<rect x="330" y="212" width="86" height="34" rx="17" fill="#ecdfc4"/>'
                f'<text x="373" y="236" text-anchor="middle" font-family="{FONT}" font-size="19" font-weight="500" fill="#5a4a24">qc/</text>'
                + show(loop, 4.6, loop) + '</g>')
    groups = [
        ('TITLES', 280, [('A quantum processor based on coherent transport…', '3,000-qubit', 'qc/neutral-atom')]),
        ('THIS PAPER · NOTES', 372, [('“…the 3,000-qubit array holds its coherence…”', '3,000-qubit', 'highlight')]),
        ('LIBRARY · PDF TEXT', 464, [('Continuous operation of a coherent 3,000-qubit system', 'p. 2', 'qc/neutral-atom'),
                                     ('…scaling toward 3000 qubits requires…', 'p. 7', 'qec'),
                                     ('…arrays of 3,000 atoms in tweezers…', 'p. 1', 'qc/neutral-atom')]),
    ]
    for label, top, rows in groups:
        body.append(f'<g><text x="140" y="{top}" font-family="{FONT}" font-size="15" font-weight="600" letter-spacing="1.8" fill="#6b6a65">{label}</text>' + show(loop, 2.4, loop) + '</g>')
        for i, (line, badge, folder) in enumerate(rows):
            ry = top + 16 + i * 60
            hidden = folder == 'qec'
            fade = anim('opacity', '0;0;1;1;0.25;0.25', loop, 0, 2.5 + i * 0.15, 2.7 + i * 0.15, 4.6, 4.8, loop) if hidden else show(loop, 2.5 + i * 0.15, loop)
            body.append(f'<g><rect x="140" y="{ry}" width="640" height="50" rx="10" fill="#f6f4ef"/>'
                        f'<text x="158" y="{ry + 31}" font-family="{FONT}" font-size="18" fill="#1a1a18">{line}</text>'
                        f'<rect x="{774 - 16 - len(badge) * 9 - 12}" y="{ry + 12}" width="{len(badge) * 9 + 12}" height="26" rx="13" fill="#ffe28f" opacity="0.8"/>'
                        f'<text x="{774 - 16 - (len(badge) * 9 + 12) / 2}" y="{ry + 30}" text-anchor="middle" font-family="{FONT}" font-size="15" fill="#5a4a24">{badge}</text>'
                        + fade + '</g>')
    # The chosen hit glows and the paper opens on the right with the match found again.
    body.append('<g><rect x="140" y="480" width="640" height="50" rx="10" fill="none" stroke="#e8a020" stroke-width="2.5"/>' + show(loop, 6.2, loop) + '</g>')
    body.append('<g>' + paper(860, 160, 640, 780, 26, 3)
                + '<rect x="905" y="384" width="320" height="23" rx="4" fill="#ffe28f" opacity="0.85"/>'
                + f'<text x="1500" y="985" text-anchor="end" font-family="{FONT}" font-size="18" fill="#6b6a65">Opened at the match, re-found in the PDF text layer.</text>'
                + show(loop, 6.8, loop) + '</g>')
    body.append(pointer([(700, 236), (700, 236), (460, 505), (460, 505), (1120, 420), (1120, 420), (700, 236)], loop, [0, 5.4, 6.2, 6.8, 7.4, 9.4, loop]))
    svg = frame('Search notes, highlights and every PDF at once') + f'''
  <desc id="desc">Ctrl+F opens the search; “3000 qubit” is typed and results appear grouped as titles, this paper's notes and the full text of every PDF, each match badged; a folder chip “qc/” narrows them; one hit is picked and the paper opens with the match highlighted.</desc>{head()}
  <g font-family="{FONT}">
    <text x="100" y="80" font-size="34" font-weight="600" fill="#1a1a18">Search everything</text>
    <text x="100" y="116" font-size="20" fill="#6b6a65">Titles, notes, highlights and the text of every PDF — “3000” finds “3,000-qubit” across a line break.</text>
    <rect x="100" y="160" width="700" height="780" rx="14" fill="#ffffff" stroke="#e3e0d8" stroke-width="1.5" filter="url(#shadow)"/>
    <rect x="130" y="200" width="640" height="58" rx="14" fill="#f2f0ea" stroke="#e3e0d8"/>
    <g fill="none" stroke="#6b6a65" stroke-width="2.3" stroke-linecap="round"><circle cx="156" cy="226" r="9"/><path d="M163 233 172 242"/></g>
    <text x="740" y="236" text-anchor="end" font-size="15" fill="#6b6a65">Aa · ab · .*</text>
    {''.join(body)}
  </g>
</svg>
'''
    return 'gamma-demo-search', svg


for build in (annotate, notes, search):
    stem, svg = build()
    write_svg(f'{stem}-light', svg.replace('MARK', MARK, 1))
