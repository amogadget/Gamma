#!/usr/bin/env python3
"""Install a manual desktop-session build agent for this checkout (macOS only)."""
import os
from pathlib import Path
import plistlib
import subprocess
import sys

if sys.platform != "darwin":
    raise SystemExit("Run this installer on the Mac with Xcode and a logged-in desktop user.")
root = Path(__file__).resolve().parents[2]
label = "com.gamma.ipad.agent-build"
service = f"gui/{os.getuid()}/{label}"
subprocess.run(["launchctl", "print", f"gui/{os.getuid()}"], check=True, stdout=subprocess.DEVNULL)
existing = subprocess.run(["launchctl", "print", service], capture_output=True, text=True)
if existing.returncode == 0:
    if "state = running" in existing.stdout:
        raise SystemExit("Build agent is running; wait for it to finish before reinstalling.")
    subprocess.run(["launchctl", "bootout", service], check=True)

template = Path(__file__).with_name(label + ".plist").read_text()
# Replace paths as plist values rather than raw XML, supporting spaces and '&'.
config = plistlib.loads(template.encode())
config["ProgramArguments"] = [value.replace("__CHECKOUT__", str(root)) for value in config["ProgramArguments"]]
for key in ("StandardOutPath", "StandardErrorPath"):
    config[key] = config[key].replace("__CHECKOUT__", str(root))
(root / "gui-build").mkdir(exist_ok=True)
agent = Path.home() / "Library/LaunchAgents" / (label + ".plist")
agent.parent.mkdir(parents=True, exist_ok=True)
agent.write_bytes(plistlib.dumps(config))
subprocess.run(["plutil", "-lint", str(agent)], check=True)
subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(agent)], check=True)
print(f"Installed {service}; no build started, no keychain permissions changed.")
print(f"Trigger: launchctl kickstart {service}")
