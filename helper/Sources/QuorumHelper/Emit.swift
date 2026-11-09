import Foundation

// stdout is the protocol channel: one JSON object per line
enum Emit {
    private static let lock = NSLock()
    // the app reads stdout; tests point this at a pipe
    static var output = FileHandle.standardOutput

    static func send(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return }
        lock.lock()
        output.write(data)
        output.write("\n".data(using: .utf8)!)
        lock.unlock()
    }

    static func status(_ msg: String, _ extra: [String: Any] = [:]) {
        send(["event": "status", "message": msg].merging(extra) { a, _ in a })
    }

    static func error(_ msg: String) {
        send(["event": "error", "message": msg])
    }

    static func log(_ msg: String) {
        FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    }
}
