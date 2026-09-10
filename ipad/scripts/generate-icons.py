#!/usr/bin/env python3
"""Derive iPad assets from the existing desktop Gamma logo (requires Pillow)."""
from pathlib import Path
import json
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
source = Image.open(ROOT / "desktop/assets/icon.png").convert("RGBA")
assets = ROOT / "ipad/GammaIPad/Assets.xcassets"
app = assets / "AppIcon.appiconset"
mark = assets / "GammaMark.imageset"
app.mkdir(parents=True, exist_ok=True)
mark.mkdir(parents=True, exist_ok=True)
# iOS app icons must be opaque. Preserve the supplied artwork, flattening its
# transparent surrounding area onto the artwork's own dark background.
opaque = Image.new("RGBA", source.size, "#1e1e1c")
opaque.alpha_composite(source)
opaque = opaque.convert("RGB")
entries = []
for size, scales in [(20, [1, 2]), (29, [1, 2]), (40, [1, 2]), (76, [1, 2]), (83.5, [2])]:
    for scale in scales:
        pixels = round(size * scale)
        filename = f"icon-{size:g}@{scale}x.png"
        opaque.resize((pixels, pixels), Image.Resampling.LANCZOS).save(app / filename)
        entries.append({"idiom": "ipad", "size": f"{size:g}x{size:g}", "scale": f"{scale}x", "filename": filename})
opaque.resize((1024, 1024), Image.Resampling.LANCZOS).save(app / "icon-1024.png")
entries.append({"idiom": "ios-marketing", "size": "1024x1024", "scale": "1x", "filename": "icon-1024.png"})
source.save(mark / "gamma-mark.png")
info = {"author": "xcode", "version": 1}
(app / "Contents.json").write_text(json.dumps({"images": entries, "info": info}, indent=2) + "\n")
(mark / "Contents.json").write_text(json.dumps({"images": [{"idiom": "universal", "filename": "gamma-mark.png", "scale": "1x"}], "info": info}, indent=2) + "\n")
(assets / "Contents.json").write_text(json.dumps({"info": info}, indent=2) + "\n")
print("Generated GammaMark and iPad AppIcon from desktop/assets/icon.png")
