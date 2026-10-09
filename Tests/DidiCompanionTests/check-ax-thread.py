"""Verify the real own-PID diagnostic does not issue AX calls on AppKit's thread.

This checks diagnostic scheduling/evidence only, never title matching, visibility,
faithful capture, connected HOST functionality, or the full acceptance receipt.
"""
import json
import sys

with open(sys.argv[1], encoding="utf-8") as report:
    evidence = json.load(report)["axConsumer"]
assert evidence.get("queryOnMainThread") is False, "own-PID AX query must run off AppKit thread"
assert isinstance(evidence.get("titleStatuses"), list), "retain exact title AXError statuses"
assert isinstance(evidence.get("titleMatches"), int), "retain known-title match count"
print("AX-DIAGNOSTIC-THREAD PASS (not feature acceptance)")
