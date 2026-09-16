# Composites the three connector segments (arXiv page, popup overlay, Gamma)
# and applies a post-process camera zoom (zoompan), then converts to GIF.
import json, os, subprocess, sys

Z = json.load(open("conn_marks.json"))
from imageio_ffmpeg import get_ffmpeg_exe
FF = get_ffmpeg_exe()

def run(*args):
    r = subprocess.run([FF, "-loglevel", "error", "-y", *args], capture_output=True, text=True)
    if r.returncode:
        sys.stderr.write(r.stderr[-1200:])
        sys.exit(r.returncode)

# segment trims (input-local seconds)
a_start, a_end = Z["a0"] - 0.5, Z["a1"]
b_start, b_end = Z["b0"] - 0.6, Z["b2"] + 0.25
c_start, c_dur = 0.3, 5.9
dA, dB = a_end - a_start, b_end - b_start

ENC = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18"]
run("-ss", f"{a_end-0.05:.2f}", "-i", Z["videoA"], "-vframes", "1", "bgA.png")
run("-ss", f"{a_start:.2f}", "-t", f"{dA:.2f}", "-i", Z["videoA"],
    "-vf", "fps=25,scale=1440:900,setsar=1", *ENC, "segA.mp4")
run("-loop", "1", "-framerate", "25", "-t", f"{dB:.2f}", "-i", "bgA.png",
    "-ss", f"{b_start:.2f}", "-t", f"{dB:.2f}", "-i", Z["videoB"],
    "-filter_complex",
    "[1:v]fps=25,crop=360:364:0:0,pad=iw+4:ih+4:2:2:0x9aa2ac[p];"
    "[0:v]scale=1440:900,setsar=1[bg];[bg][p]overlay=1004:10",
    *ENC, "segB.mp4")
run("-ss", f"{c_start:.2f}", "-t", f"{c_dur:.2f}", "-i", Z["videoC"],
    "-vf", "fps=25,scale=1440:900,setsar=1", *ENC, "segC.mp4")

# concat timeline breakpoints (seconds)
tB0 = dA                 # popup appears
tC0 = dA + dB            # Gamma opens
# zoom ONLY onto the Connector popup: full view until it appears, ramp in,
# hold, ramp back out when Gamma opens. Constant centre; clip() does the rest.
ZOOM = 1.65
t1, t2 = tB0 + 0.15, tB0 + 1.05   # ramp in as the popup appears
t3, t4 = tC0 + 0.3, tC0 + 1.3     # ramp out in Gamma
Cx, Cy = 1188, 200                # popup centre (overlay at 1004..1372 x 10..378)
FR = 25
T = f"(on/{FR})"

def piece(pairs, last):
    # pairs: [(t_end, expr)] -> nested if(lt(t,t_end), expr, ...)
    out = last
    for t_end, expr in reversed(pairs):
        out = f"if(lt({T},{t_end}),{expr},{out})"
    return out

lerp = lambda a, b, t0, t1_: f"({a}+({b}-{a})*({T}-{t0})/{t1_-t0:.3f})"
z = piece([
    (t1, "1"),
    (t2, lerp("1", str(ZOOM), t1, t2)),
    (t3, str(ZOOM)),
    (t4, lerp(str(ZOOM), "1", t3, t4)),
], "1")

zoomvf = (
    f"zoompan=z='{z}':x='clip({Cx}-(iw/zoom)/2,0,iw-iw/zoom)'"
    f":y='clip({Cy}-(ih/zoom)/2,0,ih-ih/zoom)':d=1:s=1440x900:fps={FR}"
)
run("-i", "segA.mp4", "-i", "segB.mp4", "-i", "segC.mp4",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1," + zoomvf, *ENC, "zoomed.mp4")
run("-i", "zoomed.mp4",
    "-vf", "setpts=PTS/1.4,fps=11,scale=960:-1:flags=lanczos,"
    "split[s0][s1];[s0]palettegen=max_colors=144[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
    "-loop", "0", "demo-connector.gif")
print("timeline: popup", round(tB0, 2), "gamma", round(tC0, 2), "total", round(tC0 + c_dur, 2))
print("size MB:", round(os.path.getsize("demo-connector.gif") / 1e6, 2))
