import ASVCore
import SwiftUI

struct ContentView: View {
    @ObservedObject var model: ConnectionModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Group {
                if model.isConnected { connectedView } else { onboardingView }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(.regularMaterial)
        .alert("Agent Session Viewer", isPresented: Binding(
            get: { model.notice != nil },
            set: { if !$0 { model.notice = nil } }
        )) {
            Button("OK", role: .cancel) { model.notice = nil }
        } message: {
            Text(model.notice ?? "")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "rectangle.stack.badge.person.crop")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("Agent Session Viewer").font(.headline)
                Text("Private transcript sync for your Mac").foregroundStyle(.secondary)
            }
            Spacer()
            StatusBadge(status: model.syncStatus)
        }
        .padding(20)
    }

    private var onboardingView: some View {
        VStack(spacing: 24) {
            Image(systemName: "icloud.and.arrow.up")
                .font(.system(size: 62, weight: .light))
                .foregroundStyle(.tint)
            VStack(spacing: 8) {
                Text("Connect this Mac").font(.largeTitle.bold())
                Text("Sign in on the Agent Session Viewer website, choose **Connect this Mac**, and allow the app to open the secure one-time link.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 480)
            }
            if model.isConnecting {
                ProgressView("Connecting…")
            } else {
                Button("Open Agent Session Viewer") { openWebsite() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
            Label("The background helper runs even when this window is closed.", systemImage: "checkmark.shield")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(40)
    }

    private var connectedView: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 16) {
                Image(systemName: model.menuBarSymbol)
                    .font(.system(size: 40))
                    .foregroundStyle(model.syncStatus.phase == .failed ? Color.orange : Color.accentColor)
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.machineLabel).font(.title2.bold())
                    Text(model.syncStatus.detail ?? "Background sync is active.").foregroundStyle(.secondary)
                }
            }
            Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 12) {
                GridRow { Text("Cloud").foregroundStyle(.secondary); Text(model.configuration?.cloudURL.host ?? "—") }
                GridRow { Text("Machine ID").foregroundStyle(.secondary); Text(model.configuration?.machineID ?? "—").textSelection(.enabled) }
                GridRow { Text("Source").foregroundStyle(.secondary); Text(model.syncStatus.source ?? "Waiting for sync") }
                GridRow { Text("Sessions").foregroundStyle(.secondary); Text(model.syncStatus.sessions.map(String.init) ?? "—") }
                GridRow { Text("Last synced").foregroundStyle(.secondary); Text(model.syncStatus.lastSuccess?.formatted(date: .abbreviated, time: .standard) ?? "Not yet") }
            }
            .padding(18)
            .background(.background.opacity(0.55), in: RoundedRectangle(cornerRadius: 14))
            HStack {
                Button("Open Dashboard") { model.openDashboard() }.buttonStyle(.borderedProminent)
                Button("Sync Now") { model.syncNow() }.buttonStyle(.bordered)
                Spacer()
                Button("Disconnect", role: .destructive) { model.disconnect() }
            }
        }
        .padding(32)
        .frame(maxWidth: 600)
    }

    private func openWebsite() {
        if let url = URL(string: "https://agent-session-viewer.ainorthstar.tech/setup/mac") {
            NSWorkspace.shared.open(url)
        }
    }
}

private struct StatusBadge: View {
    let status: SyncStatus

    var body: some View {
        Label(label, systemImage: symbol)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }

    private var label: String { status.phase.rawValue.capitalized }
    private var symbol: String {
        switch status.phase {
        case .synced: "checkmark.circle.fill"
        case .syncing: "arrow.triangle.2.circlepath"
        case .failed: "exclamationmark.triangle.fill"
        case .disconnected: "link.badge.plus"
        case .idle: "clock"
        }
    }
    private var color: Color {
        switch status.phase {
        case .synced: .green
        case .failed: .orange
        default: .accentColor
        }
    }
}
