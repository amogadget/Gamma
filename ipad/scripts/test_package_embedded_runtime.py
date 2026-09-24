"""Portable packaging checks; no SDK, subprocess Mac tools, network or pip."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location("packager", Path(__file__).with_name("package-embedded-runtime.py"))
p = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(p)


def binary(platform=7, minimum=13 << 16, cpu=0x0100000C):
    return struct.pack("<8I", 0xFEEDFACF, cpu, 0, 6, 1, 24, 0, 0) + struct.pack("<6I", 0x32, 24, platform, minimum, 0, 0)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def wheel(self, name="example", version="1.0", native=False, members=None, requires=""):
        tag = "cp313-cp313-ios_13_0_arm64_iphonesimulator" if native else "py3-none-any"
        path = self.root / f"{name}-{version}-{tag}.whl"
        entries = {f"{name}-{version}.dist-info/METADATA": f"Name: {name}\nVersion: {version}\n{requires}", f"{name}-{version}.dist-info/WHEEL": f"Wheel-Version: 1.0\nTag: {tag}\n", f"{name}-{version}.dist-info/licenses/LICENSE": "license", f"{name}/__init__.py": ""}
        if native:
            entries[f"{name}/_native.cpython-313-iphonesimulator.so"] = binary()
        entries.update(members or {})
        with zipfile.ZipFile(path, "w") as archive:
            for key, value in entries.items():
                archive.writestr(key, value)
        return path, {"filename": path.name, "name": name, "version": version, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def test_paths(self):
        for value in ("../x", "/x", "a/../x", "a\\x", "a//x", "C:/x", "./x"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                p.safe_relative(value)
        self.assertEqual(str(p.safe_relative("a/b")), "a/b")

    def test_zip_traversal(self):
        path, record = self.wheel(members={"../escape": "bad"})
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            p.wheel_payload(path, record, "simulator", False)
        self.assertFalse((self.root.parent / "escape").exists())

    def test_hash_exact_version_and_data_preserved(self):
        path, record = self.wheel(members={"example/zones/Asia/Shanghai": "zone", "example/CLAUDE.md": "excluded", "example/__pycache__/x.pyc": "excluded"})
        payload, _ = p.wheel_payload(path, record, "simulator", False)
        self.assertIn(p.PurePosixPath("example/zones/Asia/Shanghai"), payload)
        self.assertTrue(any("licenses/LICENSE" in str(x) for x in payload))
        self.assertFalse(any("CLAUDE" in str(x) or "__pycache__" in str(x) for x in payload))
        with self.assertRaisesRegex(ValueError, "SHA256"):
            p.wheel_payload(path, dict(record, sha256="0" * 64), "simulator", False)
        with self.assertRaisesRegex(ValueError, "version mismatch"):
            p.wheel_payload(path, dict(record, version="2.0"), "simulator", False)

    def test_setuptools_vendored_metadata_and_windows_launcher_data(self):
        path, record = self.wheel(name="setuptools", members={
            "setuptools/_vendor/example-2.dist-info/METADATA": "Name: example\nVersion: 2\n",
            "setuptools/_vendor/example-2.dist-info/WHEEL": "Tag: py3-none-any\n",
            "setuptools/_vendor/example.py": "value = 2\n",
            "setuptools/cli-32.exe": b"MZnot-for-ios",
        })
        payload, metadata = p.wheel_payload(path, record, "simulator", False)
        self.assertEqual(metadata["Name"], "setuptools")
        self.assertIn(p.PurePosixPath("setuptools/_vendor/example.py"), payload)
        self.assertNotIn(p.PurePosixPath("setuptools/cli-32.exe"), payload)

    def test_stdlib_libpython_link_is_not_bundled(self):
        source = self.root / "stdlib"
        source.mkdir()
        (source / "libpython3.13.dylib").symlink_to("/not-a-real-library")
        (source / "os.py").write_text("# stdlib")
        output = self.root / "output"
        p.copy_tree(source, output)
        self.assertTrue((output / "os.py").exists())
        self.assertFalse((output / "libpython3.13.dylib").exists())

    def test_platform_architecture_and_minimum(self):
        p.macho(binary(), 7)
        p.macho(binary(platform=2, minimum=17 << 16), 2)
        for data in (binary(platform=2), binary(minimum=18 << 16), binary(cpu=0x01000007), b"\xca\xfe\xba\xbe" + b"0" * 100):
            with self.assertRaises(ValueError):
                p.macho(data, 7)
        p.validate_tag("cp39-abi3-ios_13_0_arm64_iphonesimulator", "simulator", True)
        for tag in ("cp313-cp313-ios_13_0_arm64_iphoneos", "cp313-cp313-ios_18_0_arm64_iphonesimulator", "cp314-cp314-ios_17_0_arm64_iphonesimulator"):
            with self.assertRaises(ValueError):
                p.validate_tag(tag, "simulator", True)

    def test_native_wheel_and_builtin_pdf_rejection(self):
        path, record = self.wheel(native=True)
        p.wheel_payload(path, record, "simulator", True)
        with self.assertRaises(ValueError):
            p.wheel_payload(path, record, "device", True)
        path, record = self.wheel(native=True, members={"_gamma_ios_pdf.so": binary()})
        # Both bare and ABI-tagged builtins are prohibited by conversion too.
        with self.assertRaises(ValueError):
            p.wheel_payload(path, record, "simulator", True)

    def test_colliding_modules(self):
        for name in ("pkg/core.abi3.so", "pkg/core.cpython-313-iphoneos.so"):
            target = self.root / name
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(binary())
        with self.assertRaisesRegex(ValueError, "Colliding"):
            p.extension_plan([self.root])

    def test_guard_output(self):
        app = self.root / "build/Gamma.app"
        self.assertEqual(p.guard_output(self.root / "build", app, app / "EmbeddedGamma"), (app, app / "EmbeddedGamma"))
        for app_path, resource in ((self.root / "data", self.root / "data/EmbeddedGamma"), (app, self.root / "data"), (self.root / "Gamma.app", self.root / "Gamma.app/EmbeddedGamma")):
            with self.assertRaises(ValueError):
                p.guard_output(self.root / "build", app_path, resource)

    def test_dependency_closure(self):
        path, record = self.wheel(requires="Requires-Dist: absent>=1\n")
        _, metadata = p.wheel_payload(path, record, "simulator", False)
        with self.assertRaisesRegex(ValueError, "Missing/incompatible"):
            p.check_dependencies([metadata])
        path, record = self.wheel(requires="Requires-Dist: absent; sys_platform == 'win32'\n")
        _, metadata = p.wheel_payload(path, record, "simulator", False)
        p.check_dependencies([metadata])

    def test_native_set_required(self):
        path, record = self.wheel()
        (self.root / "pure").mkdir()
        path.rename(self.root / "pure" / path.name)
        with self.assertRaisesRegex(ValueError, "Missing required native"):
            p.closure(self.root, {"pure": [record], "native": {"simulator": []}}, "simulator")

    def test_flat_production_lock_and_setuptools_payload(self):
        (self.root / "pure").mkdir()
        (self.root / "simulator").mkdir()
        lock = []
        path, record = self.wheel(name="setuptools", version="84.0.0", members={
            "_distutils_hack/__init__.py": "# retained",
            "setuptools/_vendor/example.py": "# retained",
            "distutils-precedence.pth": "# retained"})
        path.rename(self.root / "pure" / path.name)
        lock.append(dict(record, native=False))
        for name in sorted(p.NATIVE):
            path, record = self.wheel(name=name.replace("-", "_"), native=True)
            path.rename(self.root / "simulator" / path.name)
            lock.append({"name": name, "version": record["version"], "native": True,
                         "wheels": {"simulator": {"filename": record["filename"], "sha256": record["sha256"]}}})
        payload = dict(p.closure(self.root, lock, "simulator"))
        for name in ("setuptools/__init__.py", "_distutils_hack/__init__.py", "setuptools/_vendor/example.py", "distutils-precedence.pth"):
            self.assertIn(p.PurePosixPath(name), payload)
        with self.assertRaisesRegex(ValueError, "Missing locked device wheel"):
            p.closure(self.root, lock, "device")
        lock[-1]["wheels"]["simulator"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
            p.closure(self.root, lock, "simulator")

    def test_unfinished_flat_native_lock_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "Missing locked simulator wheel"):
            p.lock_records([{"name": "cryptography", "version": "50.0.0", "native": True}], "simulator")
        with self.assertRaisesRegex(ValueError, "requires name, version, filename and sha256"):
            p.lock_records([{"name": "cryptography", "version": "50.0.0", "native": True,
                             "wheels": {"simulator": {"filename": "crypto.whl"}}}], "simulator")

    def test_required_cjk_font_and_license(self):
        with self.assertRaisesRegex(ValueError, "Required CJK font missing"):
            p.cjk_font_payload(self.root)
        font = self.root / "DroidSansFallbackFull.ttf"
        font.write_bytes(b"not a font")
        with self.assertRaisesRegex(ValueError, "not a TrueType"):
            p.cjk_font_payload(self.root)
        font.write_bytes(b"\x00\x01\x00\x00\x00\x01" + b"\x00" * 22)
        with self.assertRaisesRegex(ValueError, "requires its license"):
            p.cjk_font_payload(self.root)
        (self.root / "NOTICE").write_text("vendor notice")
        with self.assertRaisesRegex(ValueError, "NOTICE alone"):
            p.cjk_font_payload(self.root)
        (self.root / "copyright").write_text("vendor font copyright and license")
        (self.root / "unrelated.key").write_text("not included")
        payload = dict(p.cjk_font_payload(self.root))
        self.assertEqual(set(payload), {"DroidSansFallbackFull.ttf", "copyright", "NOTICE"})
        self.assertEqual(payload[font.name], font.read_bytes())
        (self.root / "copyright").write_text("")
        with self.assertRaisesRegex(ValueError, "Empty CJK"):
            p.cjk_font_payload(self.root)

    def test_cjk_font_symlink_is_rejected(self):
        (self.root / "font.ttf").write_bytes(b"font")
        (self.root / "DroidSansFallbackFull.ttf").symlink_to("font.ttf")
        with self.assertRaisesRegex(ValueError, "Required CJK font missing"):
            p.cjk_font_payload(self.root)

    def test_case_collision_across_distributions(self):
        records = []
        (self.root / "pure").mkdir()
        for name, resource in (("one", "shared/data"), ("two", "SHARED/data")):
            path, record = self.wheel(name=name, members={resource: "data"})
            path.rename(self.root / "pure" / path.name)
            records.append(record)
        with self.assertRaisesRegex(ValueError, "Colliding distributions"):
            p.closure(self.root, {"pure": records, "native": {"simulator": []}}, "simulator")


if __name__ == "__main__":
    unittest.main()
