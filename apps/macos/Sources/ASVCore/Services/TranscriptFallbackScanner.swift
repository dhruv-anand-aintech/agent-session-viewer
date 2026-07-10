import Foundation

public struct TranscriptFallbackScanner: @unchecked Sendable {
    public let homeDirectory: URL
    private let fileManager: FileManager

    public init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser, fileManager: FileManager = .default) {
        self.homeDirectory = homeDirectory
        self.fileManager = fileManager
    }

    public func snapshot(offset: Int = 0, limit: Int = 80, tail: Int = 200) throws -> SnapshotPayload {
        let page = SnapshotPage(offset: offset, limit: limit)
        let claudeRoot = homeDirectory.appendingPathComponent(".claude/projects", isDirectory: true)
        let codexRoot = homeDirectory.appendingPathComponent(".codex/sessions", isDirectory: true)
        let files = (jsonlFiles(under: claudeRoot, source: "claude") + jsonlFiles(under: codexRoot, source: "codex"))
            .sorted { $0.modified > $1.modified }

        var projectsByPath: [String: [[String: Any]]] = [:]
        var payloadSessions: [[String: Any]] = []
        var validSessionIndex = 0
        var hasMore = false
        for file in files {
            guard let parsed = parse(file: file, tail: tail), !parsed.messages.isEmpty else { continue }
            if validSessionIndex < page.offset {
                validSessionIndex += 1
                continue
            }
            if payloadSessions.count >= page.limit {
                hasMore = true
                break
            }
            validSessionIndex += 1
            projectsByPath[parsed.projectPath, default: []].append(parsed.metadata)
            payloadSessions.append([
                "projectPath": parsed.projectPath,
                "sessionId": parsed.sessionID,
                "messages": parsed.messages,
                "total": parsed.total,
            ])
        }
        let projects = projectsByPath.map { path, sessions in
            ["path": path, "name": URL(fileURLWithPath: path).lastPathComponent, "sessions": sessions] as [String: Any]
        }.sorted { ($0["path"] as? String ?? "") < ($1["path"] as? String ?? "") }
        let responsePage = SnapshotPage(offset: page.offset, limit: page.limit, hasMore: hasMore)
        return SnapshotPayload(
            json: ["projects": projects, "sessions": payloadSessions, "page": responsePage.json],
            counts: SnapshotCounts(projects: projects.count, sessions: payloadSessions.count),
            source: "transcript fallback"
        )
    }

    private struct TranscriptFile {
        let url: URL
        let source: String
        let modified: Date
    }

    private struct ParsedTranscript {
        let projectPath: String
        let sessionID: String
        let metadata: [String: Any]
        let messages: [Any]
        let total: Int
    }

    private func jsonlFiles(under root: URL, source: String) -> [TranscriptFile] {
        guard let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return [] }
        return enumerator.compactMap { value in
            guard let url = value as? URL, url.pathExtension == "jsonl",
                  let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey]),
                  values.isRegularFile == true
            else { return nil }
            return TranscriptFile(url: url, source: source, modified: values.contentModificationDate ?? .distantPast)
        }
    }

    private func parse(file: TranscriptFile, tail: Int) -> ParsedTranscript? {
        guard let text = try? String(contentsOf: file.url, encoding: .utf8) else { return nil }
        let records = text.split(whereSeparator: \ .isNewline).compactMap { line -> [String: Any]? in
            guard let data = String(line).data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
        let projectPath: String
        let messages: [[String: Any]]
        if file.source == "claude" {
            projectPath = file.url.deletingLastPathComponent().path
            messages = records.filter(Self.isClaudeMessage)
        } else {
            projectPath = Self.codexProjectPath(records: records) ?? "Codex"
            messages = records.compactMap(Self.normalizedCodexMessage)
        }
        guard !messages.isEmpty else { return nil }
        let base = file.url.deletingPathExtension().lastPathComponent
        let sessionID = Self.sessionID(from: base)
        let timestamp = ISO8601DateFormatter().string(from: file.modified)
        let firstName = Self.firstText(in: messages.first) ?? sessionID
        let metadata: [String: Any] = [
            "id": sessionID,
            "projectPath": projectPath,
            "lastActivity": timestamp,
            "messageCount": messages.count,
            "userMessageCount": messages.filter { (($0["message"] as? [String: Any])?["role"] as? String) == "user" }.count,
            "firstName": String(firstName.prefix(120)),
            "source": file.source,
        ]
        return ParsedTranscript(
            projectPath: projectPath,
            sessionID: sessionID,
            metadata: metadata,
            messages: Array(messages.suffix(tail)),
            total: messages.count
        )
    }

    private static func isClaudeMessage(_ record: [String: Any]) -> Bool {
        guard let type = record["type"] as? String, ["human", "user", "assistant"].contains(type),
              let message = record["message"] as? [String: Any],
              let role = message["role"] as? String, ["user", "assistant"].contains(role)
        else { return false }
        return firstText(in: record) != nil
    }

    private static func normalizedCodexMessage(_ record: [String: Any]) -> [String: Any]? {
        guard record["type"] as? String == "response_item",
              let payload = record["payload"] as? [String: Any],
              payload["type"] as? String == "message",
              let role = payload["role"] as? String, ["user", "assistant"].contains(role),
              firstText(in: ["message": payload]) != nil
        else { return nil }
        var normalized: [String: Any] = [
            "type": role == "assistant" ? "assistant" : "human",
            "message": payload,
        ]
        if let timestamp = record["timestamp"] { normalized["timestamp"] = timestamp }
        return normalized
    }

    private static func codexProjectPath(records: [[String: Any]]) -> String? {
        for record in records where record["type"] as? String == "session_meta" {
            if let payload = record["payload"] as? [String: Any], let cwd = payload["cwd"] as? String { return cwd }
        }
        return nil
    }

    private static func sessionID(from filename: String) -> String {
        let pattern = #"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"#
        guard let range = filename.range(of: pattern, options: .regularExpression) else { return filename }
        return String(filename[range])
    }

    private static func firstText(in record: [String: Any]?) -> String? {
        guard let message = record?["message"] as? [String: Any] else { return nil }
        if let content = message["content"] as? String {
            let clean = content.trimmingCharacters(in: .whitespacesAndNewlines)
            return clean.isEmpty ? nil : clean
        }
        guard let blocks = message["content"] as? [[String: Any]] else { return nil }
        for block in blocks {
            for key in ["text", "input_text", "output_text"] {
                if let text = block[key] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
            }
        }
        return nil
    }
}
