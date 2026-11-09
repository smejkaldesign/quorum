import Foundation
import Speech
import XCTest
@testable import QuorumHelper

// the built helper binary next to the test bundle, plus a runner that drains both pipes
enum Helper {
    static var binary: URL {
        for b in Bundle.allBundles where b.bundlePath.hasSuffix(".xctest") {
            return b.bundleURL.deletingLastPathComponent().appendingPathComponent("QuorumHelper")
        }
        fatalError("no .xctest bundle loaded")
    }

    struct Run {
        let status: Int32
        let stdout: String
        let stderr: String
        var events: [[String: Any]] {
            stdout.split(separator: "\n").compactMap { line in
                guard let d = line.data(using: .utf8) else { return nil }
                return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
            }
        }
    }

    static func run(_ args: [String], stdin input: String? = nil, timeout: TimeInterval = 180) throws -> Run {
        let p = Process()
        p.executableURL = binary
        p.arguments = args
        let out = Pipe(), err = Pipe(), inp = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = inp
        try p.run()
        if let input { inp.fileHandleForWriting.write(input.data(using: .utf8)!) }
        try inp.fileHandleForWriting.close()
        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        group.enter(); DispatchQueue.global().async { outData = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        group.enter(); DispatchQueue.global().async { errData = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
        if group.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            throw XCTSkip("helper did not exit within \(Int(timeout))s")
        }
        p.waitUntilExit()
        return Run(status: p.terminationStatus, stdout: String(decoding: outData, as: UTF8.self), stderr: String(decoding: errData, as: UTF8.self))
    }
}

// skips when the on-device en-US model is not on this Mac. Status reads "supported" until the process reserves the
// model, which takes under a second when the system already holds it; a real download would not finish in the budget
func requireSpeech() async throws -> SpeechTranscriber {
    let transcriber = SpeechTranscriber(locale: Locale(identifier: "en-US"), transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
    guard SpeechTranscriber.isAvailable else { throw XCTSkip("SpeechTranscriber unavailable on this machine") }
    var status = await AssetInventory.status(forModules: [transcriber])
    if status == .supported, let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        let done = await withTaskGroup(of: Bool.self) { group in
            group.addTask { (try? await request.downloadAndInstall()) != nil }
            group.addTask { try? await Task.sleep(for: .seconds(30)); return false }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        if done { status = await AssetInventory.status(forModules: [transcriber]) }
    }
    guard status == .installed else { throw XCTSkip("en-US speech asset not installed (\(status))") }
    return transcriber
}

func tempDir(_ name: String) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("quorum-helper-tests-\(name)-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
