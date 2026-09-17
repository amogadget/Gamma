"""Render the annotation/ink and native-agentic README stories from real captures."""
import argparse
import json
from pathlib import Path
import subprocess

from imageio_ffmpeg import get_ffmpeg_exe
from media_output import encode_webp, publish

ROOT = Path(__file__).resolve().parents[2]
SCRATCH = ROOT / 'artifacts/readme-media'
OUT = ROOT / 'docs/assets/demos'


def render(name):
    framing = {}
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
        framing = timeline.get('framing', {})
        verified = timeline.get('verified', {})
        if not all(verified.get(key) for key in ('citationMarks', 'singleConversation', 'pdfChat', 'boxAttachment', 'savedFigure')):
            raise ValueError('Capture both PDF questions, an exact citation and a persisted figure attachment first')
        if verified.get('expandedSteps') != 0 or verified.get('citationNotice'):
            raise ValueError('Keep tool steps collapsed and show an exact PDF citation match')
        # Keep interactions at real speed; cut only the waits between AI actions.
        segments = [
            (m['start'], m['questionZoom'], 'full'),
            (m['questionZoom'], m['pdfSent'] + .6, 'zoom-bottom'),
        ]
        actions = [a for a in timeline['actions'] if a['phase'] == 'pdf']
        answer_start = max(m['pdfSent'] + .6, m['pdfAnswer'] - 3)
        # Briefly show real search/read progress without replaying overlapping time.
        windows = []
        for action in actions:
            start = max(m['pdfSent'] + .6, action['at'] - .25)
            end = min(answer_start, action['at'] + 1.25)
            if end <= start:
                continue
            if windows and start <= windows[-1][1]:
                windows[-1] = (windows[-1][0], max(windows[-1][1], end))
            else:
                windows.append((start, end))
        segments.extend((start, end, 'detail-top') for start, end in windows)
        segments.extend([
            (answer_start, m['citationClick'] + .45, 'detail-response'),
            (m['citationReady'] - .4, m['citationReady'] + 1.5, 'full'),
            (m['citationReady'] + 1.5, m['passageEnd'], 'zoom-passage'),
            (m['figureStart'], m['figureQuestionZoom'], 'full'),
            (m['figureQuestionZoom'], m['figureSent'] + .6, 'zoom-bottom'),
            (max(m['figureSent'] + .6, m['figureAnswer'] - 2), m['figureAnswer'] + 1, 'detail-figure-answer'),
            (m['figureAnswer'] + 1, m['end'], 'full'),
        ])
    if any(end <= start for start, end, _ in segments):
        raise ValueError('Capture timing changed; review the edit points')
    source = Path(timeline['video'])
    parts = []
    for i, (start, end, camera) in enumerate(segments):
        filters = f'trim=start={start:.3f}:end={end:.3f},setpts=PTS-STARTPTS,fps=25'
        if camera != 'full':
            # Fixed detail cuts keep dense PDF text readable and compact.
            zoom = '2'
            anchor = '1' if camera.endswith('bottom') else '0.10'
            x, y = 'iw-iw/zoom', f'(ih-ih/zoom)*{anchor}'
            if camera == 'detail-response':
                y = str(max(0, min(450, framing['citation']['y'] - 300)))
            elif camera == 'detail-figure-answer':
                y = str(max(0, min(450, framing['figureAnswer']['y'] - 30)))
            elif camera == 'zoom-passage':
                box = framing['passage']
                # Frame the highlighted passage inside the PDF pane.
                # The recorder places the PDF/chat divider at x=790. Keep the
                # source passage in that pane, including wrapped quote lines.
                x = f'max(0,min(790-iw/zoom,{box["x"] + box["width"]/2}-iw/zoom/2))'
                y = f'max(0,min(ih-ih/zoom,{box["y"] + box["height"]/2}-ih/zoom/2))'
            filters += f",zoompan=z='{zoom}':x='{x}':y='{y}':d=1:s=1440x900:fps=25"
        parts.append(f'[0:v]{filters},setsar=1[s{i}]')
    graph = ';'.join(parts) + ';' + ''.join(f'[s{i}]' for i in range(len(parts)))
    graph += f'concat=n={len(parts)}:v=1:a=0,pad=1488:948:24:24:color=0xe8edf5[v]'
    master = directory / f'{name}-master.mkv'
    subprocess.run([get_ffmpeg_exe(), '-v', 'error', '-y', '-i', str(source),
                    '-filter_complex', graph, '-map', '[v]', '-an', '-c:v', 'ffv1', '-level', '3', str(master)], check=True)
    output = directory / f'{name}.webp'
    width, quality, effort = (960, 65, 6) if name == 'native-agentic' else (1040, 75, 4)
    report = {'name': name, 'fps': 25, 'width': width, 'quality': quality, 'effort': effort, 'source': str(source), 'segments': segments,
              **encode_webp(master, output, f'fps=25,scale={width}:-2:flags=lanczos', quality=quality, effort=effort)}
    (directory / f'{name}-render.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    publish(output, OUT / f'demo-{name}.webp')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cases', nargs='+', choices=['annotate-and-ink', 'native-agentic', 'all'])
    args = parser.parse_args()
    for name in ['annotate-and-ink', 'native-agentic'] if 'all' in args.cases else args.cases:
        render(name)
