"""Small animated WebP delivery, shared by the README renderers."""
import os
from pathlib import Path
import subprocess
import time

from imageio_ffmpeg import get_ffmpeg_exe


def encode_webp(source, target, filters='fps=25,scale=1120:-2:flags=lanczos', quality=85, effort=6):
    target = Path(target)
    subprocess.run([get_ffmpeg_exe(), '-v', 'error', '-y', '-i', str(source),
                    '-vf', filters, '-an', '-c:v', 'libwebp_anim', '-lossless', '0',
                    '-quality', str(quality), '-compression_level', str(effort), '-loop', '0', str(target)], check=True)
    data = target.read_bytes()
    if data[:4] != b'RIFF' or data[8:12] != b'WEBP' or int.from_bytes(data[4:8], 'little') + 8 != len(data):
        raise ValueError('Invalid WebP container')
    offset, frames, milliseconds, loops = 12, 0, 0, None
    while offset < len(data):
        kind, size = data[offset:offset+4], int.from_bytes(data[offset+4:offset+8], 'little')
        chunk = data[offset+8:offset+8+size]
        if len(chunk) != size:
            raise ValueError('Truncated WebP chunk')
        if kind == b'ANIM':
            loops = int.from_bytes(chunk[4:6], 'little')
        if kind == b'ANMF':
            frames += 1
            milliseconds += int.from_bytes(chunk[12:15], 'little')
        offset += 8 + size + size % 2
    if frames < 2 or loops != 0 or milliseconds <= 0:
        raise ValueError('Expected a looping animated WebP')
    if len(data) > 5 * 1024**2:
        raise ValueError('WebP exceeds 5 MiB; shorten the edit or tighten its crop')
    return {'frames': frames, 'seconds': round(milliseconds/1000, 2), 'webp_mib': round(len(data)/1024**2, 2)}


def publish(source, target):
    Path(target).parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(8):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(0.25)
