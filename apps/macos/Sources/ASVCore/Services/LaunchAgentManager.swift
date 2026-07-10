import Foundation

public enum LaunchAgentError: LocalizedError {
    case missingBundledDaemon
    case commandFailed(String)

    public var errorDescription: String? {
        switch self {
        case .missingBundledDaemon: "The sync helper is missing from this app build."
        case let .commandFailed(detail): "Could not update the background sync service: \(detail)"
        }
    }
}

public struct LaunchAgentManager: @unchecked Sendable {
    public static let label = "tech.ainorthstar.AgentSessionViewer.sync"
    public let paths: ASVPaths
    private let fileManager: FileManager

    public init(paths: ASVPaths = ASVPaths(), fileManager: FileManager = .default) {
        self.paths = paths
        self.fileManager = fileManager
    }

    public func install(bundledDaemon: URL) throws {
        guard fileManager.isExecutableFile(atPath: bundledDaemon.path) else { throw LaunchAgentError.missingBundledDaemon }
        try fileManager.createDirectory(at: paths.daemonDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fileManager.createDirectory(at: paths.launchAgents, withIntermediateDirectories: true)
        if fileManager.fileExists(atPath: paths.daemon.path) { try fileManager.removeItem(at: paths.daemon) }
        try fileManager.copyItem(at: bundledDaemon, to: paths.daemon)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.daemon.path)
        let plist: [String: Any] = [
            "Label": Self.label,
            "ProgramArguments": [paths.daemon.path],
            "RunAtLoad": true,
            "KeepAlive": true,
            "ThrottleInterval": 15,
            "StandardOutPath": paths.stdoutLog.path,
            "StandardErrorPath": paths.stderrLog.path,
            "ProcessType": "Background",
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: paths.launchAgent, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.launchAgent.path)
        _ = try? runLaunchctl(["bootout", "gui/\(getuid())/\(Self.label)"])
        try runLaunchctl(["bootstrap", "gui/\(getuid())", paths.launchAgent.path])
        try runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(Self.label)"])
    }

    public func uninstall() throws {
        _ = try? runLaunchctl(["bootout", "gui/\(getuid())/\(Self.label)"])
        for path in [paths.launchAgent, paths.daemon] where fileManager.fileExists(atPath: path.path) {
            try fileManager.removeItem(at: path)
        }
    }

    public func isInstalled() -> Bool {
        fileManager.fileExists(atPath: paths.launchAgent.path) && fileManager.isExecutableFile(atPath: paths.daemon.path)
    }

    @discardableResult
    private func runLaunchctl(_ arguments: [String]) throws -> String {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else { throw LaunchAgentError.commandFailed(String(output.prefix(300))) }
        return output
    }
}
