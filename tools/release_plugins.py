"""Build both assistant downloads from the same versioned marketplace.

Codex asset names and installers remain compatible with published setup commands.
The Claude Code ZIP is an identical package with its own discoverable asset name.
"""

import argparse
import hashlib
import shutil
from pathlib import Path

from release_codex_plugin import release as release_codex


def release(output: Path, version: str, repo: str = "tim4431/Gamma") -> list[Path]:
    # Never overwrite an existing artifact, including a partial previous release.
    if list(output.glob("gamma-claude-code-*")):
        raise ValueError("Claude Code release output already exists. Choose a new directory.")
    assets = release_codex(output, version, repo)
    archive = output / f"gamma-claude-code-plugin-{version}.zip"
    checksums = output / "gamma-claude-code-SHA256SUMS.txt"
    shutil.copy2(assets[0], archive)
    checksums.write_text(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n",
                         encoding="utf-8")
    return [*assets, archive, checksums]


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
