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
    (target / "README.md").write_text(f"""# Gamma PDF for Codex

Search and read your Gamma pages, notes, highlights and PDF text from Codex.

## Connect your library

Open Gamma in your browser and go to **Settings → AI → External assistants**.
Copy the MCP server URL into your assistant's MCP settings, or copy the Codex
CLI setup commands. Sign in with Gamma and approve the workspace you want to
share, then start a new chat. No manual token or environment variable is needed.
Keep Gamma reachable. Self-hosted servers use HTTPS; localhost supports HTTP.
See [the guide](docs/dev/mcp.md) for server configuration and manual-token setup.

For the combined installer, choose **Codex CLI** in that settings panel and copy
the command for Windows PowerShell or macOS/Linux. It installs the released plugin
and connects this server. Requires the Codex CLI and a Gamma release containing
the setup scripts; no Gamma desktop app is required.

## Install the optional workflow

{'After this repository is published, run:' if github_repo else 'Extract the archive and run this from the parent of the extracted directory:'}

```text
codex plugin marketplace add {install_source}
```

Open the desktop Plugins Directory, select **Gamma PDF**, and install the plugin.
Start a new chat. Installing the workflow alone does not connect your library.
Mention Gamma PDF with @ and ask "Let me choose a paper". An MCP Apps-capable
client shows a searchable picker; other clients receive a text list. The picker
requires the updated Gamma backend and stays in the authorized workspace.
This package contains no credentials and does not publish a public directory listing.

## Publish this marketplace on GitHub

Commit the contents of this directory as the root of your marketplace repository,
including `.agents/` and `plugins/gamma/.codex-plugin/`. Once pushed, users can
add it with `codex plugin marketplace add OWNER/REPO`. To release an update,
replace the package contents and push; users refresh their marketplace and
reinstall the plugin, then start a new chat.

See [the integration guide](docs/dev/mcp.md) and [privacy policy](PRIVACY.md).
""", encoding="utf-8")
    if archive:
        with ZipFile(archive_path, "w", ZIP_DEFLATED) as bundle:
            for file in sorted(target.rglob("*")):
                if file.is_file():
                    bundle.write(file, (Path(target.name) / file.relative_to(target)).as_posix())
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
