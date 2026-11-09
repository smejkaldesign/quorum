import Foundation

// argument shapes of the one-shot commands, apart from main.swift so tests can check them without running anything
enum CLI {
    struct TranscribeJob: Equatable {
        let me: URL
        let them: URL?
        let terms: [String]
    }

    // test-capture <sec>: 10 when absent or not a number
    static func captureSeconds(_ args: [String]) -> Double {
        args.count > 2 ? Double(args[2]) ?? 10 : 10
    }

    // transcribe-file <me.wav> [them.wav] [--terms term ...]: nil when no file comes before --terms
    static func transcribeJob(_ args: [String]) -> TranscribeJob? {
        let rest = args.dropFirst(2)
        let paths = rest.prefix { $0 != "--terms" }
        guard let first = paths.first else { return nil }
        let terms = Array(rest.drop { $0 != "--terms" }.dropFirst())
        return TranscribeJob(me: URL(fileURLWithPath: first), them: paths.dropFirst().first.map { URL(fileURLWithPath: $0) }, terms: terms)
    }
}
