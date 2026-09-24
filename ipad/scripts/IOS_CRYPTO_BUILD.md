# Embedded iOS crypto wheels

`build-ios-crypto.py` builds the real cryptography **50.0.1** and CFFI
**2.1.1** extensions for CPython 3.13, arm64 iOS simulator and device.
It is independent of the core-driver script and does not run an Xcode project,
simulator, signing operation, Apple account operation, or application test.

## Inputs and isolation

- `ios-crypto-sources.json` pins URLs and SHA256 for the PyPI sdists and official
  OpenSSL 3.0.22 / libffi 3.4.7 sources. Hashes are checked before extraction.
  OpenSSL matches the BeeWare 3.13.15 b15 framework's `VERSIONS` file.
- Both C dependencies are compiled **statically for the target SDK**. No brew
  headers/libraries or macOS OpenSSL/libffi are used in target extensions.
- Host build tools: CPython 3.13.15, maturin 1.15.0, setuptools 84.0.0,
  wheel 0.48.0, cffi 2.1.1, pycparser 3.0. The recipe checks package versions
  and Rust 1.98.1. The tested SDK is Xcode iOS SDK 27.0 / Apple clang 21.0.0;
  compiler paths and versions are recorded in each generated build manifest.
- The supplied QA root must contain `build-tools/bin/python`,
  `toolchains/{cargo,rustup}`, `python-ios/Python.xcframework`, and the
  BeeWare `cross-sim/lib/python3.13/site-packages` cross configuration.
  Framework slices must be `ios-arm64_x86_64-simulator` and `ios-arm64`.
- Native build outputs and Cargo target directories are isolated under
  `QA/crypto-work/{simulator,device}-ios17.0`; the shared Rust installation
  and download cache are reused, not other builds' source/target directories.
- CFFI derives private simulator/device sysconfig copies from the supplied
  BeeWare cross configuration. It does not alter that environment.

The **deployment floor is 17.0 at compile time** for all native dependencies,
CFFI and Rust; wheel platform metadata is generated with the same floor.
This is not a retagged older or host binary. Earlier exploratory `ios_13_0`
outputs under `crypto-work/{simulator,device}` are superseded for future recipe
builds: arm64 simulator Mach-O actually required 14.0 with this SDK. Do not
advertise iOS 13 simulator support from those older tags. The parent may
retain its exact runtime-tested artifacts for the app's iOS 17 floor, as
recorded below.

## Build

Run on the authorized Mac (the paths below are examples for the QA root):

```sh
QA=/Users/zli/gamma-embedded-qa.yTO5LZ
# Copy these three files into $QA/crypto-work/scripts first.
$QA/build-tools/bin/python $QA/crypto-work/scripts/build-ios-crypto.py \
  --qa-root "$QA" --target simulator --jobs 4
$QA/build-tools/bin/python $QA/crypto-work/scripts/build-ios-crypto.py \
  --qa-root "$QA" --target device --jobs 4

for target in simulator device; do
  ROOT="$QA/crypto-work/$target-ios17.0"
  $QA/build-tools/bin/python $QA/crypto-work/scripts/verify-ios-crypto.py \
    --target "$target" --native-root "$ROOT" "$ROOT"/wheels/*.whl \
    > "$ROOT/verification.json"
done
```

Reruns reuse completed static prefixes and incremental Cargo outputs. Use a
fresh `crypto-work/*-ios17.0` work directory for a clean rebuild; the script
does not delete existing directories or alter the parent build environment.
The archive hashes and Cargo `--locked` constrain source inputs; this is a
reproducible build recipe, not a claim of byte-identical wheel ZIP timestamps
or path-independent debug/install names.

## Necessary upstream build correction

Cryptography 50.0.1's `src/rust/cryptography-cffi/build.rs` applies its legacy
`clang_rt.osx` workaround whenever `target.contains("apple")`. On device this
links macOS/Catalyst `chkstk_darwin.S.o`, which the iOS linker correctly rejects.
The driver makes one checked, idempotent source change:

```diff
-if target.contains("apple") && openssl_static {
+if target.ends_with("apple-darwin") && openssl_static {
```

This restricts the macOS runtime workaround to macOS. The iOS target compiler
selects the correct runtime normally. No crypto algorithms, features, tests,
or public package versions are substituted or stubbed. The patch is recorded
in the generated build manifest.

## Validation and handoff

The verifier checks exact package versions, generated `ios_17_0` wheel tags,
arm64 architecture, Mach-O simulator/device platform (7/2), **actual minimum
OS 17.0**, SDK metadata, and linkage to Python.framework. Dynamic
OpenSSL/libcrypto/libffi and brew/local libraries are rejected. With
`--native-root`, every static archive member's deployment metadata is checked
and archive hashes are included in the JSON report.

The extensions have ordinary build-path LC_ID_DYLIB identifiers; the parent
embedding/framework-packaging stage owns final install-name normalization and
signing. Target CFFI requires the separate pure-Python `pycparser` distribution
(the tested host generator uses 3.0); it belongs in the parent dependency
closure. No bcrypt downgrade is introduced.

**Build success and structural checks are not runtime validation.** The
parent-owned testbed must import `_cffi_backend`, `cffi`, and `cryptography`,
then execute a real Fernet encrypt/decrypt round trip and check
`backend.openssl_version_text()` after
`from cryptography.hazmat.backends.openssl.backend import backend`.
Only the parent runs that testbed/Xcode step. Device execution remains a
separate runtime gate even after simulator success.

Parent-reported integration evidence: the full iOS simulator backend testbed
passed real crypto/Fernet, bcrypt, rpds, MCP/FastAPI, server and PDF routes
using the earlier patched cryptography wheel SHA256
`6eb389c1c4432712f428343cc0a30346fd89acfafea4ae6d6464666c5ce10daa`
and CFFI wheel SHA256
`1d4d5dac46fc94d3c0de27d768947fa5f50dbb5d867a35de786379baad9a8331`.
Those exact artifacts are parent-locked in the full closure and are usable
for the app's iOS 17 floor; their `ios_13_0` tags do not establish iOS 13
simulator support (actual minimum 14.0). This result does not claim runtime
testing of the separately rebuilt, truthfully tagged iOS 17 artifacts or of
a device. Do not change the parent lock or retag those tested artifacts.

Portable script regression tests (no Mac or network required):

```sh
python3 ipad/scripts/test_ios_crypto_build.py
```

These cover source hash verification even with an existing extraction,
archive traversal rejection, exact source pins, simulator/device metadata,
minimum-OS mismatches, and rejection of dynamic libffi. They mock Mach-O
tool output and do not replace the real Mac structural verifier.
