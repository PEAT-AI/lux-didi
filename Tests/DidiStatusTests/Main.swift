import Foundation

@main struct StatusQuietTests {
    static func main() {
        var calls = 0
        var value = "idle"
        for _ in 0..<20 {
            StatusQuiet.publish(current: value, next: "idle") { value = $0; calls += 1 }
        }
        precondition(calls == 0, "identical ticks must not write")
        StatusQuiet.publish(current: value, next: "active") { value = $0; calls += 1 }
        precondition(calls == 1 && value == "active")
        var ignores = false
        var orbWrites = 0
        for next in [false, false, true, true, false, false] {
            StatusQuiet.publish(current: ignores, next: next) { ignores = $0; orbWrites += 1 }
        }
        precondition(orbWrites == 2)
        print("STATUS-QUIET PASS headless=true")
    }
}
