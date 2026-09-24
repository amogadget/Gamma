#!/usr/bin/env python3
"""Build pinned cryptography/CFFI arm64 iOS wheels on a Mac, without Xcode projects.

Run with QA/build-tools/bin/python. All work is isolated in QA/crypto-work.
The host environment needs maturin==1.15.0, setuptools==84.0.0, wheel==0.48.0,
cffi==2.1.1. Target artifacts never use host OpenSSL or libffi.
"""
import argparse
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile
import urllib.request

SOURCES = json.loads(Path(__file__).with_name('ios-crypto-sources.json').read_text())
BUILD_TOOLS = {'maturin': '1.15.0', 'setuptools': '84.0.0', 'wheel': '0.48.0', 'cffi': '2.1.1', 'pycparser': '3.0'}
PATCHES = ['cryptography-cffi/build.rs: apply clang_rt.osx workaround only to apple-darwin, not iOS']
MIN_IOS = '17.0'  # Match Gamma's supported deployment floor before compiling/tagging.


def run(args, cwd, env):
    print('+', shlex.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)


def source(name, root, cache):
    spec = SOURCES[name]
    archive = cache / spec['url'].rsplit('/', 1)[1]
    if not archive.exists():
        with urllib.request.urlopen(spec['url']) as response:
            archive.write_bytes(response.read())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != spec['sha256']:
        raise RuntimeError(f'SHA256 mismatch: {archive}')
    dest = root / f"{name}-{spec['version']}"
    if not dest.exists():
        with tarfile.open(archive) as tar:
            tar.extractall(root, filter='data')
    return dest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--qa-root', type=Path, required=True)
    parser.add_argument('--target', choices=['simulator', 'device'], required=True)
    parser.add_argument('--jobs', type=int, default=6)
    parser.add_argument('--only', choices=['all', 'openssl', 'cryptography', 'cffi'], default='all')
    args = parser.parse_args()
    qa = args.qa_root.resolve()
    for package, expected in BUILD_TOOLS.items():
        if version(package) != expected:
            raise RuntimeError(f'Host build tool {package} must be {expected}, got {version(package)}')
    sim = args.target == 'simulator'
    sdkname = 'iphonesimulator' if sim else 'iphoneos'
    triple = 'aarch64-apple-ios-sim' if sim else 'aarch64-apple-ios'
    clang_target = f'arm64-apple-ios{MIN_IOS}-simulator' if sim else f'arm64-apple-ios{MIN_IOS}'
    slice_name = 'ios-arm64_x86_64-simulator' if sim else 'ios-arm64'
    framework = qa / 'python-ios/Python.xcframework' / slice_name
    root = qa / 'crypto-work' / f'{args.target}-ios{MIN_IOS}'
    cache = qa / 'crypto-work/downloads'
    wheels = root / 'wheels'
    for path in (root, cache, wheels):
        path.mkdir(parents=True, exist_ok=True)
    sdk = subprocess.check_output(['xcrun', '--sdk', sdkname, '--show-sdk-path'], text=True).strip()
    clang = subprocess.check_output(['xcrun', '--sdk', sdkname, '--find', 'clang'], text=True).strip()
    flags = f'-target {clang_target} -isysroot {sdk} -O2 -fPIC'
    env = os.environ.copy()
    # Do not inherit the parent's cross compilation or package discovery settings.
    for key in list(env):
        if key.startswith(('PYO3_', 'OPENSSL_', 'CARGO_TARGET_', 'PKG_CONFIG')) or key in ('RUSTFLAGS', 'PYTHONPATH', 'CFLAGS', 'LDFLAGS', 'CPPFLAGS', 'SDKROOT'):
            env.pop(key)
    env.update(PATH=f'{qa}/toolchains/cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin',
               CARGO_HOME=str(qa / 'toolchains/cargo'), RUSTUP_HOME=str(qa / 'toolchains/rustup'),
               CARGO_TARGET_DIR=str(root / 'rust-target'), IPHONEOS_DEPLOYMENT_TARGET=MIN_IOS,
               SDKROOT=sdk, CC=clang, CFLAGS=flags, AR='/usr/bin/ar', RANLIB='/usr/bin/ranlib')
    rustc = subprocess.check_output(['rustc', '--version'], env=env, text=True).strip()
    if not rustc.startswith('rustc 1.98.1 '):
        raise RuntimeError(f'This recipe pins rustc 1.98.1, got {rustc}')
    tools = {'python': sys.version, 'rustc': rustc, 'packages': BUILD_TOOLS,
             'clang': subprocess.check_output([clang, '--version'], text=True).strip()}
    openssl = root / 'openssl-static'
    if args.only in ('all', 'openssl') and not (openssl / 'lib/libssl.a').exists():
        src = source('openssl', root, cache)
        config = 'iossimulator-xcrun' if sim else 'ios64-xcrun'
        run(['perl', 'Configure', config, 'no-shared', 'no-tests', 'no-module',
             f'--prefix={openssl}', '--libdir=lib'], src, env)
        run(['make', f'-j{args.jobs}'], src, env)
        run(['make', 'install_sw'], src, env)
    if args.only in ('all', 'cryptography'):
        src = source('cryptography', root, cache)
        # Upstream 50.0.1 incorrectly selects the macOS compiler runtime for
        # *all* Apple targets. iOS clang selects its own platform runtime.
        build_rs = src / 'src/rust/cryptography-cffi/build.rs'
        original = 'if target.contains("apple") && openssl_static {'
        patched = 'if target.ends_with("apple-darwin") && openssl_static {'
        text = build_rs.read_text()
        if original in text:
            assert text.count(original) == 1
            build_rs.write_text(text.replace(original, patched))
        elif patched not in text:
            raise RuntimeError('Unexpected cryptography compiler-runtime build script')
        config = root / 'pyo3.conf'
        config.write_text('implementation=CPython\nversion=3.13\nshared=true\nabi3=false\npointer_width=64\n'
                          f'ext_suffix=.cpython-313-{sdkname}.so\nsuppress_build_script_link_lines=true\n')
        cryptoenv = dict(env, PYO3_CONFIG_FILE=str(config), OPENSSL_DIR=str(openssl), OPENSSL_STATIC='1',
                         OPENSSL_NO_VENDOR='1', RUSTFLAGS=f'-L framework={framework} -l framework=Python',
                         PYO3_PYTHON=sys.executable, PYTHON_SYS_EXECUTABLE=sys.executable)
        run([sys.executable, '-m', 'maturin', 'build', '--release', '--locked', '--target', triple,
             '--out', wheels, '-i', sys.executable], src, cryptoenv)
    if args.only in ('all', 'cffi'):
        ffi = root / 'libffi-static'
        if not (ffi / 'lib/libffi.a').exists():
            src = source('libffi', root, cache)
            run([src / 'configure', '--host=aarch64-apple-darwin', '--disable-shared', '--enable-static',
                 '--disable-docs', f'--prefix={ffi}'], src, env)
            run(['make', f'-j{args.jobs}'], src, env)
            run(['make', 'install'], src, env)
        src = source('cffi', root, cache)
        # The BeeWare-generated simulator sysconfig has framework paths and iOS ABI
        # semantics. Derive a separate device copy; never mutate the parent crossenv.
        crosssite = qa / 'cross-sim/lib/python3.13/site-packages'
        cross = root / 'cross-config'
        cross.mkdir(exist_ok=True)
        for filename in ('_cross_arm64_iphonesimulator.py', '_sysconfigdata__ios_arm64-iphonesimulator.py'):
            text = (crosssite / filename).read_text().replace('13.0', MIN_IOS)
            if not sim:
                text = text.replace('ios-arm64_x86_64-simulator', 'ios-arm64').replace('iphonesimulator', 'iphoneos')
                text = text.replace('arm64-apple-ios-simulator', 'arm64-apple-ios').replace('mios-simulator-version-min', 'miphoneos-version-min')
                text = text.replace('platform.IOSVersionInfo(system, release, model, True)', 'platform.IOSVersionInfo(system, release, model, False)')
                filename = filename.replace('iphonesimulator', 'iphoneos')
            (cross / filename).write_text(text)
        wrapper = root / 'cffi-build.py'
        wrapper.write_text(f'import sys\nsys.path.insert(0, {str(cross)!r})\nimport _cross_arm64_{sdkname}\n'
                           f'import runpy\nrunpy.run_path({str(src / "setup.py")!r}, run_name="__main__")\n')
        cenv = dict(env, PKG_CONFIG='/usr/bin/false', CFLAGS=f'{flags} -I{ffi}/include',
                    LDFLAGS=f'-L{ffi}/lib -F{framework} -framework Python',
                    LDSHARED=f'{clang} {flags} -dynamiclib -F{framework} -framework Python',
                    CFFI_FORCE_STATIC=str(ffi / 'lib/libffi.a'))
        run([sys.executable, wrapper, 'bdist_wheel', '--dist-dir', wheels], src, cenv)
    artifacts = []
    for wheel in sorted(wheels.glob('*.whl')):
        artifacts.append({'file': wheel.name, 'sha256': hashlib.sha256(wheel.read_bytes()).hexdigest()})
    (root / 'build-manifest.json').write_text(json.dumps({'target': triple, 'sdk': sdk, 'sources': SOURCES,
        'build_tools': tools, 'patches': PATCHES, 'minimum_ios': MIN_IOS,
        'wheels': artifacts, 'runtime_tested': False}, indent=2) + '\n')
    print(json.dumps(artifacts, indent=2))


if __name__ == '__main__':
    main()
