"""Portable structural tests, not substitutes for parent-owned iOS imports."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('rust_deps', Path(__file__).with_name('build-ios-rust-deps.py'))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
LOCK = json.loads(build.LOCK.read_text())


def macho(platform=7, cpu=0x0100000C):
    return struct.pack('<8I', 0xFEEDFACF, cpu, 0, 6, 1, 24, 0, 0) + struct.pack('<6I', 0x32, 24, platform, 17 << 16, 27 << 16, 0)


class RustWheels(unittest.TestCase):
    def wheel(self, root, name='bcrypt', target='simulator', platform=None, cpu=0x0100000C, internal=None, extension=None, abi='cp313'):
        pkg = LOCK['packages'][name]
        tag = 'cp313-' + abi + '-ios_17_0_arm64_' + ('iphonesimulator' if target == 'simulator' else 'iphoneos')
        stem = name.replace('-', '_') + '-' + pkg['version']
        path = root / (stem + '-' + tag + '.whl')
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr(stem + '.dist-info/WHEEL', 'Wheel-Version: 1.0\nTag: ' + (internal or tag) + '\n')
            z.writestr(extension or pkg['extension'] + '.abi3.so', macho(platform if platform is not None else (7 if target == 'simulator' else 2), cpu))
        return path, pkg

    def test_exact_pins(self):
        self.assertEqual(LOCK['packages']['bcrypt']['version'], '5.0.0')
        self.assertEqual(LOCK['packages']['rpds-py']['version'], '2026.6.3')
        for pkg in LOCK['packages'].values():
            self.assertEqual(len(pkg['sha256']), 64)
            self.assertTrue(pkg['url'].startswith('https://files.pythonhosted.org/'))

    def test_accepts_each_target_and_package(self):
        with tempfile.TemporaryDirectory() as d:
            for name in LOCK['packages']:
                for target in ('simulator', 'device'):
                    path, pkg = self.wheel(Path(d), name, target)
                    self.assertTrue(build.validate_wheel(path, pkg, name, target).endswith('.so'))

    def test_rejects_wrong_platform_cpu_tags_extension(self):
        with tempfile.TemporaryDirectory() as d:
            for options in ({'platform': 1}, {'platform': 2}, {'cpu': 0x01000007}, {'internal': 'cp313-cp313-macosx_14_0_arm64'}, {'extension': 'wrong/module.so'}, {'abi': 'cp312'}):
                path, pkg = self.wheel(Path(d), **options)
                with self.assertRaises(ValueError):
                    build.validate_wheel(path, pkg, 'bcrypt', 'simulator')

    def test_rejects_renamed_host_wheel(self):
        with tempfile.TemporaryDirectory() as d:
            path, pkg = self.wheel(Path(d), platform=1)
            with self.assertRaisesRegex(ValueError, 'platform'):
                build.validate_wheel(path, pkg, 'bcrypt', 'simulator')

    def test_rejects_mismatched_deployment_floor(self):
        with tempfile.TemporaryDirectory() as d:
            path, pkg = self.wheel(Path(d))
            with zipfile.ZipFile(path) as z:
                entries = {n: z.read(n) for n in z.namelist()}
            extension = next(n for n in entries if n.endswith('.so'))
            data = bytearray(entries[extension])
            struct.pack_into('<I', data, 44, 13 << 16)
            entries[extension] = data
            with zipfile.ZipFile(path, 'w') as z:
                for n, blob in entries.items():
                    z.writestr(n, blob)
            with self.assertRaisesRegex(ValueError, 'deployment floor'):
                build.validate_wheel(path, pkg, 'bcrypt', 'simulator')

    def test_truncated_macho(self):
        for data in (b'', macho()[:35], macho()[:-1]):
            with self.assertRaises(ValueError):
                build.core.validate_macho(data, 7)


if __name__ == '__main__':
    unittest.main()
