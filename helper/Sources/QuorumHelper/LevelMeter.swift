import AVFAudio
import Foundation

// loudest of mic and system audio, sent about 12 times a second so the header wave can move with the voices
final class LevelMeter {
    private let lock = NSLock()
    private var peak: Float = 0
    private var last = Date()

    func feed(_ b: AVAudioPCMBuffer) {
        guard let ch = b.floatChannelData?[0], b.frameLength > 0 else { return }
        let n = Int(b.frameLength)
        var sum: Float = 0
        for i in 0..<n { sum += ch[i] * ch[i] }
        let rms = (sum / Float(n)).squareRoot()
        lock.lock()
        defer { lock.unlock() }
        peak = max(peak, rms)
        guard Date().timeIntervalSince(last) >= 0.08 else { return }
        let db = 20 * log10(max(peak, 1e-6))
        let v = min(1, max(0, (db + 55) / 40))
        Emit.send(["event": "level", "v": (Double(v) * 100).rounded() / 100])
        peak = 0
        last = Date()
    }
}
