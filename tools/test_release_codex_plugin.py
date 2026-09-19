import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from zipfile import ZipFile

from release_codex_plugin import release


class ReleaseTest(unittest.TestCase):
    def test_release_pins_version_download_and_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = release(root / "release", "1.2.3", "example/Gamma")
            archive = assets[0]
            with ZipFile(archive) as bundle:
                manifest = json.loads(bundle.read("gamma-marketplace/plugins/gamma/.codex-plugin/plugin.json"))
                self.assertEqual(manifest["version"], "1.2.3")
                self.assertIn("gamma-marketplace/.agents/plugins/marketplace.json", bundle.namelist())
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            for script in assets[1:3]:
                text = script.read_text()
                self.assertIn("https://github.com/example/Gamma/releases/download/v1.2.3/gamma-codex-plugin-1.2.3.zip", text)
                self.assertIn(digest, text)
                self.assertNotIn("__GAMMA_", text)
                self.assertNotIn("releases/latest", text)
            for line in assets[-1].read_text().splitlines():
                checksum, name = line.split("  ")
                self.assertEqual(checksum, hashlib.sha256((archive.parent / name).read_bytes()).hexdigest())
            for version in ("../bad", "1.2", "1.2.3;whoami"):
                with self.assertRaises(ValueError):
                    release(root / "bad", version)

    def run_installer(self, root, assets, *, fail="", bad_download=False, fail_move=False, short_path=False):
        """Exercise the real script; substitute only downloads and the Codex CLI."""
        log = root / "calls.txt"
        if log.exists():
            log.unlink()
        env = {**os.environ, "GAMMA_TEST_ARCHIVE": str(assets[0]), "GAMMA_TEST_LOG": str(log),
               "GAMMA_TEST_FAIL": fail, "GAMMA_TEST_BAD": "1" if bad_download else "",
               "GAMMA_TEST_MOVE_FAIL": "1" if fail_move else ""}
        posix_shell = os.environ.get("GAMMA_TEST_POSIX_SHELL")
        if os.name == "nt" and not posix_shell:
            # CI runs under PowerShell 7. Its module path is incompatible with
            # the Windows PowerShell 5.1 child used to exercise the installer.
            # Let that child initialize its own built-in module search paths.
            env = {key: value for key, value in env.items() if key.upper() != "PSMODULEPATH"}
            env["LOCALAPPDATA"] = str(root / "user data")
            if short_path:
                import ctypes
                Path(env["LOCALAPPDATA"]).mkdir(parents=True, exist_ok=True)
                buffer = ctypes.create_unicode_buffer(32768)
                length = ctypes.windll.kernel32.GetShortPathNameW(env["LOCALAPPDATA"], buffer, len(buffer))
                if not length or length >= len(buffer):
                    raise ctypes.WinError()
                if buffer.value == env["LOCALAPPDATA"]:
                    self.skipTest("8.3 path aliases are disabled on this volume")
                env["LOCALAPPDATA"] = buffer.value
            wrapper = root / "test.ps1"
            wrapper.write_text(r'''
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing)
    if ($env:GAMMA_TEST_BAD) { Set-Content -LiteralPath $OutFile -Value 'invalid zip' }
    else { Copy-Item -LiteralPath $env:GAMMA_TEST_ARCHIVE -Destination $OutFile }
}
function codex {
    Add-Content -LiteralPath $env:GAMMA_TEST_LOG -Value ($args -join '|')
    $global:LASTEXITCODE = if ($env:GAMMA_TEST_FAIL -and ($args -join ' ').StartsWith($env:GAMMA_TEST_FAIL)) { 7 } else { 0 }
}
function Move-Item {
    param($LiteralPath, $Destination)
    if ($env:GAMMA_TEST_MOVE_FAIL -and $LiteralPath.EndsWith('gamma-marketplace') -and $Destination.EndsWith('gamma-marketplace')) {
        throw 'Simulated replacement failure'
    }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
& $args[0] -ServerUrl 'http://localhost:9001/mcp'
''', encoding="utf-8")
            command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(wrapper), str(assets[1])]
        else:
            env["XDG_DATA_HOME"] = (root / "user data").as_posix()
            env["GAMMA_TEST_ARCHIVE"] = assets[0].as_posix()
            env["GAMMA_TEST_LOG"] = log.as_posix()
            bin_dir = root / "bin"
            bin_dir.mkdir(exist_ok=True)
            (bin_dir / "curl").write_text('''#!/bin/sh
for arg do dest="$arg"; done
if [ -n "$GAMMA_TEST_BAD" ]; then printf invalid > "$dest"; else cp "$GAMMA_TEST_ARCHIVE" "$dest"; fi
''')
            (bin_dir / "codex").write_text('''#!/bin/sh
joined=$(printf '%s|' "$@")
printf '%s\\n' "${joined%|}" >> "$GAMMA_TEST_LOG"
if [ -n "$GAMMA_TEST_FAIL" ]; then case "$*" in "$GAMMA_TEST_FAIL"*) exit 7;; esac; fi
''')
            (bin_dir / "mv").write_text('''#!/bin/sh
if [ -n "$GAMMA_TEST_MOVE_FAIL" ]; then
    case "$1" in */install.*/gamma-marketplace) exit 7;; esac
fi
command -p mv "$@"
''')
            for file in bin_dir.iterdir():
                file.chmod(0o755)
            env["PATH"] = str(bin_dir) + os.pathsep + env["PATH"]
            command = [posix_shell or "sh", assets[2].as_posix(), "http://localhost:9001/mcp"]
            if posix_shell and os.name == "nt":
                # Git Bash prepends its own bin directories on Windows startup.
                env["GAMMA_TEST_BIN"] = "/" + bin_dir.drive[0].lower() + bin_dir.as_posix()[2:]
                command = [posix_shell, "-c", 'PATH="$GAMMA_TEST_BIN:$PATH"; export PATH; exec sh "$1" "$2"',
                           "gamma-test", assets[2].as_posix(), "http://localhost:9001/mcp"]
        result = subprocess.run(command, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
        calls = log.read_text().splitlines() if log.exists() else []
        return result, calls

    def test_install_and_repeat_use_persistent_source_and_one_login(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = release(root / "release", "1.2.3")
            first_source = None
            for _ in range(2):
                result, calls = self.run_installer(root, assets)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(len(calls), 3)
                self.assertTrue(calls[0].startswith("plugin|marketplace|add|"))
                source = calls[0].split("|", 3)[-1]
                self.assertTrue((Path(source) / ".agents/plugins/marketplace.json").is_file())
                self.assertTrue((Path(source) / "plugins/gamma/skills/gamma/assets/icon.png").is_file())
                if first_source:
                    self.assertEqual(source, first_source)
                first_source = source
                self.assertEqual(calls[1], "plugin|add|gamma@gamma-local")
                self.assertEqual(calls[2], "mcp|add|gamma|--url|http://localhost:9001/mcp")

    def test_upgrade_removes_obsolete_files_and_cleans_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = release(root / "v1", "1.2.3")
            result, calls = self.run_installer(root, first)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            source = Path(calls[0].split("|", 3)[-1])
            obsolete = source / "plugins/gamma/skills/obsolete/SKILL.md"
            obsolete.parent.mkdir()
            obsolete.write_text("Removed in the next release")
            second = release(root / "v2", "1.2.4")

            # A bad download must leave the existing installation intact.
            result, calls = self.run_installer(root, second, bad_download=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])
            self.assertTrue(obsolete.is_file())
            self.assertEqual(list(source.parent.iterdir()), [source])

            result, calls = self.run_installer(root, second, fail_move=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])
            self.assertTrue(obsolete.is_file(), "restore the previous source if replacement fails")
            self.assertEqual(list(source.parent.iterdir()), [source])

            result, calls = self.run_installer(root, second)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(Path(calls[0].split("|", 3)[-1]), source)
            self.assertFalse(obsolete.exists())
            manifest = json.loads((source / "plugins/gamma/.codex-plugin/plugin.json").read_text())
            self.assertEqual(manifest["version"], "1.2.4")
            self.assertEqual(list(source.parent.iterdir()), [source])

    @unittest.skipUnless(os.name == "nt" and not os.environ.get("GAMMA_TEST_POSIX_SHELL"), "Windows path aliases")
    def test_install_accepts_short_local_app_data_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = release(root / "release", "1.2.3")
            result, calls = self.run_installer(root, assets, short_path=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(len(calls), 3)
            source = Path(calls[0].split("|", 3)[-1])
            self.assertTrue((source / ".agents/plugins/marketplace.json").is_file())
            self.assertEqual(list(source.parent.iterdir()), [source])

    def test_failed_download_or_install_never_changes_mcp(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = release(root / "release", "1.2.3")
            result, calls = self.run_installer(root, assets, bad_download=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(calls, [])
            result, calls = self.run_installer(root, assets, fail="plugin add")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(len(calls), 2)
            source = Path(calls[0].split("|", 3)[-1])
            self.assertEqual(list(source.parent.iterdir()), [source])
            result, calls = self.run_installer(root, assets, fail="mcp add")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(len(calls), 3)
            self.assertNotIn("Start a new chat", result.stdout)


if __name__ == "__main__":
    unittest.main()
