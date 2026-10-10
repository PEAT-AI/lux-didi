"""Verify same-process connected WebKit AX is consumed on AppKit's thread.

Input is the private installed-proof diagnostic sidecar, not the R10 wire.
This is diagnostic evidence only, never faithful capture or feature acceptance.
"""
import json
import sys

with open(sys.argv[1], encoding="utf-8") as report:
    evidence = json.load(report)["axConsumer"]
assert evidence.get("queryOnMainThread") is True, "connected WebKit AX must run on AppKit thread"
assert isinstance(evidence.get("identifierStatuses"), list), "retain exact identifier AXError statuses"
assert isinstance(evidence.get("identifierMatches"), int), "retain owned-identifier match count"
print("AX-DIAGNOSTIC-THREAD PASS (not feature acceptance)")
