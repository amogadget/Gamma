"""Portable unit tests; these do not claim an actual Apple build/import."""
import importlib.util
import json
from pathlib import Path
import plistlib
import struct
import tempfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("ios_wheels", HERE / "build-ios-python-wheels.py")
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
LOCK = json.loads((HERE / "ios-python-wheels.lock.json").read_text())


def macho(platform=7, cpu=0x0100000C):
    return struct.pack("<8I", 0xFEEDFACF, cpu, 0, 6, 1, 24, 0, 0) + struct.pack("<6I", 0x32, 24, platform, 0xD0000, 0x1B0000, 0)


class ValidationTests(unittest.TestCase):
    def test_framework_link_config_suppresses_unix_libpython(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            settings = driver.framework_link_settings(root, root / "slice with spaces", "3.13", ".cpython-313-iphonesimulator.so")
            config = Path(settings["PYO3_CONFIG_FILE"]).read_text()
            self.assertIn("suppress_build_script_link_lines=true\n", config)
            self.assertIn("version=3.13\n", config)
            self.assertIn("ext_suffix=.cpython-313-iphonesimulator.so\n", config)
            self.assertIn("shared=true\n", config)
            self.assertNotIn("PYO3_CROSS_LIB_DIR", settings)
            self.assertNotIn("lib_name=", config)
            self.assertEqual(settings["CARGO_ENCODED_RUSTFLAGS"].split("\x1f"),
                             ["-L", "framework=" + str(root / "slice with spaces"), "-l", "framework=Python"])

    def test_missing_target_extension_suffix_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            for suffix in (None, "", ".cpython-313-darwin.so\nsuppress_build_script_link_lines=false"):
                with self.assertRaises(ValueError):
                    driver.framework_link_settings(Path(root), Path(root), "3.13", suffix)

    def test_manifest_matches_parent_tested_toolchain_and_target(self):
        self.assertEqual(LOCK["rust_toolchain"], "1.98.1")
        self.assertEqual(LOCK["deployment_target"], "17.0")
        for target, sdk in (("simulator", "iphonesimulator"), ("device", "iphoneos")):
            with tempfile.TemporaryDirectory() as root:
                settings = driver.framework_link_settings(Path(root), Path(root), LOCK["python"],
                                                          LOCK["targets"][target]["extension_suffix"])
                self.assertIn(f"ext_suffix=.cpython-313-{sdk}.so\n",
                              Path(settings["PYO3_CONFIG_FILE"]).read_text())
                self.assertEqual(LOCK["targets"][target]["wheel_platform"], f"ios_17_0_arm64_{sdk}")

    def test_device_and_simulator_are_not_interchangeable(self):
        driver.validate_macho(macho(7), 7)
        driver.validate_macho(macho(2), 2)
        for platform in (1, 2):  # macOS arm64 and iOS arm64 are NOT simulator
            with self.assertRaises(ValueError):
                driver.validate_macho(macho(platform), 7)

    def test_reject_wrong_cpu_and_non_macho(self):
        for data in (macho(cpu=0x01000007), b"\x7fELF", b"", b"\xca\xfe\xba\xbe" + bytes(80)):
            with self.assertRaises(ValueError):
                driver.validate_macho(data, 7)

    def test_reject_truncation(self):
        with self.assertRaises(ValueError):
            driver.validate_macho(macho()[:-1], 7)

    def test_select_framework_slice_using_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            (root / "Info.plist").write_bytes(plistlib.dumps({"AvailableLibraries": [
                {"LibraryIdentifier": "device-custom", "SupportedPlatform": "ios", "SupportedArchitectures": ["arm64"]},
                {"LibraryIdentifier": "sim-custom", "SupportedPlatform": "ios", "SupportedPlatformVariant": "simulator", "SupportedArchitectures": ["x86_64", "arm64"]},
            ]}))
            self.assertEqual(driver.select_slice(root, "simulator"), root / "sim-custom")
            self.assertEqual(driver.select_slice(root, "device"), root / "device-custom")

    def make_wheel(self, root, platform=7, tag=None):
        tag = tag or LOCK["targets"]["simulator"]["wheel_platform"]
        path = Path(root) / f"pydantic_core-2.46.2-cp313-cp313-{tag}.whl"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("pydantic_core-2.46.2.dist-info/WHEEL", f"Wheel-Version: 1.0\nTag: cp313-cp313-{tag}\n")
            archive.writestr("pydantic_core/_pydantic_core.cpython-313-test.so", macho(platform))
        return path

    def test_valid_wheel(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIn("_pydantic_core", driver.validate_wheel(self.make_wheel(root), LOCK, "simulator"))

    def test_retagged_host_binary_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                driver.validate_wheel(self.make_wheel(root, platform=1), LOCK, "simulator")

    def test_device_wheel_cannot_be_used_for_simulator(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                driver.validate_wheel(self.make_wheel(root, platform=2, tag="ios_17_0_arm64_iphoneos"), LOCK, "simulator")


if __name__ == "__main__":
    unittest.main()
