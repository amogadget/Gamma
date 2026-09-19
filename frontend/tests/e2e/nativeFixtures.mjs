// Test support shared by the three standalone browser checks (nativeHandoff,
// noteReplay, blankPdf) and the real-backend native scenario: a CRC-valid PNG,
// real AAC audio, media responses a browser's demuxer accepts, and which engine
// to launch.
//
// Why the media helper matters: an <audio> element in Chromium issues a RANGE
// request for an MP4, and a mock that answers every request with a plain 200 and
// no Content-Length makes the load fail with MEDIA_ERR_SRC_NOT_SUPPORTED (code 4)
// even in a build that HAS the AAC decoder. That looked exactly like "this engine
// has no AAC", which is worth remembering before blaming a codec.

// A CRC-valid opaque blue (#185cdc) 1x1 PNG, stretched into visible strokes.
// Never use a transparent pixel: DOM-only checks can pass with invisible ink.
// The ink previews and per-stroke images are real PNGs, and
// both the server's upload check and the .inkjson validator read the IHDR (the
// backend also re-checks every chunk CRC).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQiLnzHwAEMAJQgj7oPgAAAABJRU5ErkJggg==",
  "base64",
);

// Inspect actual compositor pixels, not image hrefs/DOM counts. Decoding the
// screenshot in the browser avoids a second PNG dependency. The blue fixture is
// distinct from PDF text, white paper, and the neutral application chrome.
export async function renderedInkPixels(locator) {
  const png = await locator.screenshot({ animations: "disabled" });
  return locator.page().evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0, minX = canvas.width, maxX = -1;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 80 && data[i + 1] < 150 && data[i + 2] > 180 && data[i + 3] > 200) {
        count++;
        const x = (i / 4) % canvas.width;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      }
    }
    return { count, minX, maxX, width: canvas.width, height: canvas.height };
  }, png.toString("base64"));
}

// The audio fixture is GENERATED with ffmpeg when it is available, and verified
// with ffprobe, so what the player decodes is real AAC at the length the
// recording declares. The embedded six-second blob below is only the fallback for
// a machine without ffmpeg (a longer file than a segment declares is harmless:
// the timeline clamps to the declared duration and the segment advances when the
// FILE ends).
//
// Whether an ENGINE can decode it is a property of the engine: Playwright's
// stock Chromium cannot, Chrome for Testing can.
export const EMBEDDED_AAC_M4A = Buffer.from(
  "AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAAElm1kYXTeAgBMYXZjNjAuMzEuMTAyAAIwQA4BGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAfeAgBMYXZjNjAuMzEuMTAyAAIwQA4BGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAB2dtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAXcAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAGkXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAXcAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAF3AAAAQAAAEAAAAABgltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAARpAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAW0bWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAV4c3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAALuAAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAPoAAAAGDQWAgIAFEYhW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAABGgAABAAAAAABAAABAAAAABxzdHNjAAAAAAAAAAEAAAABAAABGwAAAAEAAASAc3RzegAAAAAAAAAAAAABGwAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAVAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAUc3RjbwAAAAAAAAABAAAALAAAABpzZ3BkAQAAAHJvbGwAAAACAAAAAf//AAAAHHNiZ3AAAAAAcm9sbAAAAAEAAAEbAAAAAQAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAw",
  "base64",
);

// A second finalized segment with different bytes (and so its own asset URL): an
// ignored ISO-BMFF `free` box appended to the AAC, which a demuxer skips.
export function secondSegment(bytes) {
  return Buffer.concat([bytes, Buffer.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65])]);
}

// "…m4a, `seconds` long, made for this run": ffmpeg-generated when possible,
// otherwise the embedded fallback with a note saying so. Cached per duration.
const audioCache = new Map();
export async function audioFixture(seconds = 6) {
  if (audioCache.has(seconds)) return audioCache.get(seconds);
  const result = await buildAudio(seconds);
  audioCache.set(seconds, result);
  return result;
}

async function buildAudio(seconds) {
  const embedded = { bytes: EMBEDDED_AAC_M4A, note: `embedded AAC fallback (6 s; ffmpeg unavailable) — the ${seconds} s a segment declares is what the timeline uses` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gamma-audio-"));
  const file = path.join(dir, `fixture-${seconds}s.m4a`);
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "anullsrc=r=48000:cl=mono", "-t", String(seconds), "-c:a", "aac", "-b:a", "64k",
      "-movflags", "+faststart", "-y", file], { stdio: "pipe" });
    const bytes = fs.readFileSync(file);
    // Say what it is before blaming a browser for not playing it.
    let verified = "assumed AAC (ffprobe unavailable)";
    try {
      const probe = execFileSync("ffprobe", ["-hide_banner", "-loglevel", "error",
        "-show_entries", "stream=codec_name,sample_rate,channels", "-show_entries", "format=duration",
        "-of", "default=nw=1", file], { encoding: "utf8" }).trim().replace(/\n/g, ", ");
      verified = `ffprobe: ${probe}`;
    } catch { /* keep the assumption, said plainly */ }
    return { bytes, note: `ffmpeg-generated ${path.basename(file)} (${bytes.length} bytes) — ${verified}` };
  } catch (error) {
    return { ...embedded, note: `${embedded.note} (${String(error.message).split("\n")[0]})` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Answer one mocked media/doc request the way a file server would: honour a
// Range request with 206 + Content-Range, and always send Content-Length.
export function serveBytes(route, bytes, contentType) {
  const range = route.request().headers()["range"];
  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : bytes.length - 1;
    const slice = bytes.subarray(start, end + 1);
    return route.fulfill({
      status: 206, contentType,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
        "Content-Length": String(slice.length),
      },
      body: slice,
    });
  }
  return route.fulfill({
    contentType,
    headers: { "Accept-Ranges": "bytes", "Content-Length": String(bytes.length) },
    body: bytes,
  });
}

// ---------------------------------------------------------------------------
// Engine selection

// A build with proprietary codecs changes what the media assertions can prove:
// Playwright's stock Chromium has NO AAC decoder, Chrome for Testing does.
//   CHROME_PATH=/tmp/gamma-browser-tools/chrome/.../chrome node tests/e2e/noteReplay.mjs
export const CHROME_PATH = process.env.CHROME_PATH || process.env.GAMMA_CHROME_PATH || "";

export function engineLaunchOptions(extra = {}) {
  return CHROME_PATH ? { ...extra, executablePath: CHROME_PATH } : { ...extra };
}

export function engineLabel(browser) {
  return CHROME_PATH
    ? `Chrome for Testing (${browser.version()}) at ${CHROME_PATH}`
    : `Playwright ${browser.browserType().name()} (${browser.version()})`;
}
