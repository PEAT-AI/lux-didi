import AppKit

func physicalPath(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { fputs("probe physical path failure\n", stderr); exit(1) }
    defer { free(resolved) }
    return String(cString: resolved)
}
func identity(_ pid: pid_t, nonce: String, bundle: String) throws -> (ProbeIdentity, [String: Any]) {
    var facts = ProbeIdentity()
    var path = [CChar](repeating: 0, count: 4096)
    guard probe_identity(pid, &facts, &path, Int32(path.count)) == 0 else { throw ProbeFailure.invalid("kernel identity errno=\(errno)") }
    return (facts, ["pid": Int(facts.pid), "uid": Int(facts.uid),
        "startSeconds": facts.seconds, "startMicroseconds": facts.microseconds,
        "executable": physicalPath(String(cString: path)), "rawExecutable": String(cString: path), "nonce": nonce, "bundleURL": bundle])
}
func atomic(_ data: [String: Any], to path: String) throws {
    try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]).write(to: URL(fileURLWithPath: path), options: .atomic)
    guard chmod(path, 0o600) == 0 else { throw ProbeFailure.invalid("chmod failed") }
}
enum ProbeFailure: Error { case invalid(String) }
