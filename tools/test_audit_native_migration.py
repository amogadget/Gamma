import copy
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

from audit_native_migration import compare, snapshot


class NativeMigrationAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        with sqlite3.connect(self.root / "users.db") as db:
            db.execute("CREATE TABLE users(username TEXT PRIMARY KEY)")
            db.execute("INSERT INTO users VALUES ('alice')")
        self.library = self.root / "users" / "alice"
        self.uploads = self.library / "uploads"
        self.uploads.mkdir(parents=True)
        self.asset = "a" * 64 + ".m4a"
        (self.uploads / self.asset).write_bytes(b"original audio bytes")
        with sqlite3.connect(self.library / "pages.db") as db:
            db.execute("CREATE TABLE unified_blocks(id TEXT,parent_id TEXT,position TEXT,content TEXT,properties TEXT)")
            db.execute("INSERT INTO unified_blocks VALUES (?,?,?,?,?)", ("block1", "page1", "a0", "private note must not appear in inventory", json.dumps({"type": "audio", "segments": [{"asset": "/api/assets/" + self.asset, "duration": 4}]})))

    def migrate(self):
        (self.root / "workspaces").mkdir()
        self.library.rename(self.root / "workspaces" / "ws1")
        with sqlite3.connect(self.root / "users.db") as db:
            db.execute("ALTER TABLE users ADD COLUMN default_workspace TEXT")
            db.execute("UPDATE users SET default_workspace='ws1'")
        self.library = self.root / "workspaces" / "ws1"
        self.uploads = self.library / "uploads"

    def test_directory_migration_preserves_native_identity(self):
        before = snapshot(self.root)
        self.assertNotIn("private note", json.dumps(before))
        self.migrate()
        self.assertTrue(compare(before, snapshot(self.root))["ok"])

    def test_wrong_workspace_assignment_detected(self):
        before = snapshot(self.root)
        self.migrate()
        self.library.rename(self.root / "workspaces" / "wrong-workspace")
        result = compare(before, snapshot(self.root))
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["lost_or_changed_native_blocks"]), 1)

    def test_wrong_account_assignment_detected(self):
        before = snapshot(self.root)
        self.migrate()
        with sqlite3.connect(self.root / "users.db") as db:
            db.execute("UPDATE users SET username='another-account'")
        self.assertFalse(compare(before, snapshot(self.root))["ok"])

    def test_deletion_detected(self):
        before = snapshot(self.root)
        self.migrate()
        (self.uploads / self.asset).unlink()
        result = compare(before, snapshot(self.root))
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["lost_or_changed_assets"]), 1)
        self.assertEqual(len(result["missing_references_after"]), 1)

    def test_byte_change_detected(self):
        before = snapshot(self.root)
        (self.uploads / self.asset).write_bytes(b"modified")
        self.assertFalse(compare(before, snapshot(self.root))["ok"])

    def test_manifest_change_detected(self):
        before = snapshot(self.root)
        with sqlite3.connect(self.library / "pages.db") as db:
            db.execute("UPDATE unified_blocks SET properties='{}'")
        self.assertFalse(compare(before, snapshot(self.root))["ok"])

    def test_missing_source_not_accepted(self):
        (self.uploads / self.asset).unlink()
        broken = snapshot(self.root)
        self.assertFalse(compare(broken, copy.deepcopy(broken))["ok"])

    def test_refuse_symlink(self):
        (self.uploads / "link").symlink_to(self.root / "users.db")
        with self.assertRaisesRegex(ValueError, "symlink"):
            snapshot(self.root)

    def test_cli_does_not_overwrite_evidence(self):
        output = self.root / "evidence.json"
        command = [sys.executable, str(Path(__file__).with_name("audit_native_migration.py")), "snapshot", str(self.root), str(output)]
        first = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(first.returncode, 0, first.stderr)
        original = output.read_bytes()
        second = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual(output.read_bytes(), original)

    def test_cli_compare_reports_failure(self):
        before = self.root / "before.json"
        after = self.root / "after.json"
        before.write_text(json.dumps(snapshot(self.root)))
        (self.uploads / self.asset).unlink()
        after.write_text(json.dumps(snapshot(self.root)))
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("audit_native_migration.py")), "compare", str(before), str(after)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertFalse(json.loads(result.stdout)["ok"])

    def test_invalid_directory(self):
        with tempfile.TemporaryDirectory() as empty:
            with self.assertRaisesRegex(ValueError, "users.db"):
                snapshot(empty)


if __name__ == "__main__":
    unittest.main()
