# First embedded Python cross-build gate

This is a bounded **pydantic-core 2.46.2** build, not a complete Gamma dependency
installer. It builds Rust source for iOS, never downloads or retags a macOS wheel.
No Mac build has been performed by the implementation agent. The parent reports
successful real simulator compilation (job120): pydantic_core2.46.2, cp313,
ios_17_0_arm64_iphonesimulator, Rust1.98.1, host CPython3.13.15; wheel SHA256
`04f73f03e2266411cf0d40cb4f1f30c1230e2e4c00c80b405ada80b77c052249`.
Parent verified Mach-O CPU 0x0100000c and platform7. This is evidence for the
parent's successful build, not a promise that rebuilt wheel bytes are identical.
Runtime import remains pending; device compilation is not yet qualified.
Passing portable unit tests does not establish simulator/device import success.

## Inputs and tools

`ios-python-wheels.lock.json` pins the exact PyPI source URL/SHA256, Python minor,
BeeWare support revision, Rust toolchain, maturin version, and both target ABIs.
The exact source requires Rust >=1.88 and PyO3 0.28. Its committed Cargo.lock is
used with `--locked`. Do not silently downgrade Pydantic or replace its core.
The manifest is not a hash-locked complete tool/dependency closure: preserve the
external support archive's verified hash/provenance and host-tool installation
records alongside build outputs. The driver cannot authenticate an arbitrary
extracted XCFramework's release revision.

Use the parent's isolated QA workspace, currently
`/Users/zli/gamma-embedded-qa.yTO5LZ`. Do not install global Python/Homebrew/Rust.
Host Python 3.13 can be provisioned with uv's `UV_PYTHON_INSTALL_DIR` and
`UV_CACHE_DIR` inside that workspace. Extract the parent's verified
Python-3.13-iOS-support.b15.tar.gz and locate its Python.xcframework.

Prepare Rust with the official rustup installer and `--no-modify-path`, setting
`CARGO_HOME` and `RUSTUP_HOME` inside QA first. Then use the isolated rustup:

```sh
export QA=/Users/zli/gamma-embedded-qa.yTO5LZ
export CARGO_HOME="$QA/tools/cargo" RUSTUP_HOME="$QA/tools/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
rustup toolchain install 1.98.1 --profile minimal
rustup target add --toolchain 1.98.1 aarch64-apple-ios-sim aarch64-apple-ios
```

If the parent already installed Rust 1.98.1 under the `stable` toolchain alias,
pass `--rust-toolchain stable`; the driver still requires `rustc --version` to
match locked 1.98.1 exactly, so this does not permit a drifting compiler version.
For the parent's current setup, the host interpreter is
`$QA/toolchains/python/cpython-3.13.15-macos-aarch64-none/bin/python3.13`.

The build driver installs maturin 1.15.0 into its new private venv **before**
converting that venv into a BeeWare target environment. It does not need
cibuildwheel for this direct first gate. It requires a real macOS host Python
3.13 with venv/ensurepip, selected Xcode and installed SDK. Xcode27 compatibility
must be established by this build, not assumed from a source recipe.

## Run (parent owns Mac execution)

Set `HOST_PYTHON` to the absolute path of the parent's uv-managed Python 3.13;
set `FRAMEWORK` to the downloaded/extracted Python.xcframework and `REPO` to the
Mac source checkout. These are paths, not necessarily commands on PATH.

```sh
"$HOST_PYTHON" "$REPO/ipad/scripts/build-ios-python-wheels.py" \
  --framework "$FRAMEWORK" --work "$QA/core-sim-01" \
  --target simulator --cargo-home "$CARGO_HOME" --rustup-home "$RUSTUP_HOME"

# Only after simulator build/import qualification; separate output and ABI:
"$HOST_PYTHON" "$REPO/ipad/scripts/build-ios-python-wheels.py" \
  --framework "$FRAMEWORK" --work "$QA/core-device-01" \
  --target device --cargo-home "$CARGO_HOME" --rustup-home "$RUSTUP_HOME"
```

