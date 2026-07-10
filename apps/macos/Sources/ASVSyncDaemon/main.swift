import ASVCore
import Foundation
import OSLog

private let logger = Logger(subsystem: "tech.ainorthstar.AgentSessionViewer", category: "Sync")
private let engine = SyncEngine()
private let interval: UInt64 = 60_000_000_000

let semaphore = DispatchSemaphore(value: 0)
Task {
    while !Task.isCancelled {
        let status = await engine.syncOnce()
        switch status.phase {
        case .synced:
            logger.info("Sync completed via \(status.source ?? "unknown", privacy: .public): \(status.sessions ?? 0) sessions")
        case .failed:
            logger.error("Sync failed: \(status.detail ?? "unknown error", privacy: .public)")
        case .disconnected:
            logger.notice("Sync is waiting for this Mac to be connected")
        default:
            break
        }
        try? await Task.sleep(nanoseconds: interval)
    }
    semaphore.signal()
}
semaphore.wait()
