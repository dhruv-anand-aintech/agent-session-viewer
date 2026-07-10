import Foundation

public struct ASVPaths: Sendable {
    public let applicationSupport: URL
    public let launchAgents: URL

    public init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) {
        applicationSupport = homeDirectory
            .appendingPathComponent("Library/Application Support/AgentSessionViewer", isDirectory: true)
        launchAgents = homeDirectory.appendingPathComponent("Library/LaunchAgents", isDirectory: true)
    }

    public var configuration: URL { applicationSupport.appendingPathComponent("config.json") }
    public var status: URL { applicationSupport.appendingPathComponent("status.json") }
    public var daemonDirectory: URL { applicationSupport.appendingPathComponent("bin", isDirectory: true) }
    public var daemon: URL { daemonDirectory.appendingPathComponent("ASVSyncDaemon") }
    public var stdoutLog: URL { applicationSupport.appendingPathComponent("sync.log") }
    public var stderrLog: URL { applicationSupport.appendingPathComponent("sync-error.log") }
    public var launchAgent: URL { launchAgents.appendingPathComponent("tech.ainorthstar.AgentSessionViewer.sync.plist") }
}

public struct ConfigurationStore: @unchecked Sendable {
    public let paths: ASVPaths
    private let fileManager: FileManager

    public init(paths: ASVPaths = ASVPaths(), fileManager: FileManager = .default) {
        self.paths = paths
        self.fileManager = fileManager
    }

    public func load() throws -> ConnectionConfiguration? {
        guard fileManager.fileExists(atPath: paths.configuration.path) else { return nil }
        return try JSONDecoder().decode(ConnectionConfiguration.self, from: Data(contentsOf: paths.configuration))
    }

    public func save(_ configuration: ConnectionConfiguration) throws {
        try fileManager.createDirectory(at: paths.applicationSupport, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder.asv.encode(configuration)
        try data.write(to: paths.configuration, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.configuration.path)
    }

    public func remove() throws {
        if fileManager.fileExists(atPath: paths.configuration.path) {
            try fileManager.removeItem(at: paths.configuration)
        }
    }

    public func readStatus() -> SyncStatus? {
        guard let data = try? Data(contentsOf: paths.status) else { return nil }
        return try? JSONDecoder.asv.decode(SyncStatus.self, from: data)
    }

    public func writeStatus(_ status: SyncStatus) throws {
        try fileManager.createDirectory(at: paths.applicationSupport, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder.asv.encode(status).write(to: paths.status, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: paths.status.path)
    }
}

extension JSONEncoder {
    static var asv: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}

extension JSONDecoder {
    static var asv: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
