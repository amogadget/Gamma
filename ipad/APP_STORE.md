# App Store build

App Store Connect record: **Gamma - PDF Reader**, Apple ID **6814705181**.
Owning paid developer team: **A436A36DDC**.
The release bundle identifier is **net.blitzbuild.gamma**. The current release
is **1.1 (3)**, with native-to-Web position restoration and direct server
disconnect. Historical **1.0 (2)** introduced standalone local mode; **1.0 (1)**
predates that feature. The archive must report `UIDeviceFamily: [2]` (iPad
only); target-level settings enforce this because XcodeGen's iOS target default
can override project-level device-family settings. The macOS listing is not a
macOS build target in this project.

## Signing and delivery

Use the paid development team that owns this identifier. The previous local
`com.gamma.pdfnotes.ipad` development installation is a different app; migrating
its container is not a prerequisite for this release. Do not uninstall it as
part of preparing an archive.

1. Configure an App Store Connect API key for unattended CLI/CI delivery (below),
   or sign into the correct developer account in Xcode for GUI-based delivery.
2. Generate `ipad/GammaIPad.xcodeproj` using `xcodegen generate --spec
   ipad/project.yml --project ipad`. Do not apply an old local override that
   changes the bundle identifier back to the development app.
3. With API-key authentication configured, run from SSH/CI; without it, run in
   the logged-in macOS GUI session:

   ```sh
   bash ipad/scripts/mac-app-store-build.sh "$ROOT" "$TEAM_ID" archive 3
   ```

   `ROOT` is the release checkout containing `ipad/`; `TEAM_ID` is the owning
   team's ten-character identifier. Automatic provisioning is enabled. Either
   the API key or Xcode account must have the necessary signing and app-access
   permissions. Without an explicit build argument, the project build number is
   used. No password or private key belongs in the script or source repository.

4. After a successful signed archive, deliver the build:

   ```sh
   bash ipad/scripts/mac-app-store-build.sh "$ROOT" "$TEAM_ID" upload
   ```

   The script checks the archived bundle identifier and signature, adds the
   team to `ExportOptions.appstore.plist`, and asks Xcode to upload to App Store
   Connect. This does **not** submit the app for review or publish it. Verify
   Apple's processing result and the build record separately.

## Unattended TestFlight upload

GUI interaction is not required. An authorized team member can configure a
**team App Store Connect API key** with the necessary signing/build-upload
permissions. Keep its `.p8` file in a protected directory outside the checkout
on the Mac (or materialize it from a CI secret with restricted permissions).

```sh
export GAMMA_ASC_KEY_PATH="$HOME/.private_keys/AuthKey_KEYID.p8"
export GAMMA_ASC_KEY_ID="KEYID"
export GAMMA_ASC_ISSUER_ID="ISSUER-UUID"
# Optional: use an already verified current signed archive rather than rebuild.
export GAMMA_ARCHIVE_PATH="/path/to/current/GammaIPad.xcarchive"
bash ipad/scripts/mac-app-store-build.sh "$ROOT" A436A36DDC upload
```

All three authentication values are required together. The helper passes
`-authenticationKeyPath`, `-authenticationKeyID` and `-authenticationKeyIssuerID`
to Xcode for both automatic signing and export/upload. The issuer UUID is not the
ten-character developer Team ID. The key is not copied into the app or printed.
GitHub Actions needs these credentials configured too; it does not bypass Apple
authorization. If automatic distribution signing is not allowed by the key's
permissions, valid distribution signing assets/permissions are additionally
required. Do not revoke unrelated certificates to resolve account access.

Uploading this way sends a build to App Store Connect for TestFlight processing;
it does not submit App Review, publish an App Store version, add testers or
promise processing has completed. Verify those states separately.

Outputs and status are under `$ROOT/appstore-build/`. An unsigned archive can
prove Release compilation, but is not an uploadable build and must never be
reported as a successful delivery.

`GammaIPad/PrivacyInfo.xcprivacy` declares the app-private UserDefaults usage
(reason CA92.1). The build declares no non-exempt encryption: current native
code uses system HTTPS/Keychain and hashing, not custom encryption; revisit this
if encryption features change. Store privacy answers, screenshots, support/privacy URLs,
export-compliance answers and review access still require accurate completion
before submitting a version for review; the API-reason manifest is not a
substitute for those declarations.
