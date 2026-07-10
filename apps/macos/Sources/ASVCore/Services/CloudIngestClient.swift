import Foundation

public enum CloudIngestError: LocalizedError {
    case invalidResponse
    case rejected(Int, String)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse: "The cloud returned an invalid sync response."
        case let .rejected(status, detail): "Cloud sync failed (HTTP \(status)): \(detail)"
        }
    }
}

public struct CloudIngestClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    public func ingest(_ snapshot: SnapshotPayload, configuration: ConnectionConfiguration) async throws -> SnapshotCounts {
        var request = URLRequest(url: configuration.cloudURL.appendingPathComponent("api/cloud/ingest"), timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("Bearer \(configuration.machineToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: snapshot.json)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CloudIngestError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CloudIngestError.rejected(http.statusCode, String((String(data: data, encoding: .utf8) ?? "Request rejected").prefix(240)))
        }
        if let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return SnapshotCounts(
                projects: body["projects"] as? Int ?? snapshot.counts.projects,
                sessions: body["sessions"] as? Int ?? snapshot.counts.sessions
            )
        }
        return snapshot.counts
    }

    public func validate(configuration: ConnectionConfiguration) async throws {
        var request = URLRequest(url: configuration.cloudURL.appendingPathComponent("api/cloud/status"), timeoutInterval: 15)
        request.setValue("Bearer \(configuration.machineToken)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw CloudIngestError.invalidResponse
        }
    }

    public func pollCommands(configuration: ConnectionConfiguration) async throws -> [CloudCommand] {
        var request = URLRequest(url: configuration.cloudURL.appendingPathComponent("api/cloud/poll"), timeoutInterval: 15)
        request.setValue("Bearer \(configuration.machineToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CloudIngestError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CloudIngestError.rejected(http.statusCode, String((String(data: data, encoding: .utf8) ?? "Request rejected").prefix(240)))
        }
        return try JSONDecoder().decode(CloudCommandEnvelope.self, from: data).commands
    }

    public func completeCommand(
        _ command: CloudCommand,
        configuration: ConnectionConfiguration,
        outcome: CloudCommandOutcome
    ) async throws {
        let url = configuration.cloudURL
            .appendingPathComponent("api/cloud/commands")
            .appendingPathComponent(command.id)
            .appendingPathComponent("complete")
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("Bearer \(configuration.machineToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(outcome)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CloudIngestError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw CloudIngestError.rejected(http.statusCode, String((String(data: data, encoding: .utf8) ?? "Request rejected").prefix(240)))
        }
    }
}

public struct CloudCommandEnvelope: Codable, Equatable, Sendable {
    public let commands: [CloudCommand]
}

public struct CloudCommand: Codable, Equatable, Sendable {
    public let id: String
    public let type: String
    public let payload: CloudCommandPayload
}

public struct CloudCommandPayload: Codable, Equatable, Sendable {
    public let offset: Int?
    public let limit: Int?

    public init(offset: Int? = nil, limit: Int? = nil) {
        self.offset = offset
        self.limit = limit
    }

    public var page: SnapshotPage {
        SnapshotPage(offset: offset ?? SyncPolicy.recentSessionLimit, limit: limit ?? SyncPolicy.recentSessionLimit)
    }
}

public struct CloudCommandOutcome: Codable, Equatable, Sendable {
    public let status: String
    public let projects: Int?
    public let sessions: Int?
    public let error: String?

    public static func completed(_ counts: SnapshotCounts) -> Self {
        Self(status: "completed", projects: counts.projects, sessions: counts.sessions, error: nil)
    }

    public static func failed(_ error: Error) -> Self {
        Self(status: "failed", projects: nil, sessions: nil, error: String(error.localizedDescription.prefix(300)))
    }
}
