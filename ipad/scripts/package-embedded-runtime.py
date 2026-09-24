#!/usr/bin/env python3
"""Offline Xcode resource phase. See PACKAGE_EMBEDDED_RUNTIME.md for lock/API.

No pip, network, cross compilation, Python.framework embedding or user-data writes.
"""
from __future__ import annotations

import email.parser
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

MINIMUM = (17, 0, 0)
NATIVE = {"pydantic-core", "bcrypt", "rpds-py", "cryptography", "cffi"}


def load_helper():
    spec = importlib.util.spec_from_file_location("gamma_ios_wheel_builder", Path(__file__).with_name("build-ios-python-wheels.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def safe_relative(name):
    path = PurePosixPath(name)
    if not name or "\\" in name or path.is_absolute() or any(p in ("..", ".", "") for p in name.rstrip("/").split("/")) or ":" in name:
        raise ValueError(f"Unsafe relative path: {name!r}")
    return path


def excluded(path):
    return any(p.lower() in {"__pycache__", "claude.md", "local.md", ".git", ".env"} or p.lower().endswith((".pyc", ".pyo", ".key", ".p12", ".p8")) for p in path.parts)


def macho(data, platform):
    load_helper().validate_macho(data, platform)
    offset = 32
    for _ in range(struct.unpack_from("<I", data, 16)[0]):
        cmd, size = struct.unpack_from("<II", data, offset)
        if cmd == 0x32:
            value = struct.unpack_from("<I", data, offset + 12)[0]
            minimum = (value >> 16, (value >> 8) & 255, value & 255)
            if minimum > MINIMUM:
                raise ValueError(f"Mach-O minimum {minimum} exceeds app minimum {MINIMUM}")
        offset += size


def validate_tag(tag, target, native):
    parts = tag.split("-")
    if len(parts) != 3:
        raise ValueError(f"Invalid wheel tag: {tag}")
    python, abi, platform = parts
    if not native:
        if platform != "any" or abi != "none" or not set(python.split(".")) & {"py3", "py313", "cp313"}:
            raise ValueError(f"Not a Python 3 pure wheel: {tag}")
        return
    match = re.fullmatch(r"ios_(\d+)_(\d+)_arm64_(iphoneos|iphonesimulator)", platform)
    if not match or match[3] != ("iphoneos" if target == "device" else "iphonesimulator"):
        raise ValueError(f"Wrong native wheel target: {tag}")
    if (int(match[1]), int(match[2]), 0) > MINIMUM:
        raise ValueError(f"Wheel minimum exceeds app minimum: {tag}")
    if not (python == "cp313" and abi == "cp313" or abi == "abi3" and re.fullmatch(r"cp3\d+", python) and int(python[3:]) <= 13):
        raise ValueError(f"Wrong Python ABI: {tag}")


def wheel_payload(path, record, target, native):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != record["sha256"]:
        raise ValueError(f"Wheel SHA256 mismatch: {path.name}")
    result = {}
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            relative = safe_relative(member.filename)
            if stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError(f"Wheel symlink: {member.filename}")
            if member.is_dir():
                continue
            if excluded(relative):
                continue
            # Setuptools' universal wheel carries Windows console launchers as
            # package data. iOS never invokes them; do not ship foreign executables.
            if canonical(record["name"]) == "setuptools" and relative.parts[0] == "setuptools" and relative.suffix == ".exe":
                continue
            parts = relative.parts
            if parts[0].endswith(".data"):
                if len(parts) < 3 or parts[1] not in {"purelib", "platlib"}:
                    raise ValueError(f"Unsupported wheel install scheme: {relative}")
                relative = PurePosixPath(*parts[2:])
            if relative in result:
                raise ValueError(f"Colliding wheel member: {relative}")
            payload = archive.read(member)
            if relative.suffix == ".so":
                if not native or relative.name.startswith("_gamma_ios_pdf."):
                    raise ValueError(f"Unexpected native payload: {relative}")
                macho(payload, 2 if target == "device" else 7)
            elif relative.suffix in {".dylib", ".a", ".dll", ".exe"} or payload[:4] in {b"\xcf\xfa\xed\xfe", b"\x7fELF", b"\xca\xfe\xba\xbe"}:
                raise ValueError(f"Unmanaged native payload: {relative}")
            result[relative] = payload
    metadata = [value for key, value in result.items() if len(key.parts) == 2 and str(key).endswith(".dist-info/METADATA")]
    wheels = [value for key, value in result.items() if len(key.parts) == 2 and str(key).endswith(".dist-info/WHEEL")]
    if len(metadata) != 1 or len(wheels) != 1:
        raise ValueError(f"Expected one distribution metadata: {path}")
    parsed = email.parser.BytesParser().parsebytes(metadata[0])
    if canonical(parsed["Name"]) != canonical(record["name"]) or parsed["Version"] != record["version"]:
        raise ValueError(f"Locked package/version mismatch: {path}")
    tags = email.parser.BytesParser().parsebytes(wheels[0]).get_all("Tag", [])
    if not tags:
        raise ValueError(f"Missing wheel tags: {path}")
    for tag in tags:
        validate_tag(tag, target, native)
    if native and not any(p.suffix == ".so" for p in result):
        raise ValueError(f"Native wheel has no extension: {path}")
    return result, parsed


def check_dependencies(metadata):
    # Build-host tool only; never installed into the embedded interpreter.
    from packaging.markers import default_environment
    from packaging.requirements import Requirement
    env = default_environment()
    env.update(sys_platform="ios", platform_system="iOS", platform_machine="arm64", python_version="3.13", python_full_version="3.13.0", implementation_name="cpython", extra="")
    versions = {canonical(m["Name"]): m["Version"] for m in metadata}
    for item in metadata:
        for text in item.get_all("Requires-Dist", []):
            req = Requirement(text)
            if req.marker and not req.marker.evaluate(env):
                continue
            version = versions.get(canonical(req.name))
            if version is None or not req.specifier.contains(version, prereleases=True):
                raise ValueError(f"Missing/incompatible dependency of {item['Name']}: {text}")


def lock_records(lock, target):
    """Normalize the production flat closure lock and the original grouped form.

    An unfinished native record is an error, never permission to search for a
    wheel or silently omit a dependency. Only the selected target is required.
    """
    if isinstance(lock, list):
        records = []
        for entry in lock:
            if not isinstance(entry, dict) or type(entry.get("native")) is not bool:
                raise ValueError("Closure records require a boolean native field")
            if entry["native"]:
                wheel = entry.get("wheels", {}).get(target)
                if not isinstance(wheel, dict):
                    raise ValueError(f"Missing locked {target} wheel for {entry.get('name')}")
                record = {"name": entry["name"], "version": entry["version"],
                          "filename": wheel.get("filename"), "sha256": wheel.get("sha256")}
                records.append((target, record))
            else:
                records.append(("pure", entry))
    elif isinstance(lock, dict):
        records = [("pure", r) for r in lock["pure"]] + [(target, r) for r in lock["native"][target]]
    else:
        raise ValueError("Closure lock must be a record list or grouped object")
    for _, record in records:
        if not all(isinstance(record.get(key), str) and record[key] for key in ("name", "version", "filename", "sha256")):
            raise ValueError("Every selected wheel requires name, version, filename and sha256")
        if not re.fullmatch(r"[0-9a-f]{64}", record["sha256"]):
            raise ValueError(f"Invalid SHA256 for {record['name']}")
    return records


def closure(wheelhouse, lock, target):
    records = lock_records(lock, target)
    names, files, metadata = set(), {}, []
    for directory, record in records:
        name = canonical(record["name"])
        if name in names:
            raise ValueError(f"Duplicate distribution: {name}")
        names.add(name)
        filename = str(safe_relative(record["filename"]))
        if "/" in filename or not filename.endswith(".whl"):
            raise ValueError("Lock filename must be a wheel basename")
        payload, meta = wheel_payload(wheelhouse / directory / filename, record, target, directory != "pure")
        metadata.append(meta)
        for relative, data in payload.items():
            if str(relative).casefold() in files:
                raise ValueError(f"Colliding distributions: {relative}")
            files[str(relative).casefold()] = (relative, data)
    native_names = {canonical(r["name"]) for directory, r in records if directory != "pure"}
    if not NATIVE <= native_names:
        raise ValueError(f"Missing required native distributions: {sorted(NATIVE - native_names)}")
    check_dependencies(metadata)
    return [files[key] for key in sorted(files)]


def guard_output(target, app, resource):
    target, app, resource = target.resolve(), app.resolve(), resource.resolve()
    if app == target or target not in app.parents or app.suffix != ".app" or resource != app / "EmbeddedGamma":
        raise ValueError("Output must be TARGET_BUILD_DIR/<app>.app/EmbeddedGamma")
    return app, resource


def module_name(relative):
    parts = list(relative.parts)
    parts[-1] = parts[-1].split(".")[0]
    if not all(re.fullmatch(r"[A-Za-z_]\w*", part, re.ASCII) for part in parts):
        raise ValueError(f"Invalid extension module path: {relative}")
    return ".".join(parts)


def extension_plan(roots):
    result, seen = [], set()
    for root in roots:
        for path in sorted(root.rglob("*.so")):
            relative = path.relative_to(root)
            if relative.parts[0] == "lib-dynload":
                relative = Path(*relative.parts[1:])
            module = module_name(relative)
            if module.casefold() in seen or module == "Python" or module.startswith("_gamma_ios_pdf"):
                raise ValueError(f"Colliding/forbidden native module: {module}")
            seen.add(module.casefold())
            result.append((path, module))
    return result


def copy_tree(source, destination, select=lambda p: True):
    if not source.is_dir():
        raise ValueError(f"Missing input directory: {source}")
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if excluded(relative) or (path.name.startswith("libpython") and path.name.endswith(".dylib")):
            continue
        if path.is_symlink():
            raise ValueError(f"Input symlink is not permitted: {path}")
        if path.is_file() and select(relative):
            output = destination / relative
            if output.exists():
                raise ValueError(f"Overlapping input trees: {output}")
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, output)


def cjk_font_payload(source):
    """Require the externally supplied Docker font and its legal notices."""
    font = source / "DroidSansFallbackFull.ttf"
    if font.is_symlink() or not font.is_file():
        raise ValueError(f"Required CJK font missing: {font}")
    data = font.read_bytes()
    if len(data) < 12 or data[:4] != b"\x00\x01\x00\x00":
        raise ValueError("DroidSansFallbackFull.ttf is not a TrueType font")
    tables = struct.unpack_from(">H", data, 4)[0]
    if not tables or len(data) < 12 + tables * 16:
        raise ValueError("CJK font has an invalid TrueType table directory")
    files = [(font.name, data)]
    legal = False
    for item in sorted(source.iterdir()):
        name = item.name.upper()
        is_license = name.startswith(("LICENSE", "COPYING", "COPYRIGHT", "OFL", "APACHE"))
        if not is_license and not name.startswith("NOTICE"):
            continue
        if item.is_symlink() or not item.is_file() or excluded(Path(item.name)):
            raise ValueError(f"Unsafe CJK font license input: {item}")
        notice = item.read_bytes()
        if not notice.strip():
            raise ValueError(f"Empty CJK font license/notice: {item}")
        files.append((item.name, notice))
        legal |= is_license
    if not legal:
        raise ValueError("CJK font requires its license/copyright file (NOTICE alone is insufficient)")
    return files


def run(*args):
    return subprocess.check_output(list(map(str, args)), text=True)


def dependencies(binary, allowed):
    output = run("xcrun", "otool", "-L", binary)
    expected_id = f"@rpath/{binary.parent.name}/{binary.name}"
    for line in output.splitlines()[1:]:
        dep = line.strip().split(" (", 1)[0]
        if dep == expected_id or dep.startswith(("/usr/lib/", "/System/Library/Frameworks/")) or dep in allowed:
            continue
        raise ValueError(f"Unshippable dylib dependency in {binary.name}: {dep}")
    load_commands = run("xcrun", "otool", "-l", binary)
    for value in re.findall(r"\bpath (.*?) \(offset \d+\)", load_commands):
        if value not in {"@loader_path", "@executable_path/Frameworks", "@loader_path/.."}:
            raise ValueError(f"Unshippable LC_RPATH: {value}")


def main():
    env = os.environ
    def path(key):
        if not env.get(key):
            raise ValueError(f"Required environment: {key}")
        return Path(env[key]).resolve()
    app, resource = guard_output(path("TARGET_BUILD_DIR"), path("CODESIGNING_FOLDER_PATH"), path("GAMMA_EMBEDDED_RESOURCE_ROOT"))
    platform = env.get("PLATFORM_NAME")
    if platform not in {"iphoneos", "iphonesimulator"}:
        raise ValueError("Only arm64 iOS device/simulator packaging supported")
    if env.get("ARCHS", "arm64").split() != ["arm64"]:
        raise ValueError("Package one arm64 target, not a universal or host build")
    target = "device" if platform == "iphoneos" else "simulator"
    identity = env.get("EXPANDED_CODE_SIGN_IDENTITY", "")
    if not identity:
        if target == "simulator" and env.get("CODE_SIGNING_ALLOWED", "YES") == "YES":
            identity = "-"
        else:
            raise ValueError("Missing extension framework signing identity")
    if target == "device" and identity == "-":
        raise ValueError("Device frameworks require a real signing identity")
    wheelhouse = path("GAMMA_WHEELHOUSE")
    lock_path = Path(env.get("GAMMA_PYTHON_LOCK", wheelhouse.parent / "embedded-closure-lock.json"))
    lock = json.loads(lock_path.read_text())
    payload = closure(wheelhouse, lock, target)  # Validate ALL hashes before copying.
    framework = path("GAMMA_PYTHON_XCFRAMEWORK")
    selected = load_helper().select_slice(framework, target)
    split = selected / "lib-arm64"
    architecture_lib = split if split.is_dir() else selected / "lib"
    template = framework / "build/iOS-dylib-Info-template.plist"
    info_template = plistlib.loads(template.read_bytes())
    backend = path("GAMMA_BACKEND_SOURCE")
    if (backend / "backend/gamma").is_dir():
        backend = backend / "backend"
    source = path("GAMMA_EMBEDDED_SOURCE_ROOT")
    cjk_files = cjk_font_payload(path("GAMMA_CJK_FONT_DIR"))
    frontend = path("GAMMA_FRONTEND_DIST")
    if not (frontend / "index.html").is_file():
        raise ValueError("Frontend dist lacks index.html")
    # No output deletion until all staging, binary validation and signing succeeds.
    app.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".gamma-package-", dir=app.parent) as temporary:
        stage = Path(temporary)
        root = stage / "EmbeddedGamma"
        common = framework / "lib"
        if common.is_dir():
            copy_tree(common, root / "python/lib")
        elif (framework / "libcommon").is_dir():
            copy_tree(framework / "libcommon", root / "python/lib")
        copy_tree(architecture_lib, root / "python/lib")
        stdlib = root / "python/lib/python3.13"
        if not (stdlib / "encodings/__init__.py").is_file() or not (stdlib / "lib-dynload").is_dir():
            raise ValueError("Unsupported BeeWare stdlib layout")
        copy_tree(backend / "gamma", root / "app/gamma", lambda p: p.suffix == ".py" or p.name == "mcp_icon.png" or "fonts" in p.parts or p.suffix == ".resource")
        fonts = root / "app/gamma/resources/fonts"
        fonts.mkdir(parents=True, exist_ok=True)
        for name, data in cjk_files:
            destination = fonts / name
            if destination.exists() and destination.read_bytes() != data:
                raise ValueError(f"Conflicting bundled CJK font resource: {name}")
            destination.write_bytes(data)
        for name in ("gamma_ios_runtime.py", "gamma_ios_pdf.py"):
            shutil.copyfile(source / name, root / "app" / name)
        copy_tree(frontend, root / "frontend")
        packages = root / "app_packages"
        for relative, data in payload:
            dest = packages / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
        licenses = root / "licenses"
        licenses.mkdir()
        for base, prefix in ((backend.parent, "gamma"), (framework, "python")):
            for item in sorted(base.iterdir()):
                if item.is_file() and item.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")):
                    shutil.copyfile(item, licenses / (prefix + "-" + item.name))
        # Forward the vendor declaration; do not invent required-reason claims.
        privacy = selected / "Python.framework/PrivacyInfo.xcprivacy"
        if privacy.is_file():
            shutil.copyfile(privacy, root / "Python-PrivacyInfo.xcprivacy")
        else:
            # CPython support 3.13-b15 contains no vendor privacy manifest.
            # Do not invent one or claim vendor coverage: the app's declarations
            # must cover its own actual required-reason API uses before release.
            print("Python support has no vendor privacy manifest; application privacy review remains required.")
        plan = extension_plan([stdlib, packages])
        allowed = {"@rpath/Python.framework/Python"} | {f"@rpath/{name}.framework/{name}" for _, name in plan}
        generated = []
        for extension, module in plan:
            macho(extension.read_bytes(), 2 if target == "device" else 7)
            directory = stage / "Frameworks" / (module + ".framework")
            directory.mkdir(parents=True)
            binary = directory / module
            shutil.move(extension, binary)
            binary.chmod(0o755)
            info = dict(info_template)
            info.update(CFBundleExecutable=module, CFBundleIdentifier="com.gamma.python." + module.replace("_", "-"), CFBundleName=module, CFBundlePackageType="FMWK", CFBundleVersion="1", CFBundleShortVersionString="1.0", MinimumOSVersion="17.0", CFBundleSupportedPlatforms=["iPhoneOS" if target == "device" else "iPhoneSimulator"])
            (directory / "Info.plist").write_bytes(plistlib.dumps(info, sort_keys=True))
            marker = extension.with_suffix(".fwork")
            marker.write_text(f"Frameworks/{directory.name}/{module}")
            (directory / (module + ".origin")).write_text(str(marker.relative_to(stage)))
            run("xcrun", "install_name_tool", "-id", f"@rpath/{directory.name}/{module}", binary)
            dependencies(binary, allowed)
            run("/usr/bin/codesign", "--force", "--sign", identity, "--timestamp=none", directory)
            generated.append(directory.name)
        # Reject stray native code in resources, including unrecognized stdlib payloads.
        for item in sorted(root.rglob("*")):
            if item.is_file():
                with item.open("rb") as handle:
                    magic = handle.read(4)
                if item.suffix in {".so", ".dylib", ".a", ".dll", ".exe"} or magic in {b"\xcf\xfa\xed\xfe", b"\x7fELF", b"\xca\xfe\xba\xbe"}:
                    raise ValueError(f"Loose native binary: {item.relative_to(root)}")
        manifest_name = "packaging-manifest.json"
        old = json.loads((resource / manifest_name).read_text()) if (resource / manifest_name).is_file() else {"frameworks": []}
        old_frameworks = old["frameworks"]
        for name in old_frameworks + generated:
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*\.framework", name) or name == "Python.framework":
                raise ValueError("Unsafe generated framework manifest")
            candidate = app / "Frameworks" / name
            if candidate.is_symlink() or (candidate.exists() and name not in old_frameworks):
                raise ValueError(f"Refusing to overwrite unowned framework: {candidate}")
        if (app / "Frameworks").is_symlink():
            raise ValueError("Frameworks output may not be a symlink")
        hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob("*")) if p.is_file()}
        (root / manifest_name).write_text(json.dumps({"schema": 1, "target": target, "lock_sha256": hashlib.sha256(lock_path.read_bytes()).hexdigest(), "frameworks": sorted(generated), "resources": hashes}, sort_keys=True, indent=2) + "\n")
        if resource.exists():
            if not (resource / manifest_name).is_file():
                raise ValueError("Refusing to replace unowned EmbeddedGamma directory")
            shutil.rmtree(resource)
        for name in old_frameworks:
            candidate = app / "Frameworks" / name
            if candidate.exists():
                shutil.rmtree(candidate)
        (app / "Frameworks").mkdir(exist_ok=True)
        shutil.move(root, resource)
        for name in generated:
            shutil.move(stage / "Frameworks" / name, app / "Frameworks" / name)
    print(f"Packaged {target} EmbeddedGamma with {len(generated)} signed extension frameworks")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as exc:
        sys.exit(f"EmbeddedGamma packaging failed: {exc}")
