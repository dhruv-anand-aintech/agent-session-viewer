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
}
