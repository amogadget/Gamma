"""Combine paper annotation/Q&A and library-agent actions into one README demo.

Uses the original WebM recordings, not the previously compressed WebP exports.
Review the edit points against new captures when re-recording either source.
"""
import json
from pathlib import Path
import subprocess

from imageio_ffmpeg import get_ffmpeg_exe
from media_output import encode_webp, publish

ROOT = Path(__file__).resolve().parents[2]
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
parts = [f'[{source}:v]trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS[s{i}]'
         for i, (source, start, end) in enumerate(segments)]
graph = ';'.join(parts) + ';' + ''.join(f'[s{i}]' for i in range(len(parts)))
graph += f'concat=n={len(parts)}:v=1:a=0,fps=25,pad=1488:948:24:24:color=0xe8edf5,setsar=1[v]'
master = directory / 'master.mkv'
subprocess.run([get_ffmpeg_exe(), '-v', 'error', '-y', '-i', str(sources[0]), '-i', str(sources[1]),
                '-filter_complex', graph, '-map', '[v]', '-an', '-c:v', 'ffv1', '-level', '3', str(master)], check=True)
output = directory / 'rendered.webp'
report = {'name': 'annotate-and-ask', 'fps': 25, 'width': 1040, 'quality': 75, 'effort': 4,
          **encode_webp(master, output, 'fps=25,scale=1040:-2:flags=lanczos', quality=75, effort=4),
          'sources': list(map(str, sources)), 'segments': segments}
(directory / 'render.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
publish(output, OUT)
print(json.dumps(report))
