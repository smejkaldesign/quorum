import AudioToolbox
import AVFAudio
import CoreAudio
import Foundation

final class MicCapture {
    private let engine = AVAudioEngine()

    func start(echoCancel: Bool, handler: @escaping (AVAudioPCMBuffer) -> Void) throws {
        let input = engine.inputNode
        if echoCancel { try input.setVoiceProcessingEnabled(true) }
        let fmt = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { buffer, _ in handler(buffer) }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

// Core Audio process tap over everything the Mac plays (the "them" side of a call)
final class SystemTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "quorum.systemtap", qos: .userInitiated)

    // bundles narrows the tap to the meeting app's processes (Zoom plays audio from helper processes too, hence prefixes);
    // if none are running it falls back to everything the Mac plays. Mono because the transcriber wants one channel anyway
    func start(bundles: [String] = [], handler: @escaping (AVAudioPCMBuffer) -> Void) throws {
        let procs = bundles.isEmpty ? [] : processObjects(matching: bundles)
        if !bundles.isEmpty { Emit.status(procs.isEmpty ? "meeting app audio not found, hearing all system audio" : "hearing \(procs.count) meeting app audio process(es)") }
        let desc = procs.isEmpty ? CATapDescription(monoGlobalTapButExcludeProcesses: []) : CATapDescription(monoMixdownOfProcesses: procs)
        desc.uuid = UUID()
        desc.muteBehavior = .unmuted
        desc.isPrivate = true
        try check(AudioHardwareCreateProcessTap(desc, &tapID), "create process tap")

        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var addr = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        try check(AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd), "read tap format")
        guard let format = AVAudioFormat(streamDescription: &asbd) else { throw err("tap format unsupported") }

        var outputID = AudioObjectID(kAudioObjectUnknown)
        size = UInt32(MemoryLayout<AudioObjectID>.size)
        addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &outputID), "default output device")

        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        try check(AudioObjectGetPropertyData(outputID, &addr, 0, nil, &size, &uid), "output device uid")
        guard let outputUID = uid?.takeRetainedValue() as String? else { throw err("no output uid") }

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Quorum Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
        ]
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "create aggregate device")

        try check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
            handler(buffer)
        }, "create io proc")
        try check(AudioDeviceStart(aggregateID, procID), "start aggregate device")
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, procID)
            if let procID { AudioDeviceDestroyIOProcID(aggregateID, procID) }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    private func processObjects(matching prefixes: [String]) -> [AudioObjectID] {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.filter { id in
            var a = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var bid: Unmanaged<CFString>?
            var s = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(id, &a, 0, nil, &s, &bid) == noErr, let b = bid?.takeRetainedValue() as String? else { return false }
            return prefixes.contains { b.hasPrefix($0) }
        }
    }

    private func check(_ status: OSStatus, _ what: String) throws {
        if status != noErr { throw err("\(what) failed (OSStatus \(status))") }
    }

    private func err(_ msg: String) -> NSError {
        NSError(domain: "quorum", code: 2, userInfo: [NSLocalizedDescriptionKey: msg])
    }
}