Each `--work` must be NEW: failures are preserved rather than overwritten.
The source archive is hash checked, safe extracted, and built with explicit
`maturin build --release --locked --target <Rust triple> --interpreter
<cross-venv Python>`. The framework slice is selected from Info.plist, never by
assuming a simulator directory name. The driver consumes
`platform-config/arm64-iphonesimulator` or `platform-config/arm64-iphoneos` and
uses its `make_cross_venv.py`; it rejects mismatched target sysconfig.
The parent's first real simulator build compiled Rust but failed linking because
PyO3 inferred `-lpython3.13` from target sysconfigdata. The recipe now writes an
explicit `PYO3_CONFIG_FILE` (`implementation=CPython`, `version=3.13`,
`shared=true`, `abi3=false`, `pointer_width=64`,
`ext_suffix=.cpython-313-iphonesimulator.so` (device: `.cpython-313-iphoneos.so`),
`suppress_build_script_link_lines=true`) and does NOT set
`PYO3_CROSS_LIB_DIR`. It uses Rust `-L framework=<selected slice> -l framework=Python`
via `CARGO_ENCODED_RUSTFLAGS` (safe even when paths contain spaces). This prevents
inferred Unix-libpython link directives; the target cross-venv still determines
maturin's iOS wheel tags. The driver reads `sysconfig.get_config_var('EXT_SUFFIX')`
from that target cross-environment, requires it to match the manifest's expected
platform suffix, and writes the **queried** value into the PyO3 config. Missing
or mismatched suffix fails early, rather than reproducing job119's maturin error.
The explicit config and queried suffix are recorded in build-record.json.
The parent has confirmed this framework-link/config approach compiles successfully;
runtime import remains pending. Deployment target, clang triples and expected
wheel tags now use iOS17.0 to match that real build. Rust remains exactly the
parent's tested1.98.1. A compiler wrapper forces the target SDK and clang triple.
Device and simulator never share Cargo output, sources, Python configuration or
wheel output. An unexpected wheel tag fails instead of being renamed.

Outputs: `build.log`, `build-record.json`, `wheelhouse/*.whl`, source/Cargo cache
and target cross-venv. The record includes SDK/Xcode/Rust/configuration and wheel
hash. Build failure exits nonzero; inspect `build.log` before changing anything.
Do not fall back to a different version or pretend a recipe failure is success.

Validation checks the exact cp313 iOS tag, internal WHEEL tag, thin ARM64 Mach-O
and LC_BUILD_VERSION platform (7 simulator, 2 device). This catches even a
macOS ARM64 binary falsely renamed with an iOS wheel filename. It deliberately
rejects fat binaries for this single-architecture gate. It does **not** check
all dynamic dependencies, runtime symbol binding, import or App Store signing.
Inspect `otool -L` on the resulting extension, then run the import test below.

## Simulator/device acceptance, not host import

Install the wheel payload plus a pinned compatible `typing_extensions` into
BeeWare testbed `app_packages`. Convert ALL extension `.so` files to signed
frameworks using CPython's official iOS build phase. Example:

- Original `app_packages/pydantic_core/_pydantic_core.<actual ABI suffix>.so`
- Framework binary `Frameworks/pydantic_core._pydantic_core.framework/pydantic_core._pydantic_core`
- Original filename with only `.so` changed to `.fwork`, containing that
  framework binary's bundle-relative path
- Framework's `pydantic_core._pydantic_core.origin` containing the original
  `.fwork` bundle-relative path

Derive the ABI suffix from the actual wheel, never guess it. Preserve `.py`,
`.dist-info` and package data. Link Python.xcframework, copy selected slice/lib
into `.app/python/lib`, convert stdlib extensions too. Include app_packages,
app, stdlib and lib-dynload in interpreter paths. Framework Info.plist must have
matching executable and valid bundle identifier; sign nested frameworks before
the final app. No simulator binary may enter the device IPA.

Within the actual simulator app (then signed device app), test:

```python
import pydantic_core
from pydantic_core import SchemaValidator, SchemaSerializer, core_schema
assert pydantic_core.__version__ == '2.46.2'
schema = core_schema.int_schema()
assert SchemaValidator(schema).validate_python('42') == 42
assert SchemaSerializer(schema).to_json(42) == b'42'
```

Then install exact Pydantic2.13.2 and its pure-Python dependency closure, test a
BaseModel validation/serialization, and finally boot real Gamma. Later native
build gates remain bcrypt5, cryptography50 (+target OpenSSL/CFFI), and resolved
rpds-py (MCP -> jsonschema). Existing older BeeWare crypto/bcrypt wheels are not
acceptable replacements. PDF provider is separate parent-owned work.

## Portable validation tests

```sh
python3 -m unittest discover -s ipad/scripts -p test_ios_python_wheels.py -v
```

Sources:
- https://github.com/beeware/Python-Apple-support/tree/3.13-b15
- https://github.com/beeware/Python-Apple-support/blob/3.13-b15/patch/Python/make_cross_venv.py
- https://docs.python.org/3.13/using/ios.html#adding-python-to-an-ios-project
- https://pypi.org/pypi/pydantic_core/2.46.2/json
