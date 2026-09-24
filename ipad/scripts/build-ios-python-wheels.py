#!/usr/bin/env python3
"""Cross-compile the locked pydantic-core source; never retag host wheels.

Run using an isolated macOS Python 3.13. See IOS_PYTHON_WHEELS.md.
This first gate intentionally does not claim to build all Gamma dependencies.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import struct
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

LOCK = Path(__file__).with_name("ios-python-wheels.lock.json")


def run(argv, *, env=None, cwd=None):
    print("+ " + shlex.join(map(str, argv)), flush=True)
    return subprocess.check_output(list(map(str, argv)), env=env, cwd=cwd, text=True).strip()


def select_slice(framework: Path, target: str):
    """Select by XCFramework metadata, not guessed slice directory names."""
    info = plistlib.loads((framework / "Info.plist").read_bytes())
    matches = []
    for lib in info["AvailableLibraries"]:
        simulator = lib.get("SupportedPlatformVariant") == "simulator"
        if (lib["SupportedPlatform"] == "ios" and "arm64" in lib["SupportedArchitectures"]
                and simulator == (target == "simulator")):
            matches.append(framework / lib["LibraryIdentifier"])
    if len(matches) != 1:
        raise ValueError(f"Expected one arm64 {target} slice; got {matches}")
    return matches[0]


def validate_macho(data: bytes, expected_platform: int):
    """Require thin arm64 Mach-O with explicit device/simulator build version.

