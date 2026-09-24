# Exact bcrypt and rpds iOS wheels

`build-ios-rust-deps.py` builds **bcrypt 5.0.0** (setuptools-rust 1.13.0,
PyO3 0.26) and **rpds-py 2026.6.3** (maturin 1.15.0, PyO3 0.29).
`ios-rust-deps.lock.json` pins both verified PyPI sdists and host tool versions.
Rust must report exactly 1.98.1. This is not a fully hash-locked toolchain:
the already provisioned BeeWare Python 3.13 support archive and Xcode SDK
remain external inputs, and Python build-tool wheels are version-, not hash-pinned.
Cargo uses each sdist's committed Cargo.lock; changes to that lock fail validation.

## Actual build results

All four wheels were cross-compiled on the authorized `mymac-new` host, using
`/Users/zli/gamma-embedded-qa.yTO5LZ` (QA). They are published beneath
`QA/wheels/simulator` and `QA/wheels/device`. All are **cp313-cp313**;
bcrypt's internal PyO3 abi3 feature is retained, not changed to a guessed older
stable-ABI Python version. Its explicit config has `abi3=true, version=3.13`;
rpds uses `abi3=false, version=3.13`.

| Package | Target | Wheel SHA256 | Build record below `QA/rust-extra/` |
|---|---|---|---|
| bcrypt 5.0.0 | simulator | `7965b7758d75bdf79bf6846a7a7f187c16f88819fc7f9efd5622ee32cd230aa5` | `bcrypt/sim-03/build-record.json` |
| rpds-py 2026.6.3 | simulator | `00e22793d87f254f0c0bf78fda3ee7fb01d66bffffd096f560f898e39dd69e3a` | `rpds-py/sim-01/build-record.json` |
| bcrypt 5.0.0 | device | `c05a493ef4ed630b0d627ac906562519c992a0f57ec1f31d11aff1cfe9c193f1` | `bcrypt/device-02/build-record.json` |
| rpds-py 2026.6.3 | device | `9ba8b8ffa4b32f531e472a084161a5754e0cc1a9a1f6700ca55935674c2b1404` | `rpds-py/device-01/build-record.json` |

Filename platforms are `ios_17_0_arm64_iphonesimulator` and
`ios_17_0_arm64_iphoneos`. Native payloads were separately checked for thin
ARM64 CPU `0x0100000c`, LC_BUILD_VERSION platform **7 / 2**, deployment
**17.0.0**, SDK **27.0.0**, matching internal WHEEL tags. `otool -L` confirms
Python.framework, libiconv and libSystem dependencies, with no Unix
`libpython3.13`. rpds's LC_ID_DYLIB still has its build-path identifier (not a
loaded dependency); the parent's normal iOS extension-to-framework conversion
must set the framework install name before signing, as for pydantic-core.

These are compile/structure results, **not claims of simulator/device imports**.
The parent owns app/testbed integration, extension conversion/signing, actual
bcrypt hash/check and rpds data-structure smoke tests, and full Gamma startup.
No xcodebuild, testbed, crypto subtree, account, key, or Mac-global installation
was used by this builder.

## Reproduce

Copy the new driver and lock alongside a read-only copy of
`build-ios-python-wheels.py` (reused only for slice/Mach-O validation) into
`QA/rust-extra/scripts`. Existing core driver is not edited. Then:

```sh
QA=/Users/zli/gamma-embedded-qa.yTO5LZ
PY="$QA/build-tools/bin/python"
DRIVER="$QA/rust-extra/scripts/build-ios-rust-deps.py"
"$PY" "$DRIVER" --qa "$QA" --package bcrypt --target simulator --run-id sim-next
"$PY" "$DRIVER" --qa "$QA" --package rpds-py --target simulator --run-id sim-next
"$PY" "$DRIVER" --qa "$QA" --package bcrypt --target device --run-id device-next
"$PY" "$DRIVER" --qa "$QA" --package rpds-py --target device --run-id device-next
```

Run ids must be new. The script preserves failed builds and refuses to overwrite
a different already-published wheel; a reproduced wheel may have different ZIP
metadata/build-path bytes. Source archives, cross-venvs and Cargo targets are
isolated per package/run. CARGO_HOME/RUSTUP_HOME use the user's provisioned QA
`toolchains/cargo` and `toolchains/rustup`; nothing is globally installed.
Host tools are installed **before** BeeWare converts each private venv.
`PYO3_CROSS_LIB_DIR` is removed. An explicit per-package `PYO3_CONFIG_FILE`
suppresses inferred Unix library links; encoded Rust flags link the selected
Python.framework. Target clang forces SDK, architecture and iOS17 floor.

### Recorded build-only adjustment

Bcrypt's original pyproject receives `args = ["--locked"]` in its
setuptools-rust extension table, with pre/post SHA256 recorded. No Rust/PyO3
source patch or dependency downgrade was needed. Setuptools receives
`--config-settings=--build-option=--plat-name=ios_17_0_arm64_<platform>`
**during the source build**, not as post-build wheel retagging. BeeWare's target
sysconfig otherwise hardcodes iOS13 wheel metadata even with an iOS17 compiler
floor; `_PYTHON_HOST_PLATFORM` alone proved insufficient. Failed bcrypt
`sim-01`, `sim-02`, and `device-01` builds are preserved as evidence of this
metadata mismatch, not published. `sim-03` / `device-02` rebuilt from verified
source with correct build-time tags.

## Portable checks

```sh
python3 -m unittest discover -s ipad/scripts -p test_ios_rust_deps.py -v
```

Six tests cover exact versions, both targets/packages, wrong CPU/platform,
renamed host binaries, internal-tag/extension errors, truncated Mach-O and
mismatched deployment floor. Real binaries passed the same ARM64/platform
checks plus separate `otool` and minimum-OS inspection on the Mac.
