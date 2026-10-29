#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../.."
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-status-build.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/base"
git archive c77491b713808192e6314babd8b0bdbb3154cbdf Sources/LuxDidi | tar -x -C "$work/base"
compile() {
  local output="$1"; shift
  bash scripts/with-compile-lock.sh -- xcrun swiftc -j 1 -num-threads 1 -whole-module-optimization \
    -D COMPANION_TEST -parse-as-library -module-cache-path "$work/cache" \
    "$@" Tests/DidiStatusTests/Main.swift -o "$output"
}
if compile "$work/base-test" "$work/base"/Sources/LuxDidi/*.swift >"$work/base.log" 2>&1; then
  echo 'STATUS-QUIET BASE FAIL: unexpectedly compiled' >&2; exit 1
fi
grep -q "cannot find 'StatusQuiet' in scope" "$work/base.log"
echo 'STATUS-QUIET BASE RED: missing change-only publishing boundary'
python3 - <<'PYTEST'
from pathlib import Path
app = Path("Sources/LuxDidi/LuxDidiApp.swift").read_text()
poll = app.split("    func refreshLiveCalls() async {", 1)[1].split("    func requestNotificationPermission", 1)[0]
assert "notifications.capability()" not in poll, "poll must use cached notification capability"
assert "notificationStatus.canSchedule" in poll, "delivery must still honor cached capability"
assert "func applicationDidBecomeActive" in app
assert app.count("await model.refreshNotificationCapability(for: .launch)") == 1
assert app.count("await model.refreshNotificationCapability(for: .didBecomeActive)") == 1
assert "await refreshNotificationCapability(for: .poll)" in poll
assert "quietStatusItem.update(" in app
orb = Path("Sources/LuxDidi/NativeMiniOrb.swift").read_text()
assert "StatusQuiet.publish(current: ignoresMouseEvents, next: next)" in orb
assert "Timer(timeInterval: 0.03" not in orb and "clickThroughFollow" not in orb
assert "NSEvent.addLocalMonitorForEvents(matching: movement)" in orb
assert "NSEvent.addGlobalMonitorForEvents(matching: movement)" in orb
assert "return event" in orb
assert "NSEvent.removeMonitor(localMouseMonitor)" in orb
assert "NSEvent.removeMonitor(globalMouseMonitor)" in orb
menu = app.split("    func menuWillOpen(_ menu: NSMenu) {", 1)[1].split("    ///", 1)[0]
assert "recheckSingleKeyGrant()" not in menu and "refreshAccessibilityNotice()" not in menu
assert "menuTracking.opened" in menu
assert "menuTracking.requested" in app
assert "return event" in app and "NSEvent.removeMonitor(statusClickMonitor)" in app
assert "alert.runModal()" not in app and "SingleKeyTrigger.requestGrantNow()" not in app
assert "prompt: { [weak self] in self?.showSingleKeyGrantExplanation() }" in app
assert "RunLoop.main.perform(inModes: [.default])" in app
assert "MiniOrbMenuSafety.availableFrame(screen:" in orb
assert "NSScreen.screens.map(\\.visibleFrame)" not in orb
presentation = Path("Sources/LuxDidi/PresentationCoordinator.swift").read_text()
assert "alert.beginSheetModal(for: parent)" in presentation
assert "alert.window.makeKeyAndOrderFront(nil)" in presentation
assert "runModal()" not in presentation
assert "NSApp.activate" not in menu and "NSApp.activate" not in presentation
print("STATUS-QUIET WIRING PASS capabilityQueriesPerTick=0 launchAndActivation=true")
PYTEST
compile "$work/head-test" Sources/LuxDidi/*.swift
"$work/head-test"
