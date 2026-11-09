import CoreAudio
import XCTest
@testable import QuorumHelper

final class AudioRouteTests: XCTestCase {
    private func code(_ s: String) -> UInt32 { s.utf8.reduce(0) { $0 << 8 | UInt32($1) } }

    func testBuiltInSpeakers() {
        XCTAssertEqual(AudioRoute.classify(transport: kAudioDeviceTransportTypeBuiltIn, source: code("ispk")), "speakers")
        XCTAssertEqual(AudioRoute.classify(transport: kAudioDeviceTransportTypeBuiltIn, source: nil), "speakers")
    }

    func testBuiltInHeadphoneJack() {
        XCTAssertEqual(AudioRoute.classify(transport: kAudioDeviceTransportTypeBuiltIn, source: code("hdpn")), "headphones")
    }

    func testExternalTransports() {
        for t in [kAudioDeviceTransportTypeUSB, kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE,
                  kAudioDeviceTransportTypeDisplayPort, kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeAirPlay,
                  kAudioDeviceTransportTypeThunderbolt, kAudioDeviceTransportTypeVirtual] {
            XCTAssertEqual(AudioRoute.classify(transport: t, source: nil), "external", AudioRoute.tag(t))
            XCTAssertEqual(AudioRoute.classify(transport: t, source: code("hdpn")), "external", "the jack code only means the jack on the built-in device")
        }
    }

    func testNoDevice() {
        XCTAssertEqual(AudioRoute.classify(transport: nil, source: nil), "unknown")
        XCTAssertEqual(AudioRoute.classify(transport: nil, source: code("hdpn")), "unknown")
    }

    func testTransportTag() {
        XCTAssertEqual(AudioRoute.tag(kAudioDeviceTransportTypeBuiltIn), "bltn")
        XCTAssertEqual(AudioRoute.tag(kAudioDeviceTransportTypeUSB), "usb ")
        XCTAssertEqual(AudioRoute.tag(kAudioDeviceTransportTypeBluetooth), "blue")
        XCTAssertEqual(AudioRoute.tag(kAudioDeviceTransportTypeAirPlay), "airp")
    }
}
