import Foundation

public enum SnapshotError: LocalizedError {
    case localUnavailable
    case malformedProjects

    public var errorDescription: String? {
        switch self {
        case .localUnavailable: "The local Agent Session Viewer API is unavailable."
        case .malformedProjects: "The local Agent Session Viewer returned malformed project data."
        }
    }
}

public struct SnapshotPayload: @unchecked Sendable {
    public let json: [String: Any]
    public let counts: SnapshotCounts
    public let source: String

    public init(json: [String: Any], counts: SnapshotCounts, source: String) {
        self.json = json
        self.counts = counts
        self.source = source
    }
}

public struct LocalSnapshotClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func snapshot(baseURL: URL, maxSessions: Int = 80, tail: Int = 200) async throws -> SnapshotPayload {
        let projectsURL = baseURL.appendingPathComponent("api/projects").appending(queryItems: [.init(name: "maxSessions", value: String(maxSessions))])
        let (data, response) = try await session.data(from: projectsURL)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw SnapshotError.localUnavailable
        }
        guard let projects = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw SnapshotError.malformedProjects
        }
        var sessions: [[String: Any]] = []
        for project in projects {
            guard let projectPath = project["path"] as? String else { continue }
            for sessionMeta in (project["sessions"] as? [[String: Any]]) ?? [] {
                guard let sessionID = sessionMeta["id"] as? String,
                      let url = EndpointBuilder.sessionURL(
                        baseURL: baseURL,
                        projectPath: sessionMeta["projectPath"] as? String ?? projectPath,
                        sessionID: sessionID,
                        tail: tail
                      )
                else { continue }
                var request = URLRequest(url: url, timeoutInterval: 20)
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                guard let (messageData, messageResponse) = try? await session.data(for: request),
                      let messageHTTP = messageResponse as? HTTPURLResponse,
                      (200..<300).contains(messageHTTP.statusCode),
                      let messages = try? JSONSerialization.jsonObject(with: messageData) as? [Any]
                else { continue }
                let total = Int(messageHTTP.value(forHTTPHeaderField: "X-Message-Total") ?? "") ?? messages.count
                sessions.append([
                    "projectPath": sessionMeta["projectPath"] as? String ?? projectPath,
                    "sessionId": sessionID,
                    "messages": messages,
                    "total": total,
                ])
            }
        }
        return SnapshotPayload(
            json: ["projects": projects, "sessions": sessions],
            counts: SnapshotCounts(projects: projects.count, sessions: sessions.count),
            source: "local API"
        )
    }
}
