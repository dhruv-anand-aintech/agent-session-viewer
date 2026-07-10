import Foundation

public enum SyncPhase: String, Codable, Sendable {
    case idle
    case syncing
    case synced
    case failed
    case disconnected
}

public struct SyncStatus: Codable, Equatable, Sendable {
    public var phase: SyncPhase
    public var source: String?
    public var projects: Int?
    public var sessions: Int?
    public var lastAttempt: Date?
    public var lastSuccess: Date?
    public var detail: String?

    public init(
        phase: SyncPhase,
        source: String? = nil,
        projects: Int? = nil,
        sessions: Int? = nil,
        lastAttempt: Date? = nil,
        lastSuccess: Date? = nil,
        detail: String? = nil
    ) {
        self.phase = phase
        self.source = source
        self.projects = projects
        self.sessions = sessions
        self.lastAttempt = lastAttempt
        self.lastSuccess = lastSuccess
        self.detail = detail
    }
}

public struct SnapshotCounts: Equatable, Sendable {
    public let projects: Int
    public let sessions: Int

    public init(projects: Int, sessions: Int) {
        self.projects = projects
        self.sessions = sessions
    }
}
