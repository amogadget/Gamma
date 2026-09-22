import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

from package_plugins import MANIFEST_PATHS, build
from release_plugins import release


class SharedPluginTest(unittest.TestCase):
    def test_both_catalogs_resolve_to_the_same_self_contained_plugin(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = build(Path(tmp) / "gamma-marketplace", archive=True)
            codex = json.loads((target / ".agents/plugins/marketplace.json").read_text())
            claude = json.loads((target / ".claude-plugin/marketplace.json").read_text())
            self.assertEqual(codex["name"], claude["name"])
            plugin = target / claude["plugins"][0]["source"]
            self.assertEqual(plugin, target / codex["plugins"][0]["source"]["path"])
            for relative in MANIFEST_PATHS:
                manifest = json.loads((plugin / relative).read_text())
                self.assertTrue((plugin / manifest["skills"] / "gamma/SKILL.md").is_file())
                self.assertNotIn("mcpServers", manifest)
                self.assertNotIn("apps", manifest)
            source = Path(__file__).resolve().parents[1] / "plugins/gamma"
            self.assertEqual((plugin / "skills/gamma/SKILL.md").read_bytes(),
                             (source / "skills/gamma/SKILL.md").read_bytes())
            expected = {
                "README.md", "PRIVACY.md", "docs/dev/mcp.md",
                ".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json",
                "plugins/gamma/.codex-plugin/plugin.json",
                "plugins/gamma/.claude-plugin/plugin.json", "plugins/gamma/README.md",
                "plugins/gamma/skills/gamma/SKILL.md",
                "plugins/gamma/skills/gamma/agents/openai.yaml",
                "plugins/gamma/skills/gamma/assets/icon.png",
            }
            with ZipFile(target.with_suffix(".zip")) as bundle:
                self.assertEqual(set(bundle.namelist()), {f"gamma-marketplace/{p}" for p in expected})
                extracted = Path(tmp) / "extracted"
                bundle.extractall(extracted)
            # Extraction retains hidden catalogs and every file, including on Windows.
            for relative in expected:
                self.assertEqual((target / relative).read_bytes(),
                                 (extracted / "gamma-marketplace" / relative).read_bytes())

    def test_manifest_drift_fails_before_creating_output(self):
        read_text = Path.read_text

        def changed_manifest(path, *args, **kwargs):
            text = read_text(path, *args, **kwargs)
            if path.parent.name == ".claude-plugin" and path.name == "plugin.json":
                manifest = json.loads(text)
                manifest["version"] = "99.0.0"
                return json.dumps(manifest)
            return text

        with tempfile.TemporaryDirectory() as tmp, patch.object(Path, "read_text", changed_manifest):
            target = Path(tmp) / "package"
            with self.assertRaisesRegex(ValueError, "disagree on version"):
                build(target)
            self.assertFalse(target.exists())

    def test_release_keeps_downloads_identical_and_versions_both_manifests(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "release"
            assets = release(root, "1.2.3-preview.1", "example/Gamma")
            codex = root / "gamma-codex-plugin-1.2.3-preview.1.zip"
            claude = root / "gamma-claude-code-plugin-1.2.3-preview.1.zip"
            self.assertEqual(codex.read_bytes(), claude.read_bytes())
            with ZipFile(claude) as bundle:
                for relative in MANIFEST_PATHS:
                    manifest = json.loads(bundle.read(f"gamma-marketplace/plugins/gamma/{relative}"))
                    self.assertEqual(manifest["version"], "1.2.3-preview.1")
            for sums in (p for p in assets if p.name.endswith("SHA256SUMS.txt")):
                for line in sums.read_text().splitlines():
                    digest, name = line.split("  ")
                    self.assertEqual(digest, hashlib.sha256((root / name).read_bytes()).hexdigest())
            before = {p.name: p.read_bytes() for p in assets}
            with self.assertRaises(ValueError):
                release(root, "1.2.3-preview.1")
            self.assertEqual(before, {p.name: p.read_bytes() for p in assets})

    def test_partial_claude_release_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            existing = root / "gamma-claude-code-plugin-1.2.3.zip"
            existing.write_bytes(b"keep this")
            with self.assertRaises(ValueError):
                release(root, "1.2.3")
            self.assertEqual(list(root.iterdir()), [existing])
            self.assertEqual(existing.read_bytes(), b"keep this")


if __name__ == "__main__":
    unittest.main()
