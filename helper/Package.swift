// swift-tools-version: 6.0
import PackageDescription
import Foundation

let plist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "QuorumHelper",
    platforms: [.macOS("26.0")],
    dependencies: [
        // on-device speaker separation (Core ML diarization models, Apache 2.0), fetched once to the user's Mac
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.3"),
    ],
    targets: [
        .executableTarget(
            name: "QuorumHelper",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", plist])
            ]
        ),
        .testTarget(
            name: "QuorumHelperTests",
            dependencies: ["QuorumHelper"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
