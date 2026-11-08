// swift-tools-version: 6.0
import PackageDescription
import Foundation

let plist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "QuorumHelper",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "QuorumHelper",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist])
            ]
        )
    ]
)
