# App Store build

App Store Connect record: **Gamma - PDF Reader**, Apple ID **6814705181**.
Owning paid developer team: **A436A36DDC**.
The release bundle identifier is **net.blitzbuild.gamma**, initially version
**1.0**, build **1**. The archive must report `UIDeviceFamily: [2]` (iPad
only); target-level settings enforce this because XcodeGen's iOS target default
can override project-level device-family settings. The macOS listing is not a
macOS build target in this project.

## Signing and delivery

Use the paid development team that owns this identifier. The previous local
`com.gamma.pdfnotes.ipad` development installation is a different app; migrating
its container is not a prerequisite for this release. Do not uninstall it as
part of preparing an archive.

1. Sign into the correct developer account in Xcode and select the paid team.
2. Generate `ipad/GammaIPad.xcodeproj` using `xcodegen generate --spec
   ipad/project.yml --project ipad`. Do not apply an old local override that
   changes the bundle identifier back to the development app.
3. In the logged-in macOS GUI session, run:

   ```sh
   bash ipad/scripts/mac-app-store-build.sh "$ROOT" "$TEAM_ID" archive 1
   ```

   `ROOT` is the release checkout containing `ipad/`; `TEAM_ID` is the owning
   team's ten-character identifier. Automatic provisioning is enabled. Xcode
   must already have the corresponding developer account; no password belongs
   in the script or source repository.

4. After a successful signed archive, deliver the build:

   ```sh
   bash ipad/scripts/mac-app-store-build.sh "$ROOT" "$TEAM_ID" upload
   ```

   The script checks the archived bundle identifier and signature, adds the
   team to `ExportOptions.appstore.plist`, and asks Xcode to upload to App Store
   Connect. This does **not** submit the app for review or publish it. Verify
   Apple's processing result and the build record separately.

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
