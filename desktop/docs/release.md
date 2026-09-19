# Package, sign, release, update

## Package locally

```bash
python desktop/build_backend.py   # freeze backend (venv python; ~50 MB onedir)
cd desktop && npm run pack        # unpacked app in dist/{win,linux}-unpacked or dist/mac* (fast test)
npm run e2e:packaged              # the suite against the frozen bundle
npm run dist                      # real installer (NSIS .exe / .dmg + .zip / .deb)
```

`electron-builder` (config: `electron-builder.cjs` — it replaced the
`package.json` `build` key so signing can depend on the environment) copies
`dist-backend/gamma-server` into `resources/gamma-server`; a packaged app is
fully self-contained (no Python, no Node on the user's machine). Installers
are named `Gamma-<version>-<os>-<arch>.<ext>`; next to them land the
update-feed files (`latest.yml` / `latest-mac.yml` / `latest-linux.yml`,
`*.blockmap`), see *Auto-update* below. Each OS builds its own installer
(no cross-building: the frozen backend is platform-specific).

Linux is a Debian/Ubuntu `.deb` for x64 (`linux` + `deb` blocks): it
installs to `/opt/Gamma` with the binary `gamma` (also symlinked into
`/usr/bin`; `executableName` in the config — the default would have been
the package name `gamma-desktop`) and a desktop entry in the *Office*
category. `sudo apt install ./Gamma-<version>-linux-amd64.deb` pulls the
runtime dependencies (GTK 3, NSS, …) that electron-builder lists in the
package. The unpacked `dist/linux-unpacked` dir has no setuid
`chrome-sandbox` (the deb's postinst sets that up, plus an AppArmor profile
on Ubuntu ≥ 24.04), so `test/smoke.js` and `test/e2e.js` start it with
`--no-sandbox`; on a headless machine wrap them in `xvfb-run -a`.

## The `desktop` workflow

**A release is a dispatch, not a merge.** `.github/workflows/desktop.yml`
has no push trigger. The `release` skill dispatches it against whatever is
on `main` (`gh workflow run desktop.yml --ref main`); a merge to `main`
publishes only the Docker image. Every run builds Windows + macOS + Linux (pin the version →
frontend build → backend freeze → frozen-server health check →
electron-builder → signature verification → packaged `--smoke`; the Linux
job additionally `apt install`s the `.deb` on the runner and runs the
`--smoke` self-test from `/opt/Gamma/gamma`, sandbox on, under Xvfb) and,
when all three pass, publishes the GitHub Release `Gamma <version>` and its
`v<version>` tag from the merged commit. **The version is computed**: the
newest `v*` tag with the patch number + 1, unless `desktop/package.json`'s
`"version"` is higher — raise that "floor" and merge to make a minor or
major release. The number is pinned into the app on each runner
(`npm version`, no git tag), so About, the update feed and the MSIX carry
it while the repo file stays a floor. Release notes are the commit
subjects since the previous tag. Dispatch inputs: `version` override,
`prerelease`, and `publish=false` for build-only artifacts (14 days). The
publish job also dispatches `docker.yml` on the new tag so the server image
gets a `<version>` tag, and the Windows job submits the MSIX to the
Microsoft Store when the Partner Center secrets exist (below). The browser
extension (`extension.yml`, releases tagged `extension-v<version>`,
published with `make_latest: false` so the desktop release stays the
repository's "latest" — the updater depends on that) is a separate
workflow; everything side by side, with the version rule spelled out:
[docs/dev/github_actions.md](../../docs/dev/github_actions.md).

## Code signing (optional, secret-gated)

Every signing piece in `electron-builder.cjs` switches on only when its
credentials are present, so `npm run dist` locally and forks without certs
still produce (unsigned) installers. The workflow feeds these repository
secrets through:

| Platform | Secrets | What it does |
|---|---|---|
| Windows | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, optional `AZURE_SIGN_PUBLISHER` | [Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) via electron-builder's `azureSignOptions`: signs `Gamma.exe`, the frozen `gamma-server.exe` and the NSIS installer. The three `AZURE_*` auth values are an Entra app registration (client secret) holding the *Trusted Signing Certificate Profile Signer* role on the account; endpoint is the region URL (e.g. `https://eus.codesigning.azure.net`), account/profile are the resource names, publisher the certificate subject (`CN=…`). |
| macOS | `MAC_CERT_P12` (base64 of the *Developer ID Application* `.p12`: `base64 -i cert.p12 \| pbcopy`), `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Developer ID signing (the macOS build step exports them as electron-builder's `CSC_LINK`/`CSC_KEY_PASSWORD` only when set — an empty `CSC_LINK` in the env is read as a certificate path and fails the build) with hardened runtime + `assets/entitlements.mac.plist` (JIT + `disable-library-validation`, which the PyInstaller sidecar needs to load its Python extension modules; osx-sign walks the whole `.app`, so `Contents/Resources/gamma-server` is signed too), then notarization (`mac.notarize`) with an [app-specific password](https://support.apple.com/102654) and stapling. |

Linux has no equivalent: a `.deb` file carries no signature (apt trusts
repositories, not files), so the Linux build is neither signed nor warned
about, and a downloaded `.deb` installs without any prompt beyond sudo.

The workflow prints a `::warning::` per platform when it builds unsigned,
and a *Verify signature* step (`Get-AuthenticodeSignature` / `codesign
--verify` + `spctl --assess` + `stapler validate`) fails the job if a
credentialed build didn't actually sign. Release notes state per platform
whether the build is signed.

**Unsigned builds** (the state until the accounts exist): Windows shows
SmartScreen's *More info → Run anyway* (Edge's download shelf: *… → Keep →
Keep anyway*). SmartScreen reputation is per certificate: even signed, a
brand-new certificate can still trigger Edge's "not commonly downloaded"
notice for the first downloads (EV certificates skip that).

**macOS without a Developer ID is ad-hoc signed**, not left unsigned.
electron-builder skips signing entirely when it finds no identity, and on
macOS 14/15 an unsigned app from the internet gets the dead-end *Gamma is
damaged and can't be opened* dialog — only `xattr -dr com.apple.quarantine`
in a terminal gets past it. `scripts/adhoc-sign.cjs`, an `afterPack` hook,
runs `codesign --force --deep --sign - Gamma.app` before the dmg/zip are
made (it does nothing when `CSC_LINK`/`CSC_NAME` is set; osx-sign then
signs with the real identity). An ad-hoc signed app gets *Apple could not
verify Gamma is free of malware* instead, and after that first attempt
*System Settings → Privacy & Security → Security* shows an **Open Anyway**
button: one click, once per download. The workflow's *Verify signature*
step checks `Signature=adhoc` on cert-less builds. Limits that only a
Developer ID removes: the dialog itself (notarization), and in-place
updates — Squirrel.Mac refuses to swap in an app without a matching real
signature, so `IN_APP_INSTALL` in `lib/updater.js` stays off for darwin and
the shell only notifies. Flip it once the builds are signed and notarized.

### Cheaper distribution routes

- **winget** (free, Windows): a manifest in
  [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
  pointing at the release `.exe` (NSIS installs silently with `/S`); winget
  verifies the SHA-256 itself and runs the installer without the
  mark-of-the-web, so SmartScreen does not interpose. Needs a published
  release to point at, then one PR per version (automatable with
  `wingetcreate` in the workflow).
- **Microsoft Store**: an MSIX the Store signs with Microsoft's certificate
  — no SmartScreen, and the Store handles updates. Configured in
  `electron-builder.cjs`; see *Microsoft Store* below.
- **Homebrew cask** (macOS) does not help: brew leaves the quarantine
  attribute on; only signing + notarization fixes the *damaged* dialog.

## Microsoft Store

The Store build is the `appx` target in `electron-builder.cjs`. Its `appx`
block carries the product identity from Partner Center (*Apps and games →
GammaPDF → Product management → Product identity*): `identityName`
(`xwtim.GammaPDF`), `publisher` (`CN=<GUID>`), `publisherDisplayName`
(`xwtim`); `displayName` must equal the name reserved in the Store. A
mismatch in any of them is rejected at upload. The Store ID is
`9N8WGWR2J2MV`. The same block sets `applicationId`, `languages`,
`showNameOnTiles` and `backgroundColor`, the Start-menu tile colour, which
matches the logo tile's `#1e1e1c`.

**Package assets.** electron-builder takes the MSIX's tile images from
`assets/appx/` (`directories.buildResources: 'assets'` in the packaging
config, with `appx` matched by directory name): `Square44x44Logo` (taskbar /
Start list, plus `targetsize-N` and `_altform-unplated` variants),
`Square150x150Logo`, `Wide310x150Logo`, `SmallTile`, `LargeTile`,
`StoreLogo`, `SplashScreen`, each with `.scale-125/150/200/400` variants
(their presence makes electron-builder run `makepri`, so Windows picks a
sharp one per DPI). The tiles are the bare mark on a transparent plate,
coloured by `backgroundColor`; the 44 px logo is the rounded app icon.
`npm run store-art` renders all of them from the logo mark (same script as
the listing art below). **The folder must exist**: without it
electron-builder ships its own `SampleAppx.*` placeholders and
certification fails policy 10.1.1.11 ("tile icons include a default
image").

**Build.** Windows only (electron-builder fetches `makeappx`/`signtool`
itself, no Windows SDK needed):

```powershell
cd desktop
npx electron-builder --win appx --config.directories.output=dist-store
```

It logs *AppX is not signed (Windows Store only build)* and writes
`dist-store/Gamma-<version>-win-x64.appx`. Unsigned is correct: the Store
signs the package, and signing it locally would also change the manifest
publisher to the certificate's subject. Never build it with the `AZURE_*`
signing env present; the release workflow blanks those variables for this
step. The workflow uploads the result as the `store-windows` workflow
artifact, not a release asset, since nobody can install it before the Store
signs it.

**Submit.** Partner Center → the product → *Submissions* → new submission →
*Packages*: upload the `.appx`; fill the listing (screenshots, description),
age rating, free pricing and the privacy-policy URL (mandatory because the
app uses the network). The English listing text (description, feature
bullets, search terms) is kept in [`assets/store/listing.md`](../assets/store/listing.md);
paste the whole *Description* section, since a one-liner fails policy
10.1.4.3 ("a few words or just the app title is not sufficient"). The policy is the repo's
[`PRIVACY.md`](../../PRIVACY.md), so the URL is
`https://github.com/tim4431/Gamma/blob/main/PRIVACY.md`; it has to be
Gamma's own policy, naming the app and its developer, or certification
fails policy 10.5.1 ("privacy policy is for an unrelated company"). The
listing's *Store logos* (9:16 poster art, 1:1 box art) and *Store display
images* (300/150/71 px app tile icons) are pre-rendered in `assets/store/`;
`npm run store-art` regenerates them, together with the package assets in
`assets/appx/`, from the logo mark with Playwright's Chromium
(`scripts/store-art.js` delegates to the shared brand generator). Generation
uses the frontend's locked Playwright, Python 3 and the shared hero logo/font stack;
no font download is needed. See [brand sources](../../design/brand/README.md).
The package version must increase per submission
(`package.json` `<version>` becomes `<version>.0`; the Store requires the
fourth part to be 0, which electron-builder guarantees). Certification takes one
to three days; the reviewer launches the app, so a fresh install must reach
the launcher with no server configured.

**Runtime differences of the Store install:**

- `process.windowsStore` is true; `lib/updater.js` reports `unsupported`
  (reason `store`) and the launcher / *Help → Check for Updates…* say the
  Store delivers updates. `electron-updater` is never initialized.
- MSIX virtualizes AppData: Electron's userData (the registry and every
  local server's data dir under it, see
  [architecture.md](architecture.md#shell-state)) lands in
  `%LOCALAPPDATA%\Packages\xwtim.GammaPDF_<hash>\LocalCache\Roaming\gamma-desktop`.
  A Store install and an NSIS install never see each other's servers, and
  **uninstalling the Store app deletes that folder**, including local
  servers' PDFs and databases.
- The launcher's *Local server storage* setting is the way out of that
  folder: pick one outside the package (e.g. under *Documents*) and *Move
  data* relocates the existing servers there
  ([architecture.md](architecture.md#shell-state)).
- The install directory (`C:\Program Files\WindowsApps\…`) is read-only.
  Fine for the onedir sidecar, which writes only to `GAMMA_DATA_DIR`.
  Loopback to `127.0.0.1` is unrestricted for full-trust packaged apps, so
  the sidecar and the browser extension work as usual.

**Local install test.** An unsigned MSIX cannot be installed. Sign it with a
self-signed certificate whose subject is exactly the `appx.publisher` GUID
(once, elevated PowerShell; then turn on *Settings → System → For
developers → Developer Mode*):

```powershell
$c = New-SelfSignedCertificate -Type Custom -Subject "CN=2641C414-B740-42FF-BD24-6552C33A850A" `
  -KeyUsage DigitalSignature -FriendlyName "Gamma Store dev" -CertStoreLocation Cert:\CurrentUser\My `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
$pw = ConvertTo-SecureString "dev" -AsPlainText -Force
Export-PfxCertificate -Cert $c -FilePath dev.pfx -Password $pw
Export-Certificate -Cert $c -FilePath dev.cer
Import-Certificate -FilePath dev.cer -CertStoreLocation Cert:\LocalMachine\TrustedPeople
```

Per build (`signtool` is in the Windows SDK, or under
`~\AppData\Local\electron-builder\Cache\winCodeSign\…\windows-10\x64`):

```powershell
signtool sign /fd SHA256 /f dev.pfx /p dev dist-store\Gamma-<version>-win-x64.appx
Add-AppxPackage dist-store\Gamma-<version>-win-x64.appx
Get-AppxPackage *GammaPDF* | Remove-AppxPackage   # before re-installing the same version
```

Do not point `CSC_LINK` at the dev pfx instead: electron-builder would
then sign the NSIS build with the throwaway certificate too.

**Automatic submission.** The desktop workflow's Windows job submits the
MSIX itself when four repository secrets exist, using Microsoft's `msstore`
CLI (installed on the runner by `microsoft/microsoft-store-apppublisher`;
the older `microsoft/store-submission` action is deprecated in its favour):

```bash
msstore reconfigure --tenantId … --sellerId … --clientId … --clientSecret …
msstore publish Gamma-<version>.msix --appId 9N8WGWR2J2MV
```

`publish` uploads the package, creates a submission and commits it to
certification (still 1–3 days; the Store then rolls the update out). The
CLI only accepts `.msix` file names, and electron-builder's `.appx` is the
same format, so the workflow copies it under that name. The package
version is the computed release version plus `.0`, which satisfies the
Store's must-increase rule. The submission API also rejects MSIX packages
whose `MinVersion` is ≤ 10.0.17134.0 — the web upload form let
electron-builder's default (10.0.14316.0) through as a legacy `.appx`, the
CLI path did not — hence `appx.minVersion: '10.0.17763.0'` (Windows 10
1809, Electron's own floor) in `electron-builder.cjs`. Only one submission can be in certification at
a time, so the step is `continue-on-error`: a second release the same day
logs a warning and the next release submits. Where the secrets come from
(set each with `gh secret set NAME` from a terminal):

| Secret | Partner Center |
|---|---|
| `PARTNER_CENTER_TENANT_ID`, `PARTNER_CENTER_CLIENT_ID`, `PARTNER_CENTER_CLIENT_SECRET` | *Account settings → User management → Azure AD applications*: add (or create) an Azure AD app registration with the *Manager* role, then create a client secret for it. Tenant id = the Azure AD tenant it lives in. |
| `PARTNER_CENTER_SELLER_ID` | *Account settings → Organization profile → Legal info* (a numeric id). |

Without the secrets the step prints a notice and the MSIX stays the
`store-windows` workflow artifact for manual upload as described above.

## Auto-update feed

`electron-builder.cjs` has `publish: { provider: 'github', owner, repo }`.
That does two things and nothing else (the workflow still runs
`--publish never`; it creates the GitHub Release itself):

1. `resources/app-update.yml` is baked into the app, telling
   `electron-updater` where to look.
2. `latest.yml` (Windows) / `latest-mac.yml` (macOS) / `latest-linux.yml`
   (Linux) and the installer `.blockmap`s are written next to the
   installers; the workflow uploads them as release assets alongside the
   `.exe` / `.dmg` / `.zip` / `.deb`.

At run time (`lib/updater.js`; behavior in
[architecture.md](architecture.md#in-app-updates)) the app resolves the
newest non-prerelease release, reads its `latest*.yml`, and downloads the
installer (differential via the blockmap when possible). Consequences:

- A release marked *pre-release* is invisible to installed apps.
- The tag must be `v<version>` and the version must be a higher semver than
  the installed one — both are what the workflow produces.
- Deleting `latest*.yml` from a release, or publishing a draft, makes
  clients report *Update check failed* until the next good release.
- The installer file names must stay `Gamma-<version>-<os>-<arch>.<ext>`
  (electron-builder writes those names into the yml).
- macOS reads `latest-mac.yml` and expects the `.zip` target (kept next to
  the `.dmg` for that reason).
- Linux reads `latest-linux.yml`; the `.deb` target writes
  `resources/package-type` = `deb`, which is how electron-updater picks its
  `DebUpdater` (installs via `pkexec dpkg -i`, then relaunches). Without
  that file it would assume an AppImage and fail.
