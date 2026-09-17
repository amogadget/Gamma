"""Build a credential-free, standalone Codex marketplace directory.

Never edits the user's Codex configuration or an existing marketplace.
Run from any directory: python tools/package_codex_plugin.py --output <new-dir>
"""

import argparse
import json
import re
import shutil
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def write_archive(package: Path, destination: Path) -> None:
    """Include hidden catalog files and keep one top-level package directory."""
    with ZipFile(destination, "x", ZIP_DEFLATED) as bundle:
        for file in sorted(package.rglob("*")):
            if file.is_file():
                bundle.write(file, (Path(package.name) / file.relative_to(package)).as_posix())


def build(target: Path, github_repo: str | None = None, archive: bool = False):
    """Export only distributable plugin files, never local connections or caches."""
    target = target.resolve()
    archive_path = target.with_name(target.name + ".zip")
    if target.exists() or (archive and archive_path.exists()):
        raise ValueError("Output already exists. Choose a new directory to preserve the existing package.")
    if github_repo and not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", github_repo):
        raise ValueError("GitHub repository must be owner/repo.")
    source = Path(__file__).resolve().parents[1] / "plugins" / "gamma"
    manifest = json.loads((source / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))
    if manifest.get("name") != "gamma" or manifest.get("mcpServers") or manifest.get("apps"):
        raise ValueError("Expected the credential-free Gamma skills plugin.")
    # Explicit allowlist: a developer's .env, caches or MCP config cannot leak.
    for relative in (".codex-plugin/plugin.json", "README.md", "skills/gamma/SKILL.md", "skills/gamma/agents/openai.yaml", "skills/gamma/assets/icon.png"):
        dest = target / "plugins" / "gamma" / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, dest)
    docs = target / "docs" / "dev"
    docs.mkdir(parents=True)
    shutil.copy2(source.parents[1] / "docs" / "dev" / "mcp.md", docs / "mcp.md")
    shutil.copy2(source.parents[1] / "PRIVACY.md", target / "PRIVACY.md")
    catalog = target / ".agents" / "plugins" / "marketplace.json"
    catalog.parent.mkdir(parents=True)
    catalog.write_text(json.dumps({
        "name": "gamma-local",
        "interface": {"displayName": "Gamma PDF"},
        "plugins": [{"name": "gamma", "source": {"source": "local", "path": "./plugins/gamma"},
                     "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                     "category": "Productivity"}],
    }, indent=2) + "\n", encoding="utf-8")
    install_source = github_repo or f'"./{target.name}"'
    template = Path(__file__).with_name("codex-marketplace-README.md").read_text(encoding="utf-8")
    install_intro = ("After this repository is published, run:" if github_repo else
                     "Extract the archive and run this from the parent of the extracted directory:")
    (target / "README.md").write_text(template.format(install_intro=install_intro, install_source=install_source),
                                    encoding="utf-8")
    if archive:
        write_archive(target, archive_path)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--github-repo", help="Destination marketplace repository, owner/repo; only used in installation instructions")
    parser.add_argument("--archive", action="store_true", help="Also create a ZIP beside the output directory")
    args = parser.parse_args()
    try:
        target = build(args.output, args.github_repo, args.archive)
    except ValueError as exc:
        parser.error(str(exc))
    print(f"Marketplace written to {target}")
    print(f'Add it with: codex plugin marketplace add "{target}"')
    print("Install Gamma PDF in the plugin browser, then start a new conversation.")


if __name__ == "__main__":
    main()
