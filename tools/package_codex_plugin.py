"""Build a credential-free, standalone Codex marketplace directory.

Never edits the user's Codex configuration or an existing marketplace.
Run from any directory: python tools/package_codex_plugin.py --output <new-dir>
"""

import argparse
import json
import shutil
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    target = args.output.resolve()
    if target.exists():
        parser.error("Output already exists. Choose a new directory to preserve the existing package.")
    source = Path(__file__).resolve().parents[1] / "plugins" / "gamma"
    shutil.copytree(source, target / "plugins" / "gamma")
    # The source README's relative guide link must also work in a standalone bundle.
    docs = target / "docs" / "dev"
    docs.mkdir(parents=True)
    shutil.copy2(source.parents[1] / "docs" / "dev" / "mcp.md", docs / "mcp.md")
    catalog = target / ".agents" / "plugins" / "marketplace.json"
    catalog.parent.mkdir(parents=True)
    catalog.write_text(json.dumps({
        "name": "gamma-local",
        "interface": {"displayName": "Gamma PDF"},
        "plugins": [{"name": "gamma", "source": {"source": "local", "path": "./plugins/gamma"},
                     "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                     "category": "Productivity"}],
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Marketplace written to {target}")
    print(f'Add it with: codex plugin marketplace add "{target}"')
    print("Install Gamma PDF in the plugin browser, then start a new conversation.")


if __name__ == "__main__":
    main()
