# Embedded Gamma packaging phase

`package-embedded-runtime.sh` is the Xcode `GAMMA_EMBEDDED_BUNDLE_SCRIPT`
entry point. It packages already-built inputs offline. It does not install
packages, download, compile, embed Python.framework, or access application data.
Run after frontend/native-wheel preparation and before final app signing.
The host compiles `GammaEmbeddedPDF.m` as a builtin; an `_gamma_ios_pdf` extension
wheel is rejected.

## Inputs

- `GAMMA_BUILD_PYTHON`: executable path, defaults to `python3`. Host Python 3.10+
  with the `packaging` library already available (only for metadata constraints).
- `GAMMA_PYTHON_XCFRAMEWORK`: extracted BeeWare Python 3.13 XCFramework root,
  including common `lib/` (`libcommon/` accepted for alternate layouts), the selected slice's `lib-arm64` (or `lib` when unsplit),
  and `build/iOS-dylib-Info-template.plist`.
- `GAMMA_WHEELHOUSE`: root with `pure/`, `simulator/`, and `device/`.
- `GAMMA_PYTHON_LOCK`: JSON described below; defaults to
  `GAMMA_WHEELHOUSE/../embedded-closure-lock.json`.
- `GAMMA_BACKEND_SOURCE`: repository root or its `backend/` directory.
- `GAMMA_FRONTEND_DIST`: compiled frontend with `index.html`.
- `GAMMA_CJK_FONT_DIR`: required directory with the actual
  `DroidSansFallbackFull.ttf` used by the Docker build, its nonempty license or
  copyright file (`LICENSE*`, `COPYING*`, `COPYRIGHT*`, `OFL*`, or `APACHE*`,
  case-insensitive), and any `NOTICE*` files. These are copied byte-for-byte to
  `EmbeddedGamma/app/gamma/resources/fonts/` and recorded in the resource-hash
  manifest. Missing font/license, symlinks and invalid TrueType headers fail
  packaging; there is no silent system-font/CJK fallback. The supplier remains
  responsible for providing the authentic font and complete matching license.
- `GAMMA_EMBEDDED_SOURCE_ROOT`: source directory containing
  `gamma_ios_runtime.py` and `gamma_ios_pdf.py`, normally `$SRCROOT/EmbeddedBackend`.
- `GAMMA_EMBEDDED_RESOURCE_ROOT`: exactly `$CODESIGNING_FOLDER_PATH/EmbeddedGamma`.
- Xcode supplies `TARGET_BUILD_DIR`, `CODESIGNING_FOLDER_PATH`, `PLATFORM_NAME`
  (`iphoneos` or `iphonesimulator`), `ARCHS=arm64`, and
  `EXPANDED_CODE_SIGN_IDENTITY`. Only simulator builds may fall back to ad-hoc
  `-` signing, and only when `CODE_SIGNING_ALLOWED=YES` (default YES).

The parent Xcode phase separately embeds and signs the selected
`Python.framework`. If the selected distribution contains a vendor
`PrivacyInfo.xcprivacy`, the packager preserves/forwards it; the tested 3.13-b15
support archive contains none, and that absence is reported explicitly. The
application must declare its actual required-reason API usage before release;
the packager generates no fictional vendor privacy claims. The native host configures TLS
with bundled certifi before importing the backend.

## Closure lock

Every required wheel is explicitly locked; extra wheels in the directories are
not copied. Native versions are checked against wheel METADATA, not inferred
from filenames. The five mandatory native distributions are `pydantic-core`,
`bcrypt`, `rpds-py`, `cryptography`, and `cffi`.

The production lock is a JSON list. Pure records carry `filename` and `sha256`
directly; native records carry a `wheels` mapping keyed by target:

```json
[
  {"name": "setuptools", "version": "84.0.0", "native": false,
   "filename": "setuptools-84.0.0-py3-none-any.whl", "sha256": "64_HEX_DIGITS"},
  {"name": "pydantic-core", "version": "2.46.2", "native": true,
   "wheels": {
     "simulator": {"filename": "EXACT_SIMULATOR_WHEEL.whl", "sha256": "64_HEX_DIGITS"},
     "device": {"filename": "EXACT_DEVICE_WHEEL.whl", "sha256": "64_HEX_DIGITS"}
   }}
]
```

Missing native target hashes are a hard error, including unfinished records
that currently contain only name/version/native. The installed setuptools
wheel is included like any other locked pure dependency: its modules, vendored
modules, `_distutils_hack`, `.pth` file and distribution metadata are preserved.
The original grouped `{pure: [...], native: {simulator: [...], device: [...]}}`
form remains supported. Set `GAMMA_PYTHON_LOCK` explicitly when using the
checked-in `ipad/EmbeddedBackend/python-closure.lock.json` rather than the QA
wheelhouse's adjacent lock. No versions or hashes are guessed.

The abbreviated example is not a complete closure and deliberately cannot
package. All hashes, package versions, iOS dependency markers, wheel tags, and
thin ARM64 Mach-O platform/minimum versions are checked before input copying.
Native deployment floors below 17 (including cryptography's 13) are accepted;
floors above 17 and device/simulator mismatches are rejected. This invokes the
existing wheel-builder's portable Mach-O validator, not its build workflow.

## Outputs and safety

`EmbeddedGamma` contains `python/lib/python3.13`, `app/gamma`, the two runtime
adapters, `app_packages` (including wheel metadata, licenses, and package data),
and `frontend`. Backend copying only selects Python files, `mcp_icon.png`,
`.resource` files, and fonts; cache files, instructions, local configuration,
and key files are excluded throughout. Top-level Gamma/Python license notices
are collected in `licenses/`.

Extensions become `Frameworks/<full.module>.framework/<full.module>`, with
an ABI-suffixed `.fwork` marker at the original Python location containing the
app-relative framework binary path. The binary's sibling `.origin` contains
the app-relative marker path. Framework IDs are rewritten to `@rpath`,
dependencies/RPATHs checked, and each framework signed before publishing.
Loose native binaries in resources are rejected.

Staging happens under `TARGET_BUILD_DIR`, leaving previous output intact if
validation or signing fails. Replacement is restricted to the exact app's
`EmbeddedGamma` and frameworks listed in its previous packaging manifest.
Unowned existing output and framework collisions are rejected. Never point
this at a user-data directory. The sorted manifest records input-lock and
resource hashes; code-signature bytes themselves are not claimed reproducible.

## Portable tests

```sh
python3 -m unittest discover -s ipad/scripts -p test_package_embedded_runtime.py -v
```

These test hashes, exact versions, traversal, architecture/platform/minimum
checks, native-package completeness, dependency gaps, module collisions, and
output guards without executing any Mac tool. Actual Xcode packaging, signing,
and launch verification must be performed on macOS separately.
