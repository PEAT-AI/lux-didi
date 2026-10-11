"""Bounded real-SDK children; invoked only by the declared companion producer."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

executable = Path(sys.argv[1]).resolve(strict=True)
evidence = Path(sys.argv[2]) / "keychain-sdk"
evidence.mkdir(mode=0o700)
results = []
with tempfile.TemporaryDirectory(prefix="didi-keychain-sdk-") as temporary:
    root = Path(temporary)
    for mode in ("missing", "inherited"):
        state = root / (mode + "-state")
        report = evidence / (mode + ".json")
        environment = os.environ.copy()
        if mode == "missing":
            home = root / "missing-login-home"
            home.mkdir(mode=0o700)
            environment.update(HOME=str(home), CFFIXED_USER_HOME=str(home))
        log = evidence / (mode + ".log")
        result = {"mode": mode, "acceptance": False, "finite": False, "success": False}
        with log.open("w") as stream:
            child = subprocess.Popen([str(executable), "--keychain-sdk-child", mode, str(state), str(report)],
                                     env=environment, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT)
            result["pid"] = child.pid
            try:
                result["exit"] = child.wait(timeout=8)
                result["finite"] = True
            except subprocess.TimeoutExpired:
                # Exact Popen PID belongs to this test; no process enumeration or
                # foreign signaling. Sample first, then terminate this one child.
                result["timeout"] = True
                sampled = subprocess.run(["/usr/bin/sample", str(child.pid), "1", "1", "-file", str(evidence / (mode + ".sample.txt"))],
                                         stdout=stream, stderr=subprocess.STDOUT, timeout=8)
                result["sampleExit"] = sampled.returncode
                child.terminate()
                try:
                    result["exit"] = child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    result["exit"] = child.wait(timeout=3)
        if report.exists():
            value = json.loads(report.read_text())
            result.update(stage=value["stage"], reportPID=value["pid"], addStatus=value.get("addStatus"),
                          typedRefusal=value.get("typedRefusal"), bootstrapAttempted=value["bootstrapAttempted"],
                          credentialReturned=value["credentialReturned"], equalReimport=value["equalReimport"],
                          cleanupStatus=value["cleanupStatus"], absentStatus=value["absentStatus"])
            result["success"] = result["finite"] and result["exit"] == 0 and value["success"] and value["pid"] == child.pid
        results.append(result)
summary = {"type": "RealKeychainSDKDiscriminator", "nativeExecutableSHA256": hashlib.sha256(executable.read_bytes()).hexdigest(),
           "results": results, "success": all(result["success"] for result in results), "globalPolicyChanged": False}
(evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
for file in evidence.iterdir():
    os.chmod(file, 0o600)
for result in results:
    print("KEYCHAIN-SDK", json.dumps(result, sort_keys=True))
sys.exit(0 if summary["success"] else 1)
