import Foundation

@MainActor enum InstalledProofTests {
    static func run() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("didi-proof-paths-" + UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: root) }
        let state = root.appendingPathComponent("state")
        let report = root.appendingPathComponent("result.json")
        let valid = ["--installed-proof", "--proof-state", state.path, "--proof-report", report.path]
        try LifecycleProof.expect(try InstalledProofRequest.parse(arguments: ["--self-check"]) == nil, "ordinary executable flags do not activate installed proof")
        for invalid in [["--installed-proof"], ["--proof-state", state.path], ["--installed-proof", "--proof-state", "relative", "--proof-report", report.path], valid + ["--installed-proof"], valid + ["--self-check"], ["--installed-proof", "--proof-state", state.path, "--proof-report"]] {
            do { _ = try InstalledProofRequest.parse(arguments: invalid); try LifecycleProof.expect(false, "malformed proof argv must fail") }
            catch { try LifecycleProof.expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "missing/duplicate/relative/foreign proof flags refused") }
        }
        let normal = try InstalledRuntime.applicationState()
        for forbidden in [normal, normal.appendingPathComponent("proof"), normal.deletingLastPathComponent()] {
            let args = ["--installed-proof", "--proof-state", forbidden.path, "--proof-report", report.path]
            do { _ = try InstalledProofRequest.parse(arguments: args); try LifecycleProof.expect(false, "normal data must be forbidden") }
            catch { try LifecycleProof.expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "normal appdata/ancestor/descendant forbidden before launch") }
        }
        let install = UUID().uuidString.lowercased()
        let request = try InstalledProofRequest.parse(arguments: valid)!
        let first = try request.prepare(installId: install)
        try LifecycleProof.expect(!first.reopened, "new proof state has exact owned marker")
        let sentinel = state.appendingPathComponent("preservation-sentinel")
        try Data("Synthetic filesystem sentinel, not a business record".utf8).write(to: sentinel)
        let second = try request.prepare(installId: install)
        try LifecycleProof.expect(second.reopened && second.proofId == first.proofId && fm.fileExists(atPath: sentinel.path), "valid proof state reopens without reseeding/deleting")
        do { _ = try request.prepare(installId: UUID().uuidString.lowercased()); try LifecycleProof.expect(false, "different install must fail") }
        catch { try LifecycleProof.expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "proof marker binds preserved installId") }
        let marker = state.appendingPathComponent("didi-installed-proof.json")
        try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: marker.path)
        do { _ = try request.prepare(installId: install); try LifecycleProof.expect(false, "broad marker mode must fail") }
        catch { try LifecycleProof.expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "proof marker owner-only mode enforced") }
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
        let unmarked = root.appendingPathComponent("unmarked")
        try fm.createDirectory(at: unmarked, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try Data("unrelated data".utf8).write(to: unmarked.appendingPathComponent("foreign"))
        let unmarkedRequest = try InstalledProofRequest.parse(arguments: ["--installed-proof", "--proof-state", unmarked.path, "--proof-report", report.path])!
        do { _ = try unmarkedRequest.prepare(installId: install); try LifecycleProof.expect(false, "existing unmarked data must fail") }
        catch { try LifecycleProof.expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "existing unmarked state never treated as proof data") }
        let link = root.appendingPathComponent("alias")
        try fm.createSymbolicLink(at: link, withDestinationURL: state)
        do { _ = try InstalledProofRequest.parse(arguments: ["--installed-proof", "--proof-state", link.path, "--proof-report", report.path]); try LifecycleProof.expect(false, "symlink state must fail") }
        catch { try LifecycleProof.expect(!(error as NSError).domain.hasPrefix("LifecycleProof"), "proof path symlink refused") }
        print("INSTALLED-PROOF-PATHS PASS realData=untouched marker=lifecycle-only integration=not-claimed")
    }
}
