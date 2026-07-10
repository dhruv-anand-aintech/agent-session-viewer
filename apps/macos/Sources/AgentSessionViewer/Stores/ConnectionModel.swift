import AppKit
import ASVCore
import Foundation
import OSLog

@MainActor
final class ConnectionModel: ObservableObject {
    @Published private(set) var configuration: ConnectionConfiguration?
    @Published private(set) var syncStatus = SyncStatus(phase: .disconnected)
    @Published private(set) var isConnecting = false
    @Published var notice: String?

    private let store = ConfigurationStore()
    private let pairingClient = PairingClient()
    private let launchAgent = LaunchAgentManager()
    private let logger = Logger(subsystem: "tech.ainorthstar.AgentSessionViewer", category: "Connection")
    private var refreshTask: Task<Void, Never>?

    var isConnected: Bool { configuration != nil }
    var machineLabel: String { configuration?.machineLabel ?? Host.current().localizedName ?? "This Mac" }
    var menuBarSymbol: String {
        switch syncStatus.phase {
        case .synced: "checkmark.circle.fill"
        case .syncing: "arrow.triangle.2.circlepath"
        case .failed: "exclamationmark.triangle.fill"
        default: "circle.dashed"
        }
    }

    func start() async {
        configuration = try? store.load()
        refreshStatus()
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                self?.refreshStatus()
            }
        }
    }

    func connect(using url: URL) {
        Task {
            isConnecting = true
            defer { isConnecting = false }
            do {
                let pairing = try DeepLinkParser.parse(url)
                let label = pairing.suggestedMachineLabel ?? Host.current().localizedName ?? "This Mac"
                let claimed = try await pairingClient.claim(pairing, machineLabel: label)
                try store.save(claimed)
                let daemon = try bundledDaemonURL()
                try launchAgent.install(bundledDaemon: daemon)
                configuration = claimed
                notice = "Connected. Background sync is running."
                logger.info("Connected machine \(claimed.machineID, privacy: .public)")
                refreshStatus()
            } catch {
                notice = error.localizedDescription
                logger.error("Connection failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    func syncNow() {
        Task {
            guard configuration != nil else { return }
            do {
                try launchAgent.install(bundledDaemon: try bundledDaemonURL())
                notice = "Sync requested."
            } catch {
                notice = error.localizedDescription
            }
        }
    }

    func disconnect() {
        do {
            try launchAgent.uninstall()
            try store.remove()
            configuration = nil
            syncStatus = SyncStatus(phase: .disconnected)
            notice = "This Mac has been disconnected locally."
        } catch {
            notice = error.localizedDescription
        }
    }

    func openDashboard() {
        guard let cloudURL = configuration?.cloudURL else { return }
        NSWorkspace.shared.open(cloudURL.appendingPathComponent("sessions"))
    }

    func refreshStatus() {
        syncStatus = store.readStatus() ?? SyncStatus(
            phase: configuration == nil ? .disconnected : .idle,
            detail: configuration == nil ? "Connect this Mac from the website." : "Waiting for the first sync."
        )
    }

    private func bundledDaemonURL() throws -> URL {
        guard let executable = Bundle.main.executableURL else { throw LaunchAgentError.missingBundledDaemon }
        let daemon = executable.deletingLastPathComponent().appendingPathComponent("ASVSyncDaemon")
        guard FileManager.default.isExecutableFile(atPath: daemon.path) else { throw LaunchAgentError.missingBundledDaemon }
        return daemon
    }
}
