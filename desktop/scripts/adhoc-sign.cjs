// electron-builder `afterPack` hook (wired in electron-builder.cjs): ad-hoc
// sign the macOS app when no Developer ID certificate is available.
//
// Why: electron-builder leaves the app entirely UNSIGNED when it finds no
// identity, and on macOS 14/15 an unsigned app downloaded from the internet
// gets the dead-end "Gamma is damaged and can't be opened" dialog — the only
// way past it is `xattr -dr com.apple.quarantine` in a terminal. An app
// signed with the ad-hoc pseudo-identity (`codesign --sign -`) instead gets
// "Apple could not verify Gamma is free of malware", after which System
// Settings → Privacy & Security shows an *Open Anyway* button. One click,
// once per download, no terminal. It is still not notarized: the dialog
// appears, and Squirrel.Mac will not auto-update an ad-hoc app (the updater
// stays notify-only, see lib/updater.js).
//
// Runs before electron-builder's own signing step. With a real certificate
// (CSC_LINK / CSC_NAME set) it does nothing — osx-sign signs with the
// Developer ID and hardened runtime afterwards. Ad-hoc signing sets no
// hardened runtime, so the entitlements file is not needed here.

const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing (no Developer ID)  app=${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
