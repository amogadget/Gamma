#!/usr/bin/env python3
"""Validate crypto wheels' metadata, arm64 Mach-O platform, and dynamic links.

This is structural validation only, NOT an iOS runtime/Fernet smoke test.
Run on macOS: python verify-ios-crypto.py --target simulator wheel1.whl ...
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile


def output(*cmd):
    return subprocess.check_output(cmd, text=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, choices=('simulator', 'device'))
    parser.add_argument('--native-root', type=Path, help='Also inspect every static OpenSSL/libffi archive member')
    parser.add_argument('wheels', type=Path, nargs='+')
    args = parser.parse_args()
    expected_platform = 7 if args.target == 'simulator' else 2
    platform_name = 'iphonesimulator' if args.target == 'simulator' else 'iphoneos'
    expected_versions = {'cryptography': '50.0.1', 'cffi': '2.1.1'}
    results = []
    for path in args.wheels:
        with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(path) as wheel:
            names = wheel.namelist()
            meta = wheel.read(next(n for n in names if n.endswith('.dist-info/METADATA'))).decode()
            name = re.search(r'^Name: (.+)$', meta, re.M)[1]
            version = re.search(r'^Version: (.+)$', meta, re.M)[1]
            assert version == expected_versions[name], (name, version)
            tag = wheel.read(next(n for n in names if n.endswith('.dist-info/WHEEL'))).decode()
            assert re.search(rf'^Tag: .*ios_17_0_arm64_{platform_name}$', tag, re.M), tag
            extensions = [n for n in names if n.endswith('.so')]
            assert extensions, path
            checks = []
            for member in extensions:
                wheel.extract(member, tmp)
                binary = str(Path(tmp) / member)
                arch = output('lipo', '-archs', binary).strip()
                assert arch == 'arm64', (member, arch)
                commands = output('otool', '-l', binary)
                platforms = re.findall(r'^\s*platform (\d+)\s*$', commands, re.M)
                assert platforms and all(int(p) == expected_platform for p in platforms), commands
                minos = re.findall(r'^\s*minos (\S+)\s*$', commands, re.M)
                assert minos and all(m == '17.0' for m in minos), commands
                sdks = re.findall(r'^\s*sdk (\S+)\s*$', commands, re.M)
                links = output('otool', '-L', binary)
                assert 'Python.framework/Python' in links, links
                assert not re.search(r'lib(?:ssl|crypto|ffi)[.\-]|/opt/homebrew|/usr/local/', links), links
                checks.append({'extension': member, 'architecture': arch, 'platform': expected_platform, 'minos': minos, 'sdk': sdks, 'links': links})
            results.append({'wheel': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                            'name': name, 'version': version, 'checks': checks, 'runtime_tested': False})
    native = []
    if args.native_root:
        for relative in ('openssl-static/lib/libssl.a', 'openssl-static/lib/libcrypto.a', 'libffi-static/lib/libffi.a'):
            archive = args.native_root / relative
            commands = output('otool', '-l', str(archive))
            platforms = re.findall(r'^\s*platform (\d+)\s*$', commands, re.M)
            minos = re.findall(r'^\s*minos (\S+)\s*$', commands, re.M)
            sdks = re.findall(r'^\s*sdk (\S+)\s*$', commands, re.M)
            assert platforms and all(int(p) == expected_platform for p in platforms), relative
            assert minos and all(m == '17.0' for m in minos), (relative, sorted(set(minos)))
            native.append({'archive': str(archive), 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                           'platforms': sorted(set(platforms)), 'minos': sorted(set(minos)),
                           'sdks': sorted(set(sdks)), 'build_commands_checked': len(minos)})
    print(json.dumps({'wheels': results, 'native_libraries': native}, indent=2))


if __name__ == '__main__':
    main()
