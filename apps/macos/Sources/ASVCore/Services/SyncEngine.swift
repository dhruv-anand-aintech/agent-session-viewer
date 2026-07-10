import Foundation

public struct SyncEngine: Sendable {
    private let store: ConfigurationStore
    private let localClient: LocalSnapshotClient
    private let fallbackScanner: TranscriptFallbackScanner
    private let cloudClient: CloudIngestClient

    public init(
        store: ConfigurationStore = ConfigurationStore(),
        localClient: LocalSnapshotClient = LocalSnapshotClient(),
        fallbackScanner: TranscriptFallbackScanner = TranscriptFallbackScanner(),
        cloudClient: CloudIngestClient = CloudIngestClient()
    ) {
        self.store = store
        self.localClient = localClient
        self.fallbackScanner = fallbackScanner
        self.cloudClient = cloudClient
    }

    public func syncOnce() async -> SyncStatus {
        guard let configuration = try? store.load() else {
            let status = SyncStatus(phase: .disconnected, detail: "Connect this Mac from the website first.")
            try? store.writeStatus(status)
            return status
        }
        let attempt = Date()
        let previousSuccess = store.readStatus()?.lastSuccess
        try? store.writeStatus(SyncStatus(phase: .syncing, lastAttempt: attempt, lastSuccess: previousSuccess))
        do {
            let snapshot: SnapshotPayload
            do {
                snapshot = try await localClient.snapshot(
                    baseURL: configuration.localURL,
                    offset: 0,
                    limit: SyncPolicy.recentSessionLimit,
                    tail: SyncPolicy.sessionTail
                )
            } catch {
                snapshot = try fallbackScanner.snapshot(
                    offset: 0,
                    limit: SyncPolicy.recentSessionLimit,
                    tail: SyncPolicy.sessionTail
                )
            }
            let counts = try await cloudClient.ingest(snapshot, configuration: configuration)
            let commandDetail = await processCommands(configuration: configuration)
            let status = SyncStatus(
                phase: .synced,
                source: snapshot.source,
                projects: counts.projects,
                sessions: counts.sessions,
                lastAttempt: attempt,
                lastSuccess: Date(),
                detail: commandDetail ?? "Sync completed."
            )
            try? store.writeStatus(status)
            return status
        } catch {
            let status = SyncStatus(
                phase: .failed,
                lastAttempt: attempt,
                lastSuccess: previousSuccess,
                detail: String(error.localizedDescription.prefix(300))
            )
            try? store.writeStatus(status)
            return status
        }
    }

    private func processCommands(configuration: ConnectionConfiguration) async -> String? {
        let commands: [CloudCommand]
        do {
            commands = try await cloudClient.pollCommands(configuration: configuration)
        } catch {
            return "Recent sessions synced; command polling failed: \(String(error.localizedDescription.prefix(180)))"
        }

        var loaded = 0
        for command in commands {
            guard Self.isLoadMoreCommand(command.type) else { continue }
            do {
                let page = command.payload.page
                let snapshot: SnapshotPayload
                do {
                    snapshot = try await localClient.snapshot(
                        baseURL: configuration.localURL,
                        offset: page.offset,
                        limit: page.limit,
                        tail: SyncPolicy.sessionTail
                    )
                } catch {
                    snapshot = try fallbackScanner.snapshot(
                        offset: page.offset,
                        limit: page.limit,
                        tail: SyncPolicy.sessionTail
                    )
                }
                let counts = try await cloudClient.ingest(snapshot, configuration: configuration)
                try await cloudClient.completeCommand(command, configuration: configuration, outcome: .completed(counts))
                loaded += counts.sessions
            } catch {
                try? await cloudClient.completeCommand(command, configuration: configuration, outcome: .failed(error))
            }
        }
        return loaded > 0 ? "Sync completed; loaded \(loaded) older sessions." : nil
    }

    static func isLoadMoreCommand(_ type: String) -> Bool {
        ["sessions.load_more", "sessions.loadMore", "load_more_sessions"].contains(type)
    }
}
