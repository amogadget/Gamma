// electron-builder hook: ad-hoc sign the macOS bundle.
//
// Every binary on Apple Silicon needs a signature to execute at all — an
// unsigned app does not get Gatekeeper's "unidentified developer" prompt, it
// gets "Gamma is damaged and can't be opened", which is macOS refusing code
// whose signature does not validate. There is no Developer ID yet, so ad-hoc
// (`--sign -`) is what there is.
//
// This runs as `afterPack`, not `afterSign`: electron-builder skips its whole
// signing phase when no identity is configured, and a hook inside a skipped
// phase does not run. afterPack always runs, and — crucially — it runs *before*
// the dmg is assembled, so the shipped disk image contains the signed bundle.
// Signing the bundle after `electron-builder` has already produced the dmg
// fixes a copy nobody ships; that is exactly how 0.1.0 came out damaged.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const name = context.packager.appInfo.productFilename;
  const app = path.join(context.appOutDir, `${name}.app`);
  if (!fs.existsSync(app)) {
    throw new Error(`afterPack: no bundle at ${app}`);
  }

  const run = (args) =>
    execFileSync("codesign", args, { stdio: "inherit", encoding: "utf8" });

  console.log(`  • ad-hoc signing  ${path.relative(process.cwd(), app)}`);
  // --deep is discouraged for Developer ID + notarization, where each nested
  // component wants its own entitlements. For an ad-hoc signature whose only
  // job is to make the code loadable, it is the right tool.
  run(["--force", "--deep", "--sign", "-", app]);
  run(["--verify", "--deep", "--strict", "--verbose=2", app]);
};
