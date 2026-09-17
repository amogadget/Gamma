"""Render the short ink recording as a looping animated WebP."""
import argparse
import json
from pathlib import Path

from media_output import encode_webp, publish

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--scratch', type=Path, default=ROOT / 'artifacts/readme-media')
parser.add_argument('--out', type=Path, default=ROOT / 'docs/assets/demos')
args = parser.parse_args()
timeline = json.loads((args.scratch / 'ink-timeline.json').read_text(encoding='utf-8'))
m = timeline['marks']
filters = (f'trim=start={m["start"]:.3f}:end={m["end"]:.3f},setpts=PTS-STARTPTS,'
           'fps=25,pad=1488:948:24:24:color=0xe8edf5,scale=1120:-2:flags=lanczos')
output = args.scratch / 'rendered-ink.webp'
report = {'name': 'ink', 'fps': 25, 'width': 1120, **encode_webp(timeline['video'], output, filters)}
(args.scratch / 'ink-render.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
publish(output, args.out / 'demo-ink.webp')
print(json.dumps(report))
