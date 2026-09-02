// Rasterize assets/icon.svg to assets/icon.png (1024×1024), which is what
// electron-builder turns into .icns and .ico.
//
//   npx electron scripts/render-icon.cjs        (add `xvfb-run -a` on a
//                                                headless Linux box)
//
// Rendered by Chromium rather than a command-line converter because the icon
// uses a clip path and a radial gradient: ImageMagick's built-in SVG renderer
// silently drops the clipped group, which loses the Γ and the standing wave and
// lets the mirrors escape the rounded square. The engine that will draw the app
// is the one that should draw its icon.

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 1024;
const svg = path.resolve(__dirname, "..", "assets", "icon.svg");
const out = path.resolve(__dirname, "..", "assets", "icon.png");

app.disableHardwareAcceleration(); // deterministic output, and works headless

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true, deviceScaleFactor: 1 },
  });

  // The markup is inlined rather than referenced: a data: URL is an opaque
  // origin, so an <img src="file://…"> inside one is blocked and captures as a
  // broken-image glyph.
  const markup = fs.readFileSync(svg, "utf8");
  await win.loadURL(
    // A page with no margins, so the SVG lands exactly on the capture bounds.
    "data:text/html;charset=utf-8," +
      encodeURIComponent(
        `<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
         svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${markup}`,
      ),
  );
  // One more frame after load, or the capture can catch the page still blank.
  await new Promise((r) => setTimeout(r, 400));

  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  if (png.length < 1000) {
    console.error("capture came back empty");
    app.exit(1);
    return;
  }
  fs.writeFileSync(out, png);
  console.log(`wrote ${path.relative(process.cwd(), out)} (${png.length} bytes)`);
  app.exit(0);
});
