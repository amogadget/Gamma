"""Render the annotation/ink and native-agentic README stories from real captures."""
import argparse
import json
from pathlib import Path
import subprocess

from imageio_ffmpeg import get_ffmpeg_exe
from media_output import encode_webp, publish

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = ROOT / 'tmp/readme-media'
OUT = ROOT / 'docs/assets/demos'


def render(name):
    if name == 'annotate-and-ink':
        directory = SCRATCH / name
        timeline = json.loads((directory / 'ink-timeline.json').read_text(encoding='utf-8'))
        m = timeline['marks']
        if not timeline['verified'].get('annotation'):
            raise ValueError('Capture must include a persisted text annotation')
        segments = [(m['start'], m['end'], 'full')]
    else:
        directory = SCRATCH / 'revised'
        timeline = json.loads((directory / 'agentic-timeline.json').read_text(encoding='utf-8'))
        m = timeline['marks']
        # Keep interactions at real speed; cut only the waits between AI actions.
        segments = [
            (m['pdfStart'], m['pdfSent'] + 1, 'full'),
            (m['pdfAnswer'] - 2.8, m['pdfEnd'], 'zoom-top'),
            (m['libraryStart'], m['mention'], 'full'),
            (m['mention'], m['librarySent'] + .7, 'zoom-bottom'),
        ]
        actions = [a for a in timeline['actions'] if a['phase'] == 'library']
        for action in actions:
            segments.append((action['at'] - .3, action['at'] + 1.3, 'detail-top'))
        segments.extend([
            (m['libraryAnswer'] - 2, m['stepsStart'], 'detail-top'),
            (m['stepsStart'], m['readDetail'] + .2, 'detail-top'),
            (m['readDetail'] + .2, m['end'], 'full'),
        ])
    if any(end <= start for start, end, _ in segments):
        raise ValueError('Capture timing changed; review the edit points')
    source = Path(timeline['video'])
    parts = []
    for i, (start, end, camera) in enumerate(segments):
        filters = f'trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS,fps=25'
        if camera != 'full':
            zoom = '2' if camera.startswith('detail') else '1+min(on/20,1)*min(on/20,1)*(3-2*min(on/20,1))'
            anchor = '1' if camera.endswith('bottom') else '0.10'
            filters += f",zoompan=z='{zoom}':x='iw-iw/zoom':y='(ih-ih/zoom)*{anchor}':d=1:s=1440x900:fps=25"
        parts.append(f'[0:v]{filters},setsar=1[s{i}]')
    graph = ';'.join(parts) + ';' + ''.join(f'[s{i}]' for i in range(len(parts)))
    graph += f'concat=n={len(parts)}:v=1:a=0,pad=1488:948:24:24:color=0xe8edf5[v]'
    master = directory / f'{name}-master.mkv'
    subprocess.run([get_ffmpeg_exe(), '-v', 'error', '-y', '-i', str(source),
                    '-filter_complex', graph, '-map', '[v]', '-an', '-c:v', 'ffv1', '-level', '3', str(master)], check=True)
    output = directory / f'{name}.webp'
    report = {'name': name, 'fps': 25, 'width': 1040, 'source': str(source), 'segments': segments,
              **encode_webp(master, output, 'fps=25,scale=1040:-2:flags=lanczos', quality=75, effort=4)}
    (directory / f'{name}-render.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    publish(output, OUT / f'demo-{name}.webp')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cases', nargs='+', choices=['annotate-and-ink', 'native-agentic', 'all'])
    args = parser.parse_args()
    for name in ['annotate-and-ink', 'native-agentic'] if 'all' in args.cases else args.cases:
        render(name)
