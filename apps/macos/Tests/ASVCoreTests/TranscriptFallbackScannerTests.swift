import XCTest
@testable import ASVCore

final class TranscriptFallbackScannerTests: XCTestCase {
    func testSkipsEmptyClaudeTranscriptAndIncludesMessageTranscript() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let project = home.appendingPathComponent(".claude/projects/-Users-D-Code-App", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try #"{"type":"file-history-snapshot","snapshot":{}}"#.write(to: project.appendingPathComponent("empty.jsonl"), atomically: true, encoding: .utf8)
        let transcript = #"{"type":"human","timestamp":"2026-07-10T00:00:00Z","message":{"role":"user","content":"Build it"}}"#
        try transcript.write(to: project.appendingPathComponent("session-1.jsonl"), atomically: true, encoding: .utf8)

        let snapshot = try TranscriptFallbackScanner(homeDirectory: home).snapshot()
        XCTAssertEqual(snapshot.counts.sessions, 1)
        XCTAssertEqual(snapshot.counts.projects, 1)
    }

    func testNormalizesCodexMessages() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let directory = home.appendingPathComponent(".codex/sessions/2026/07/10", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let transcript = [
            #"{"type":"session_meta","payload":{"cwd":"/Users/D/Code/App"}}"#,
            #"{"type":"response_item","timestamp":"2026-07-10T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Ship it"}]}}"#,
        ].joined(separator: "\n")
        try transcript.write(to: directory.appendingPathComponent("rollout-2026-07-10T00-00-00-00000000-0000-0000-0000-000000000001.jsonl"), atomically: true, encoding: .utf8)

        let snapshot = try TranscriptFallbackScanner(homeDirectory: home).snapshot()
        XCTAssertEqual(snapshot.counts.sessions, 1)
        let sessions = snapshot.json["sessions"] as? [[String: Any]]
        XCTAssertEqual(sessions?.first?["sessionId"] as? String, "00000000-0000-0000-0000-000000000001")
    }
}
