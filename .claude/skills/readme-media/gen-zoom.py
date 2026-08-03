import json, os, subprocess, sys

SCRATCH = os.path.dirname(os.path.abspath(__file__))
Z = json.load(open(os.path.join(SCRATCH, "links_zoom.json")))
webm = open(os.path.join(SCRATCH, "video_links_path.txt")).read().strip()
OUT = r"D:/Codes/Github/gamma/docs/demo-reference-links.gif"
# the venv's imageio-ffmpeg static binary (full ffmpeg with the gif encoder)
import glob
FF = glob.glob(r"D:\Codes\Github\gamma\backend\venv\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win*.exe")[0]

vidW, vidH = Z["vidW"], Z["vidH"]
sx = vidW / Z["cssW"]                       # CSS->video scale (=2)
R1 = (Z["R1"]["x"] * sx, Z["R1"]["y"] * sx)
R2 = (Z["R2"]["x"] * sx, Z["R2"]["y"] * sx)

# camera window centred on the midpoint of the two ROIs, big enough to hold both
Cx = (R1[0] + R2[0]) / 2
Cy = (R1[1] + R2[1]) / 2
MX, MY = 300 * sx, 150 * sx                 # margin around the ROIs (video px)
half_x = abs(R1[0] - R2[0]) / 2 + MX
half_y = abs(R1[1] - R2[1]) / 2 + MY
zfit = min((vidW / 2) / half_x, (vidH / 2) / half_y)
ZOOM = max(1.4, min(1.9, zfit))

trimStart = max(0.0, Z["m0"] - 0.5)
A0, RIN, ROUT = 0.5, 0.9, 1.0               # brief hold, zoom-in dur, zoom-out dur
A1 = A0 + RIN
HOLD_END = Z["mFetch"] - trimStart
OUT_END = HOLD_END + ROUT
dur = (Z["tEnd"] - trimStart) + 0.3
FR = 25
SPEED = 1.7

# z(t) trapezoid, t = on/FR (seconds from trimStart)
z = (f"if(lt(on/{FR},{A0}),1,"
     f"if(lt(on/{FR},{A1}),1+({ZOOM}-1)*(on/{FR}-{A0})/{RIN},"
     f"if(lt(on/{FR},{HOLD_END}),{ZOOM},"
     f"if(lt(on/{FR},{OUT_END}),{ZOOM}+(1-{ZOOM})*(on/{FR}-{HOLD_END})/{ROUT},1))))")
# constant centre; x/y derived from current zoom, clamped to frame
xexpr = f"clip({Cx:.1f}-(iw/zoom)/2,0,iw-iw/zoom)"
yexpr = f"clip({Cy:.1f}-(ih/zoom)/2,0,ih-ih/zoom)"

vf = (
    f"trim=start={trimStart:.3f}:end={Z['tEnd']+0.3:.3f},setpts=PTS-STARTPTS,fps={FR},"
    f"zoompan=z='{z}':x='{xexpr}':y='{yexpr}':d=1:s={vidW}x{vidH}:fps={FR},"
    f"setpts=PTS/{SPEED},fps=10,scale=880:-1:flags=lanczos,"
    f"split[s0][s1];[s0]palettegen=max_colors=100[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3"
)
print(f"ZOOM={ZOOM:.2f} Cx={Cx:.0f} Cy={Cy:.0f} trimStart={trimStart:.2f} HOLD_END={HOLD_END:.2f} dur={dur:.2f}")
cmd = [FF, "-y", "-i", webm, "-vf", vf, "-loop", "0", OUT]
r = subprocess.run(cmd, capture_output=True, text=True)
sys.stderr.write(r.stderr[-800:])
print("\nexit", r.returncode)
print("size MB:", round(os.path.getsize(OUT) / 1024 / 1024, 2) if os.path.exists(OUT) else "MISSING")
