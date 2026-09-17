import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from package_codex_plugin import build


class PackageTest(unittest.TestCase):
    def test_archive_is_installable_and_contains_only_distributable_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = build(Path(tmp) / "gamma-marketplace", "example/gamma-plugins", archive=True)
            catalog = json.loads((target / ".agents/plugins/marketplace.json").read_text(encoding="utf-8"))
            plugin = target / catalog["plugins"][0]["source"]["path"]
            self.assertTrue((plugin / ".codex-plugin/plugin.json").is_file())
            self.assertIn("example/gamma-plugins", (target / "README.md").read_text(encoding="utf-8"))
            with ZipFile(target.with_suffix(".zip")) as bundle:
                names = bundle.namelist()
                self.assertIn("gamma-marketplace/.agents/plugins/marketplace.json", names)
                self.assertIn("gamma-marketplace/plugins/gamma/.codex-plugin/plugin.json", names)
                self.assertFalse(any(n.endswith((".env", ".mcp.json", "config.toml")) for n in names))
                self.assertIn("gamma-marketplace/plugins/gamma/skills/gamma/assets/icon.png", names)
                self.assertEqual(len(names), 9)

    def test_existing_output_and_invalid_repo_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ValueError):
                build(root)
            with self.assertRaises(ValueError):
                build(root / "new", "https://example.com/repo")
            self.assertFalse((root / "new").exists())


if __name__ == "__main__":
    unittest.main()
