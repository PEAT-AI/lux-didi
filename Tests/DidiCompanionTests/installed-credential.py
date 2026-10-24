"""Focused real-file/owned-child proof and synthetic external Keychain controls."""
import hashlib
import json
import os
import plistlib
from pathlib import Path
import subprocess
import sys
import tempfile

source = Path(__file__).resolve().parents[2]
os.umask(0o077)
node = Path(sys.argv[1]).resolve(strict=True)
evidence = Path(sys.argv[2]).resolve()
evidence.mkdir(mode=0o700)
expected_node = sys.argv[3]
assert hashlib.sha256(node.read_bytes()).hexdigest() == expected_node, "accepted Node fixture changed"
node_version = subprocess.run([str(node), "-p", "process.versions.node"], capture_output=True, text=True, check=True).stdout.strip()
assert node_version.startswith("26."), "accepted Node major changed"
commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source, capture_output=True, text=True, check=True).stdout.strip()
summary = {"type": "InstalledCredentialFocusedEvidence", "sourceCommit": commit,
           "nodeSHA256": expected_node, "nodeVersion": node_version, "ownerAppOrDataTouched": False, "paidCI": False, "success": False}
with tempfile.TemporaryDirectory(prefix="didi-credential-compile-") as temporary:
    work = Path(temporary)
    app = work / "Credential Proof.app"
    executable = app / "Contents/MacOS/LuxDidi"
    executable.parent.mkdir(parents=True)
    info = plistlib.loads((source / "Resources/Info.plist").read_bytes())
    info["CFBundleIdentifier"] = "ai.peat.lux-didi.credential-proof"
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
    command = [str(source / "scripts/with-compile-lock.sh"), "--", "xcrun", "swiftc", "-j", "1", "-num-threads", "1", "-whole-module-optimization",
               "-D", "COMPANION_TEST", "-parse-as-library", "-module-cache-path", str(work / "cache")]
    command += [str(path) for path in sorted((source / "Sources/LuxDidi").glob("*.swift"))]
    command += [str(path) for path in sorted((source / "Tests/DidiCompanionTests").glob("*.swift"))]
    command += ["-o", str(executable)]
    with (evidence / "compile.log").open("w") as log:
        compiled = subprocess.run(command, cwd=source, stdout=log, stderr=subprocess.STDOUT, timeout=180)
    summary["compileExit"] = compiled.returncode
    if compiled.returncode != 0:
        raise SystemExit("focused Swift compile failed; private compile.log retained")
    summary["nativeSHA256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
    with (evidence / "installed-runtime.log").open("w") as log:
        runtime = subprocess.run([str(executable), "--installed-credential-child", str(node), str(source), str(evidence / "installed-runtime.json")],
                                 cwd=source, stdout=log, stderr=subprocess.STDOUT, timeout=45)
    summary["runtimeExit"] = runtime.returncode
    if runtime.returncode != 0:
        raise SystemExit("focused installed runtime failed; private installed-runtime.log retained")
    runtime_report = json.loads((evidence / "installed-runtime.json").read_text())
    assert runtime_report["success"] and len(runtime_report["checks"]) >= 30
    with (evidence / "external-keychain.log").open("w") as log:
        external = subprocess.run([sys.executable, str(source / "Tests/DidiCompanionTests/keychain-sdk.py"), str(executable), str(evidence)],
                                  cwd=source, stdout=log, stderr=subprocess.STDOUT, timeout=40)
    summary["externalKeychainExit"] = external.returncode
    if external.returncode != 0:
        raise SystemExit("external synthetic Keychain SDK controls failed; private external-keychain.log retained")
    summary["success"] = True
(evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
for path in evidence.rglob("*"):
    os.chmod(path, 0o700 if path.is_dir() else 0o600)
print(json.dumps(summary, sort_keys=True))
