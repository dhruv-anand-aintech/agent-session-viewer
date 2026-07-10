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

public enum SyncPolicy {
    public static let recentSessionLimit = 30
    public static let sessionTail = 80
}

public struct SnapshotPage: Codable, Equatable, Sendable {
    public let offset: Int
    public let limit: Int
    public let sourceTotal: Int?
    public let hasMore: Bool?

    public init(offset: Int, limit: Int, sourceTotal: Int? = nil, hasMore: Bool? = nil) {
        self.offset = max(0, offset)
        self.limit = max(1, min(limit, SyncPolicy.recentSessionLimit))
        self.sourceTotal = sourceTotal
        self.hasMore = hasMore
    }

    var json: [String: Any] {
        var value: [String: Any] = ["offset": offset, "limit": limit]
        if let sourceTotal { value["sourceTotal"] = sourceTotal }
        if let hasMore { value["hasMore"] = hasMore }
        return value
    }
}

public struct LocalSnapshotClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func snapshot(baseURL: URL, offset: Int = 0, limit: Int = 80, tail: Int = 200) async throws -> SnapshotPayload {
        let page = SnapshotPage(offset: offset, limit: limit)
        let requestedSessions = page.offset + page.limit
        let projectsURL = baseURL.appendingPathComponent("api/projects").appending(queryItems: [.init(name: "maxSessions", value: String(requestedSessions))])
        let (data, response) = try await session.data(from: projectsURL)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw SnapshotError.localUnavailable
        }
        guard let projects = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw SnapshotError.malformedProjects
        }
        let selectedProjects = Self.selectPage(projects: projects, page: page)
        let sourceTotal = Int(http.value(forHTTPHeaderField: "X-Total-Sessions") ?? "")
        let responsePage = SnapshotPage(
            offset: page.offset,
            limit: page.limit,
            sourceTotal: sourceTotal,
            hasMore: sourceTotal.map { $0 > page.offset + page.limit }
        )
        var sessions: [[String: Any]] = []
        for project in selectedProjects {
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
            json: ["projects": selectedProjects, "sessions": sessions, "page": responsePage.json],
            counts: SnapshotCounts(projects: selectedProjects.count, sessions: sessions.count),
            source: "local API"
        )
    }

    static func selectPage(projects: [[String: Any]], page: SnapshotPage) -> [[String: Any]] {
        struct Entry {
            let projectIndex: Int
            let sessionIndex: Int
            let activity: String
            let session: [String: Any]
        }

        let flattened = projects.enumerated().flatMap { projectIndex, project -> [Entry] in
            ((project["sessions"] as? [[String: Any]]) ?? []).enumerated().map { sessionIndex, session in
                Entry(
                    projectIndex: projectIndex,
                    sessionIndex: sessionIndex,
                    activity: session["lastActivity"] as? String ?? "",
                    session: session
                )
            }
        }.sorted { lhs, rhs in
            if lhs.activity != rhs.activity { return lhs.activity > rhs.activity }
            if lhs.projectIndex != rhs.projectIndex { return lhs.projectIndex < rhs.projectIndex }
            return lhs.sessionIndex < rhs.sessionIndex
        }

        let selected = flattened.dropFirst(page.offset).prefix(page.limit)
        let sessionsByProject = Dictionary(grouping: selected, by: \.projectIndex)
        return projects.enumerated().compactMap { projectIndex, project in
            guard let entries = sessionsByProject[projectIndex], !entries.isEmpty else { return nil }
            var result = project
            result["sessions"] = entries.map(\.session)
            return result
        }
    }
}
