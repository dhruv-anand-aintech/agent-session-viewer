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
                snapshot = try await localClient.snapshot(baseURL: configuration.localURL, maxSessions: 24, tail: 80)
            } catch {
                snapshot = try fallbackScanner.snapshot(maxSessions: 24, tail: 80)
            }
            let counts = try await cloudClient.ingest(snapshot, configuration: configuration)
            let status = SyncStatus(
                phase: .synced,
                source: snapshot.source,
                projects: counts.projects,
                sessions: counts.sessions,
                lastAttempt: attempt,
                lastSuccess: Date(),
                detail: "Sync completed."
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
}
