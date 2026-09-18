"""Build a versioned plugin ZIP and platform setup scripts for a Gamma release."""

import argparse
import hashlib
import json
import re
from pathlib import Path

from package_codex_plugin import build, validate_repo, write_archive


def release(output: Path, version: str, repo: str = "tim4431/Gamma") -> list[Path]:
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Release version must be X.Y.Z, optionally with a prerelease suffix.")
    validate_repo(repo)
    package = build(output / "gamma-marketplace")
    manifest_path = package / "plugins/gamma/.codex-plugin/plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["version"] = version
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    archive = output / f"gamma-codex-plugin-{version}.zip"
    write_archive(package, archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assets = [archive]
    for name in ("install-gamma-codex.ps1", "install-gamma-codex.sh"):
        script = Path(__file__).with_name(name).read_text(encoding="utf-8")
        script = script.replace("__GAMMA_ARCHIVE_URL__", f"https://github.com/{repo}/releases/download/v{version}/{archive.name}")
        script = script.replace("__GAMMA_ARCHIVE_SHA256__", digest)
        dest = output / name
        dest.write_text(script, encoding="utf-8", newline="\n")
        assets.append(dest)
    checksums = output / "gamma-codex-SHA256SUMS.txt"
    checksums.write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in assets), encoding="utf-8")
    return [*assets, checksums]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--repo", default="tim4431/Gamma")
    args = parser.parse_args()
    try:
        for asset in release(args.output, args.version, args.repo):
            print(asset)
    except ValueError as exc:
        parser.error(str(exc))
