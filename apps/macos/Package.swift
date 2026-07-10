// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AgentSessionViewerMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AgentSessionViewer", targets: ["AgentSessionViewer"]),
        .executable(name: "ASVSyncDaemon", targets: ["ASVSyncDaemon"]),
        .library(name: "ASVCore", targets: ["ASVCore"]),
    ],
    targets: [
        .target(name: "ASVCore"),
        .executableTarget(name: "AgentSessionViewer", dependencies: ["ASVCore"]),
        .executableTarget(name: "ASVSyncDaemon", dependencies: ["ASVCore"]),
        .testTarget(name: "ASVCoreTests", dependencies: ["ASVCore"]),
    ]
)
