import AppKit
import SwiftUI

struct MenuBarView: View {
    @ObservedObject var model: ConnectionModel
    let openMainWindow: () -> Void

    var body: some View {
        Text(model.isConnected ? model.syncStatus.phase.rawValue.capitalized : "Not connected")
        if let lastSuccess = model.syncStatus.lastSuccess {
            Text("Synced \(lastSuccess.formatted(.relative(presentation: .named)))")
        }
        Divider()
        Button("Open Agent Session Viewer") {
            openMainWindow()
        }
        .keyboardShortcut("o")
        if model.isConnected {
            Button("Sync Now") { model.syncNow() }
            Button("Open Cloud Dashboard") { model.openDashboard() }
        }
        Divider()
        Button("Quit") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q")
    }
}
