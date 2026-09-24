#!/usr/bin/env python3
"""Build exact bcrypt/rpds iOS sources in isolated QA/rust-extra; no app builds.

Usage: build-tools/bin/python build-ios-rust-deps.py --qa QA --package bcrypt
       --target simulator --run-id sim-01
A run directory must be new. Source edits, if ever necessary, must be recorded.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import struct
import sys
import tarfile
import urllib.request
import zipfile

LOCK = Path(__file__).with_name('ios-rust-deps.lock.json')
# Reuse read-only structural validation; do not modify the core build driver.
spec = importlib.util.spec_from_file_location('core_builder', Path(__file__).with_name('build-ios-python-wheels.py'))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_wheel(path, package, name, target):
    platform = 'ios_17_0_arm64_' + ('iphonesimulator' if target == 'simulator' else 'iphoneos')
    prefix = name.replace('-', '_') + '-' + package['version'] + '-'
    if not path.name.startswith(prefix) or not path.name.endswith('-' + platform + '.whl'):
        raise ValueError('Wrong package/version/platform wheel: ' + path.name)
    tag = path.name[len(prefix):-4]
    if tag not in ('cp313-cp313-' + platform, 'cp313-abi3-' + platform):
        raise ValueError('Unexpected Python ABI: ' + tag)
    with zipfile.ZipFile(path) as z:
        if any(n.startswith('/') or '..' in Path(n).parts for n in z.namelist()):
            raise ValueError('Unsafe wheel path')
        metadata = z.read(prefix[:-1] + '.dist-info/WHEEL').decode()
        if 'Tag: ' + tag not in metadata.splitlines():
            raise ValueError('Internal wheel tag mismatch')
        extensions = [n for n in z.namelist() if n.endswith(('.so', '.dylib'))]
        if len(extensions) != 1 or not extensions[0].startswith(package['extension'] + '.'):
            raise ValueError('Unexpected extensions: ' + str(extensions))
        data = z.read(extensions[0])
        core.validate_macho(data, 7 if target == 'simulator' else 2)
        offset = 32
        for _ in range(struct.unpack_from('<I', data, 16)[0]):
            command, size = struct.unpack_from('<II', data, offset)
            if command == 0x32 and struct.unpack_from('<I', data, offset + 12)[0] != 17 << 16:
                raise ValueError('Mach-O deployment floor differs from iOS17 wheel tag')
            offset += size
        return extensions[0]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--qa', type=Path, required=True)
    p.add_argument('--package', choices=('bcrypt', 'rpds-py'), required=True)
    p.add_argument('--target', choices=('simulator', 'device'), required=True)
    p.add_argument('--run-id', required=True)
    a = p.parse_args()
    if sys.platform != 'darwin' or sys.version_info[:2] != (3, 13):
        p.error('Requires isolated macOS Python 3.13')
    if not a.run_id or Path(a.run_id).name != a.run_id or a.run_id in ('.', '..'):
        p.error('run-id must be a directory basename')
    lock = json.loads(LOCK.read_text())
    pkg = lock['packages'][a.package]
    qa = a.qa.resolve()
    work = qa / 'rust-extra' / a.package / a.run_id
    work.mkdir(parents=True, exist_ok=False)
    env = os.environ.copy()
    for k in list(env):
        if k.startswith(('PYO3_', 'CARGO_', 'RUSTUP_')) or k in ('RUSTFLAGS', 'PYTHONPATH', 'PYTHONHOME', '_PYTHON_HOST_PLATFORM', 'MACOSX_DEPLOYMENT_TARGET'):
            del env[k]
    env.update(CARGO_HOME=str(qa / 'toolchains/cargo'), RUSTUP_HOME=str(qa / 'toolchains/rustup'), RUSTUP_TOOLCHAIN='stable')
    env['PATH'] = str(qa / 'toolchains/cargo/bin') + ':' + env.get('PATH', '')
    def run(cmd, cwd=None):
        print('+ ' + shlex.join(map(str, cmd)), flush=True)
        return subprocess.check_output(list(map(str, cmd)), env=env, cwd=cwd, text=True).strip()
    rust = run(['rustc', '--version'])
    if not rust.startswith('rustc ' + lock['rust'] + ' '):
        raise ValueError('Unpinned Rust: ' + rust)
    blob = urllib.request.urlopen(pkg['url'], timeout=90).read()
    if sha(blob) != pkg['sha256']:
        raise ValueError('Source hash mismatch')
    archive = work / (pkg['directory'] + '.tar.gz')
    archive.write_bytes(blob)
    with tarfile.open(archive) as t:
        for m in t.getmembers():
            if m.name.startswith('/') or '..' in Path(m.name).parts or not (m.isfile() or m.isdir()):
                raise ValueError('Unsafe archive member')
        t.extractall(work / 'sources', filter='data')
    source = work / 'sources' / pkg['directory']
    cargo_lock = source / Path(pkg['cargo']).parent / 'Cargo.lock'
    if not cargo_lock.is_file():
        raise ValueError('Missing committed Cargo.lock')
    framework = qa / 'python-ios/Python.xcframework'
    slice_path = core.select_slice(framework, a.target)
    multiarch = 'arm64-' + ('iphonesimulator' if a.target == 'simulator' else 'iphoneos')
    triple = 'aarch64-apple-ios' + ('-sim' if a.target == 'simulator' else '')
    sdkname = 'iphonesimulator' if a.target == 'simulator' else 'iphoneos'
    venv = work / 'cross-venv'
    run([sys.executable, '-m', 'venv', venv])
    python = venv / 'bin/python'
    run([python, '-m', 'pip', 'install', '--only-binary=:all:', *[name + '==' + version for name, version in lock['host_tools'].items()]])
    tools = json.loads(run([python, '-m', 'pip', 'list', '--format=json']))
    run([sys.executable, slice_path / 'platform-config' / multiarch / 'make_cross_venv.py', venv])
    actual = json.loads(run([python, '-c', 'import sys,sysconfig,json; print(json.dumps([sys.platform,sys.implementation._multiarch,sysconfig.get_config_var("EXT_SUFFIX")]))']))
    suffix = '.cpython-313-' + sdkname + '.so'
    if actual != ['ios', multiarch, suffix]:
        raise ValueError('Wrong target Python config: ' + str(actual))
    sdk = run(['xcrun', '--sdk', sdkname, '--show-sdk-path'])
    clang = run(['xcrun', '--sdk', sdkname, '--find', 'clang'])
    wrapper = work / 'clang'
    wrapper.write_text('#!/bin/sh\nexec ' + shlex.join([clang, '-target', 'arm64-apple-ios17.0' + ('-simulator' if a.target == 'simulator' else ''), '-isysroot', sdk]) + ' "$@"\n')
    wrapper.chmod(0o755)
    config = work / 'pyo3.conf'
    config.write_text('implementation=CPython\nversion=3.13\nshared=true\nabi3=' + str(pkg['abi3']).lower() + '\npointer_width=64\next_suffix=' + suffix + '\nsuppress_build_script_link_lines=true\n')
    env.update(PYO3_CONFIG_FILE=str(config), CARGO_ENCODED_RUSTFLAGS='\x1f'.join(['-L', 'framework=' + str(slice_path), '-l', 'framework=Python']), CARGO_TARGET_DIR=str(work / 'target'), CARGO_BUILD_TARGET=triple, SDKROOT=sdk, IPHONEOS_DEPLOYMENT_TARGET='17.0', CC=str(wrapper))
    env['CARGO_TARGET_' + triple.upper().replace('-', '_') + '_LINKER'] = str(wrapper)
    out = work / 'wheelhouse'
    out.mkdir()
    if a.package == 'rpds-py':
        cmd = [venv / 'bin/maturin', 'build', '--release', '--locked', '--target', triple, '--interpreter', python, '--out', out]
    else:
        env['SETUPTOOLS_RUST_CARGO_PROFILE'] = 'release'
        # Set platform BEFORE compilation; never rename a built wheel.
        env['_PYTHON_HOST_PLATFORM'] = 'ios-17.0-' + multiarch
        project = source / 'pyproject.toml'
        original = project.read_text()
        anchor = 'path = "src/_bcrypt/Cargo.toml"\n'
        if original.count(anchor) != 1:
            raise ValueError('Unexpected setuptools-rust configuration')
        project.write_text(original.replace(anchor, anchor + 'args = ["--locked"]\n'))
        cmd = [python, '-m', 'pip', 'wheel', '--no-deps', '--no-build-isolation', '--config-settings=--build-option=--plat-name=ios_17_0_' + multiarch.replace('-', '_'), '--wheel-dir', out, '.']
    patches = [] if a.package != 'bcrypt' else [{'file': 'pyproject.toml', 'change': 'Add args = ["--locked"] to setuptools-rust extension; no Rust/API changes', 'before_sha256': sha(original.encode()), 'after_sha256': sha(project.read_bytes())}]
    record = dict(package=a.package, version=pkg['version'], source=pkg, cargo_lock_sha256=sha(cargo_lock.read_bytes()), patches=patches, target=a.target, rust=rust, tools=tools, sdk=sdk, command=list(map(str, cmd)), environment={k:v for k,v in env.items() if k.startswith(('CARGO_', 'PYO3_', 'RUSTUP_')) or k in ('CC','SDKROOT','IPHONEOS_DEPLOYMENT_TARGET','_PYTHON_HOST_PLATFORM','SETUPTOOLS_RUST_CARGO_PROFILE')}, pyo3_config=config.read_text())
    record_path = work / 'build-record.json'
    record_path.write_text(json.dumps(record, indent=2) + '\n')
    with (work / 'build.log').open('w') as log:
        subprocess.run(list(map(str, cmd)), cwd=source, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    if sha(cargo_lock.read_bytes()) != record['cargo_lock_sha256']:
        raise ValueError('Cargo.lock changed during build')
    wheels = list(out.glob('*.whl'))
    if len(wheels) != 1:
        raise ValueError('Expected exactly one wheel')
    wheel = wheels[0]
    extension = validate_wheel(wheel, pkg, a.package, a.target)
    destination = qa / 'wheels' / a.target / wheel.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.read_bytes() != wheel.read_bytes():
        raise ValueError('Refusing to overwrite different published wheel')
    shutil.copy2(wheel, destination)
    record.update(wheel=str(destination), wheel_sha256=sha(wheel.read_bytes()), extension=extension, validation='ARM64 Mach-O platform and wheel tags verified; runtime import is parent-owned')
    record_path.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))


if __name__ == '__main__':
    main()