CPU architecture alone cannot distinguish Apple Silicon macOS/simulator/device.
"""
    if len(data) < 32 or data[:4] != b"\xcf\xfa\xed\xfe":
        raise ValueError("Expected thin little-endian 64-bit Mach-O (no fat/ELF binary)")
    _, cpu, _, filetype, ncmds, sizeofcmds, _, _ = struct.unpack_from("<8I", data)
    if cpu != 0x0100000C or filetype not in (6, 8):
        raise ValueError("Expected arm64 Mach-O dylib or bundle")
    end, offset, platforms = 32 + sizeofcmds, 32, []
    if end > len(data):
        raise ValueError("Truncated Mach-O load commands")
    for _ in range(ncmds):
        if offset + 8 > end:
            raise ValueError("Truncated Mach-O command")
        cmd, size = struct.unpack_from("<2I", data, offset)
        if size < 8 or offset + size > end:
            raise ValueError("Invalid Mach-O command size")
        if cmd == 0x32:  # LC_BUILD_VERSION
            if size < 24:
                raise ValueError("Truncated LC_BUILD_VERSION")
            platforms.append(struct.unpack_from("<I", data, offset + 8)[0])
        offset += size
    if offset != end or platforms != [expected_platform]:
        raise ValueError(f"Wrong/missing Mach-O platform: {platforms}, expected {expected_platform}")


def validate_wheel(path: Path, lock: dict, target: str):
    pkg, spec = lock["package"], lock["targets"][target]
    expected = f"{pkg['name']}-{pkg['version']}-cp313-cp313-{spec['wheel_platform']}.whl"
    if path.name != expected:
        raise ValueError(f"Unexpected wheel tag: {path.name}; expected {expected}")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if any(n.startswith("/") or ".." in Path(n).parts for n in names):
            raise ValueError("Unsafe wheel member")
        metadata = archive.read(f"{pkg['name']}-{pkg['version']}.dist-info/WHEEL").decode()
        if f"Tag: cp313-cp313-{spec['wheel_platform']}" not in metadata.splitlines():
            raise ValueError("Wheel internal tags do not match target")
        binaries = [n for n in names if n.endswith((".so", ".dylib"))]
        if len(binaries) != 1 or not binaries[0].startswith("pydantic_core/_pydantic_core."):
            raise ValueError(f"Unexpected extension payload: {binaries}")
        validate_macho(archive.read(binaries[0]), spec["macho_platform"])
    return binaries[0]


def framework_link_settings(work: Path, slice_path: Path, python_version: str, extension_suffix: str):
    """Do not let PyO3 infer a nonexistent Unix libpython from sysconfigdata."""
    if (not isinstance(extension_suffix, str) or not extension_suffix.startswith(".cpython-313-")
            or not extension_suffix.endswith(".so") or "\n" in extension_suffix):
        raise ValueError(f"Missing/invalid target sysconfig EXT_SUFFIX: {extension_suffix!r}")
    config = work / "pyo3-framework-config.txt"
    config.write_text(
        "implementation=CPython\n"
        f"version={python_version}\n"
        "shared=true\n"
        "abi3=false\n"
        "pointer_width=64\n"
        f"ext_suffix={extension_suffix}\n"
        "suppress_build_script_link_lines=true\n"
    )
    return {
        "PYO3_CONFIG_FILE": str(config),
        "CARGO_ENCODED_RUSTFLAGS": "\x1f".join([
            "-L", "framework=" + str(slice_path), "-l", "framework=Python"
        ]),
    }


def download_source(work: Path, package: dict):
    archive = work / "downloads" / (package["source_directory"] + ".tar.gz")
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        with urllib.request.urlopen(package["source_url"], timeout=90) as response:
            data = response.read()
    else:
        data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != package["sha256"]:
        raise ValueError("Source SHA256 mismatch; refusing build")
    archive.write_bytes(data)
    source_parent = work / "sources"
    # Never reuse a modified/unverified source tree on another invocation.
    source_parent.mkdir()
    with tarfile.open(archive) as bundle:
        for member in bundle.getmembers():
            if (member.name.startswith("/") or ".." in Path(member.name).parts
                    or not (member.isfile() or member.isdir())):
                raise ValueError(f"Unsafe source member: {member.name}")
        bundle.extractall(source_parent, filter="data")
    source = source_parent / package["source_directory"]
    if not (source / "Cargo.lock").is_file():
        raise ValueError("Source lacks Cargo.lock; no unlocked Cargo dependency resolution allowed")
    return source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--framework", type=Path, required=True, help="Extracted Python.xcframework")
    parser.add_argument("--work", type=Path, required=True, help="NEW output directory inside QA workspace")
    parser.add_argument("--target", choices=("simulator", "device"), default="simulator")
    parser.add_argument("--cargo-home", type=Path, required=True)
    parser.add_argument("--rustup-home", type=Path, required=True)
    parser.add_argument("--rust-toolchain", help="Installed rustup toolchain name/alias; rustc must still match locked version")
    parser.add_argument("--validate-wheel", type=Path, help="Validate only; portable, no Mac build")
    args = parser.parse_args()
    lock = json.loads(LOCK.read_text())
    if args.validate_wheel:
        print(validate_wheel(args.validate_wheel, lock, args.target))
        return
    if sys.platform != "darwin" or sys.version_info[:2] != (3, 13):
        parser.error("Build requires macOS host Python 3.13; no host wheel fallback")
    work, framework = args.work.resolve(), args.framework.resolve()
    if work.exists():
        parser.error("--work must be new (preserve failed logs; choose another directory)")
    spec = lock["targets"][args.target]
    slice_path = select_slice(framework, args.target)
    config_path = slice_path / "platform-config" / spec["multiarch"]
    converter = config_path / "make_cross_venv.py"
    if not converter.is_file():
        raise ValueError(f"Missing BeeWare target configuration: {converter}")
    work.mkdir(parents=True)
    env = os.environ.copy()
    for key in tuple(env):
        if key.startswith(("PYO3_", "CARGO_BUILD_", "CARGO_TARGET_")) or key in (
                "PYTHONHOME", "PYTHONPATH", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS",
                "MACOSX_DEPLOYMENT_TARGET", "_PYTHON_HOST_PLATFORM"):
            del env[key]
    env.update(CARGO_HOME=str(args.cargo_home.resolve()), RUSTUP_HOME=str(args.rustup_home.resolve()),
               RUSTUP_TOOLCHAIN=args.rust_toolchain or lock["rust_toolchain"],
               PATH=str(args.cargo_home.resolve() / "bin") + os.pathsep + env.get("PATH", ""))
    rust_version = run([args.cargo_home.resolve() / "bin/rustc", "--version"], env=env)
    if not rust_version.startswith("rustc " + lock["rust_toolchain"] + " "):
        raise ValueError(f"Wrong Rust version: {rust_version}")
    installed = run([args.cargo_home.resolve() / "bin/rustup", "target", "list", "--installed"], env=env)
    if spec["rust"] not in installed.splitlines():
        raise ValueError(f"Install target {spec['rust']} into isolated Rust toolchain first")
    source = download_source(work, lock["package"])
    venv = work / "cross-venv"
    run([sys.executable, "-m", "venv", venv], env=env)
    python = venv / "bin/python3"
    # Install host build backend BEFORE converting Python into cross mode.
    run([python, "-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:",
         "maturin==" + lock["maturin"]], env=env)
    run([sys.executable, converter, venv], env=env)
    check = "import json,sys,sysconfig; print(json.dumps([sys.platform,sys.implementation._multiarch,sysconfig.get_platform(),sysconfig.get_config_var('EXT_SUFFIX')]))"
    actual = json.loads(run([python, "-c", check], env=env))
    # Support-package sysconfig may report its own lower deployment floor.
    # The requested build floor is set explicitly below and checked in wheel tags.
    if (actual[:2] != ["ios", spec["multiarch"]]
            or not actual[2].startswith("ios-")
            or not actual[2].endswith("-" + spec["multiarch"])
            or actual[3] != spec["extension_suffix"]):
        raise ValueError(f"Unexpected target Python configuration: {actual}")
    sdk = run(["xcrun", "--sdk", spec["sdk"], "--show-sdk-path"], env=env)
    clang = run(["xcrun", "--sdk", spec["sdk"], "--find", "clang"], env=env)
    # A wrapper avoids spaces in compiler executable paths and forces SDK/ABI.
    wrapper = work / "target-clang"
    wrapper.write_text("#!/bin/sh\nexec " + shlex.join([clang, "-target", spec["clang"], "-isysroot", sdk]) + ' "$@"\n')
    wrapper.chmod(0o755)
    target_key = spec["rust"].replace("-", "_").upper()
    env.update(SDKROOT=sdk, IPHONEOS_DEPLOYMENT_TARGET=lock["deployment_target"],
               CARGO_TARGET_DIR=str(work / "cargo-target"),
               CC=str(wrapper), **{f"CARGO_TARGET_{target_key}_LINKER": str(wrapper)})
    # Real simulator build reached linking, but PyO3's sysconfig inference added
    # -lpython3.13. BeeWare supplies Python.framework, not that Unix library.
    # Explicit config suppresses inferred link lines; Rust links the framework.
    # Keep the cross-venv for maturin's wheel tags, not PyO3 library discovery.
    env.update(framework_link_settings(work, slice_path, lock["python"], actual[3]))
    out = work / "wheelhouse"
    out.mkdir()
    command = [venv / "bin/maturin", "build", "--release", "--locked", "--target", spec["rust"],
               "--interpreter", python, "--out", out]
    record = {"lock": lock, "target": args.target, "framework": str(framework),
              "slice": str(slice_path), "target_python": actual, "rust_version": rust_version,
              "xcode": run(["xcodebuild", "-version"], env=env), "sdk": sdk,
              "command": list(map(str, command)),
              "pyo3_config": Path(env["PYO3_CONFIG_FILE"]).read_text(),
              "environment": {k: v for k, v in env.items() if k.startswith(("PYO3_", "CARGO_", "RUSTUP_")) or k in ("SDKROOT", "CC", "IPHONEOS_DEPLOYMENT_TARGET")}}
    (work / "build-record.json").write_text(json.dumps(record, indent=2) + "\n")
    print("+ " + shlex.join(map(str, command)), flush=True)
    with (work / "build.log").open("w") as log:
        subprocess.run(list(map(str, command)), cwd=source, env=env, stdout=log,
                       stderr=subprocess.STDOUT, check=True)
    wheels = list(out.glob("*.whl"))
    if len(wheels) != 1:
        raise ValueError(f"Expected exactly one built wheel, got {wheels}")
    member = validate_wheel(wheels[0], lock, args.target)
    record.update(wheel=str(wheels[0]), wheel_sha256=hashlib.sha256(wheels[0].read_bytes()).hexdigest(),
                  extension=member, validation="wheel tag + arm64 Mach-O platform only; NOT simulator/device import tested")
    (work / "build-record.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()
