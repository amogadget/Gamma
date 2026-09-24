#!/usr/bin/env python3
"""Portable unit tests; no network, Mac, simulator, or build-tool installation."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build = load('ios_crypto_build', 'build-ios-crypto.py')
verify = load('ios_crypto_verify', 'verify-ios-crypto.py')


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.archive = self.cache / 'fixture-1.tar.gz'
        with tarfile.open(self.archive, 'w:gz') as archive:
            member = tarfile.TarInfo('fixture-1/content.txt')
            member.size = 8
            archive.addfile(member, io.BytesIO(b'verified'))
        self.spec = {'version': '1', 'url': 'https://example.invalid/fixture-1.tar.gz',
                     'sha256': hashlib.sha256(self.archive.read_bytes()).hexdigest()}

    def test_verified_cached_source_is_extracted_without_network(self):
        with patch.dict(build.SOURCES, {'fixture': self.spec}), patch.object(build.urllib.request, 'urlopen') as fetch:
            result = build.source('fixture', self.root, self.cache)
            self.assertEqual((result / 'content.txt').read_bytes(), b'verified')
            fetch.assert_not_called()

    def test_hash_mismatch_rejected_even_with_existing_source(self):
        (self.root / 'fixture-1').mkdir()
        self.archive.write_bytes(b'corrupt')
        with patch.dict(build.SOURCES, {'fixture': self.spec}):
            with self.assertRaisesRegex(RuntimeError, 'SHA256 mismatch'):
                build.source('fixture', self.root, self.cache)

    def test_archive_path_traversal_rejected(self):
        with tarfile.open(self.archive, 'w:gz') as archive:
            member = tarfile.TarInfo('../../escaped.txt')
            member.size = 1
            archive.addfile(member, io.BytesIO(b'x'))
        self.spec['sha256'] = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        with patch.dict(build.SOURCES, {'fixture': self.spec}):
            with self.assertRaises(tarfile.FilterError):
                build.source('fixture', self.root, self.cache)

    def test_source_and_tool_versions_are_not_downgraded(self):
        self.assertEqual(build.SOURCES['cryptography']['version'], '50.0.1')
        self.assertEqual(build.SOURCES['cffi']['version'], '2.1.1')
        self.assertEqual(build.MIN_IOS, '17.0')
        for item in build.SOURCES.values():
            self.assertEqual(len(item['sha256']), 64)
            self.assertTrue(item['url'].startswith('https://'))


class WheelVerificationTests(unittest.TestCase):
    def check_wheel(self, target='simulator', minos='17.0', dynamic_ffi=False, tag_floor='17_0'):
        with tempfile.TemporaryDirectory() as tmp:
            wheel = Path(tmp) / 'fixture.whl'
            platform = 'iphonesimulator' if target == 'simulator' else 'iphoneos'
            number = 7 if target == 'simulator' else 2
            with zipfile.ZipFile(wheel, 'w') as archive:
                archive.writestr('cffi-2.1.1.dist-info/METADATA', 'Name: cffi\nVersion: 2.1.1\n')
                archive.writestr('cffi-2.1.1.dist-info/WHEEL', f'Tag: cp313-cp313-ios_{tag_floor}_arm64_{platform}\n')
                archive.writestr('_cffi_backend.so', b'fixture-not-a-real-binary')

            def command(*args):
                if args[0] == 'lipo':
                    return 'arm64\n'
                if args[:2] == ('otool', '-l'):
                    return f' platform {number}\n minos {minos}\n sdk 27.0\n'
                if args[:2] == ('otool', '-L'):
                    return '@rpath/Python.framework/Python\n' + ('/usr/lib/libffi.dylib\n' if dynamic_ffi else '')
                self.fail(f'Unexpected command: {args}')

            stdout = io.StringIO()
            with patch.object(sys, 'argv', ['verify', '--target', target, str(wheel)]), patch.object(verify, 'output', side_effect=command), contextlib.redirect_stdout(stdout):
                verify.main()
            return json.loads(stdout.getvalue())

    def test_both_platforms_accept_matching_compiled_floor(self):
        for target in ('simulator', 'device'):
            with self.subTest(target=target):
                result = self.check_wheel(target)
                self.assertFalse(result['wheels'][0]['runtime_tested'])
                self.assertEqual(result['wheels'][0]['checks'][0]['minos'], ['17.0'])

    def test_false_minimum_os_tag_rejected(self):
        with self.assertRaises(AssertionError):
            self.check_wheel(minos='18.0')
        with self.assertRaises(AssertionError):
            self.check_wheel(tag_floor='13_0')

    def test_dynamic_libffi_rejected(self):
        with self.assertRaises(AssertionError):
            self.check_wheel(dynamic_ffi=True)


if __name__ == '__main__':
    unittest.main()
