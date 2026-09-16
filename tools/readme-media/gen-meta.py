from pathlib import Path
"""Post-process for record-metadata.mjs: trim the download pre-roll, cut the
dead waits (metadata fetch, citation regeneration), and apply a smooth camera
zoom onto the right column where the metadata + share popovers live. The app
itself is never zoomed. Reads meta_zoom.json + video_meta_path.txt from the
recorder's working directory; run this script from that directory."""
import json, os, subprocess, sys

SCRATCH = os.getcwd()
Z = json.load(open(os.path.join(SCRATCH, "meta_zoom.json")))
webm = open(os.path.join(SCRATCH, "video_meta_path.txt")).read().strip()
OUT = sys.argv[1] if len(sys.argv) > 1 else str(Path(SCRATCH) / "legacy-metadata.gif")
from imageio_ffmpeg import get_ffmpeg_exe
FF = get_ffmpeg_exe()

vidW, vidH = Z["vidW"], Z["vidH"]
sx = vidW / Z["cssW"]                       # CSS -> video px (1:1 here)
FR = 25
SPEED = float(os.environ.get("SPEED", "1.25"))
GIF_W = int(os.environ.get("GIF_W", "960"))
COLORS = int(os.environ.get("COLORS", "128"))
GIF_FPS = int(os.environ.get("GIF_FPS", "12"))

# --- 1. source-time segments to keep ---------------------------------------
trimStart = Z["m0"]                       # the recorder stamps m0 once the page has painted
tEnd = Z["tEnd"] + 0.2
cuts = []                                    # (from, to) in source time, dropped
# the fetch filling the popover IS the feature: keep up to ~4 s of it on
# camera; only a slow network's longer wait gets its middle cut
if Z["mFilled"] - Z["mMeta"] > 4.0:
    cuts.append((Z["mMeta"] + 2.0, Z["mFilled"] - 1.5))
segs, t = [], trimStart
for a, b in cuts:
    segs.append((t, a)); t = b
segs.append((t, tEnd))

def out_t(src):
    """map a source-time mark to the concatenated (cut) timeline"""
    o = 0.0
    for a, b in segs:
        if src <= a: return o
        if src <= b: return o + (src - a)
        o += b - a
    return o
total = out_t(tEnd)

# --- 2. camera window: the right column, both popovers + their buttons ------
boxes = [Z["metaPop"], Z["sharePop"], Z["infoBtn"]]
x0 = min(b["x"] for b in boxes) * sx; x1 = max(b["x"] + b["width"] for b in boxes) * sx
y0 = min(b["y"] for b in boxes) * sx; y1 = max(b["y"] + b["height"] for b in boxes) * sx
y0 = min(y0, 8 * sx)                          # include the top bar (Share button)
Cx, Cy = (x0 + x1) / 2, (y0 + y1) / 2
MX, MY = 90 * sx, 30 * sx
zfit = min(vidW / (x1 - x0 + 2 * MX), vidH / (y1 - y0 + 2 * MY))
ZOOM = max(1.35, min(1.75, zfit))

A0 = max(0.0, out_t(Z["mMeta"]) - 0.6); RIN = 0.9; A1 = A0 + RIN
HOLD_END = out_t(Z["mOut"]); ROUT = 0.9; OUT_END = HOLD_END + ROUT
z = (f"if(lt(on/{FR},{A0:.3f}),1,"
     f"if(lt(on/{FR},{A1:.3f}),1+({ZOOM}-1)*(on/{FR}-{A0:.3f})/{RIN},"
     f"if(lt(on/{FR},{HOLD_END:.3f}),{ZOOM},"
     f"if(lt(on/{FR},{OUT_END:.3f}),{ZOOM}+(1-{ZOOM})*(on/{FR}-{HOLD_END:.3f})/{ROUT},1))))")
xexpr = f"clip({Cx:.1f}-(iw/zoom)/2,0,iw-iw/zoom)"
yexpr = f"clip({Cy:.1f}-(ih/zoom)/2,0,ih-ih/zoom)"

# --- 3. filter graph: trim+concat → zoompan → speed-up → palette GIF ----------
parts, labels = [], []
for i, (a, b) in enumerate(segs):
    parts.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[s{i}]")
    labels.append(f"[s{i}]")
graph = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(segs)}:v=1:a=0,fps={FR},"
graph += (f"zoompan=z='{z}':x='{xexpr}':y='{yexpr}':d=1:s={vidW}x{vidH}:fps={FR},"
          f"setpts=PTS/{SPEED},fps={GIF_FPS},scale={GIF_W}:-1:flags=lanczos,"
          f"split[a][b];[a]palettegen=max_colors={COLORS}[p];[b][p]paletteuse=dither=bayer:bayer_scale=3[out]")
print(f"segs={[(round(a,2), round(b,2)) for a, b in segs]} total={total:.2f}s -> {total/SPEED:.2f}s at {SPEED}x")
print(f"ZOOM={ZOOM:.2f} centre=({Cx:.0f},{Cy:.0f}) zoom-in@{A0:.2f} hold-until@{HOLD_END:.2f}")
cmd = [FF, "-y", "-i", webm, "-filter_complex", graph, "-map", "[out]", "-loop", "0", OUT]
r = subprocess.run(cmd, capture_output=True, text=True)
sys.stderr.write(r.stderr[-600:])
print("\nexit", r.returncode)
print("size MB:", round(os.path.getsize(OUT) / 1024 / 1024, 2) if os.path.exists(OUT) else "MISSING")
