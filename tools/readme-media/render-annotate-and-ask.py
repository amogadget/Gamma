"""Combine paper annotation/Q&A and library-agent actions into one README demo.

Uses the original WebM recordings, not the previously compressed WebP exports.
Review the edit points against new captures when re-recording either source.
"""
import json
from pathlib import Path

from media_output import ROOT, FRAME, concat_segments, encode_webp, publish

SUITE = ROOT / 'artifacts/readme-media/suite'
OUT = SUITE / 'annotate-and-ask/preview.webp'
directory = SUITE / 'annotate-and-ask'
directory.mkdir(parents=True, exist_ok=True)
paper = SUITE / 'download-and-chat'
agent = SUITE / 'agent'
p = json.loads((paper / 'hero-marks.json').read_text())
a = json.loads((agent / 'agent_marks.json').read_text())
sources = [Path((paper / 'video_path.txt').read_text().strip()),
           Path((agent / 'video_agent.txt').read_text().strip())]

# Preserve drawing/typing cadence. Cut model waits, then show each real outcome.
# The cut to Home separates the paper question from the library-wide request.
segments = [
    (0, p['loaded'] + 1, p['asked'] + 0.6),
    (0, max(p['asked'] + 0.6, p['end'] - 5), p['end']),
    (1, a['m0'] - 0.2, a['m0'] + 3.6),
    (1, a['m0'] + 6.6, a['mEnd'] - 1),
]
if any(end <= start for _, start, end in segments):
    raise ValueError('Capture timing changed; review the combined storyboard')
parts = [f'[{source}:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS'
         for source, start, end in segments]
master = directory / 'master.mkv'
concat_segments(master, sources, parts, f'fps=25,{FRAME},setsar=1')
output = directory / 'rendered.webp'
report = {'name': 'annotate-and-ask', 'fps': 25, 'width': 1040, 'quality': 75, 'effort': 4,
          **encode_webp(master, output, 'fps=25,scale=1040:-2:flags=lanczos', quality=75, effort=4),
          'sources': list(map(str, sources)), 'segments': segments}
(directory / 'render.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
publish(output, OUT)
print(json.dumps(report))
