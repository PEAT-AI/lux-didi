import AppKit

@main @MainActor struct ProbeApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = Delegate()
        app.delegate = delegate
        app.run()
    }
}
@MainActor final class Delegate: NSObject, NSApplicationDelegate {
    var reader: DispatchSourceRead?
    var deadline: DispatchSourceTimer?
    var fd: Int32 = -1
    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = CommandLine.arguments
        if let flag = arguments.firstIndex(of: "--single-instance-hold") {
            if SingleInstanceGuard.yieldToExistingInstance(verification: false) { exit(0) }
            if flag + 1 < arguments.count {
                let root = arguments[flag + 1]
                try? Data("\(getpid())\n".utf8).write(to: URL(fileURLWithPath: root + "/pid-" + String(getpid())))
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { exit(0) }
            return
        }
        do {
            let args = CommandLine.arguments
            guard args.count == 4 else { throw ProbeFailure.invalid("arguments") }
            let root = args[1], nonce = args[2], mode = args[3]
            fd = open(root + "/release.fifo", O_RDWR | O_NONBLOCK)
            guard fd >= 0 else { throw ProbeFailure.invalid("gate open") }
            reader = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
            reader?.setEventHandler { [self] in
                MainActor.assumeIsolated {
                    var bytes = [UInt8](repeating: 0, count: 128)
                    let count = read(fd, &bytes, bytes.count)
                    guard count > 0, String(decoding: bytes.prefix(count), as: UTF8.self) == nonce else { exit(125) }
                    reader?.cancel(); deadline?.cancel(); close(fd)
                    if mode == "signal" { signal(SIGTERM, SIG_DFL); raise(SIGTERM); exit(125) }
                    guard mode == "0" || mode == "42" else { exit(125) }
                    exit(Int32(mode)!)
                }
            }
            reader?.resume()
            deadline = DispatchSource.makeTimerSource(queue: .main)
            deadline?.schedule(deadline: .now() + 8)
            deadline?.setEventHandler { exit(124) }
            deadline?.resume()
            let (_, record) = try identity(getpid(), nonce: nonce, bundle: physicalPath(Bundle.main.bundleURL.path))
            // Identity only: the external kernel observer alone supplies exit status.
            try atomic(record, to: root + "/identity.json")
        } catch { fputs("probe app identity failure\n", stderr); exit(125) }
    }
}
