import XCTest
@testable import ASVCore

final class ConfigurationStoreTests: XCTestCase {
    func testConfigurationIsWrittenWithOwnerOnlyPermissions() throws {
        let temporaryHome = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: temporaryHome) }
        let store = ConfigurationStore(paths: ASVPaths(homeDirectory: temporaryHome))
        let configuration = ConnectionConfiguration(
            cloudURL: URL(string: "https://viewer.example.com")!,
            machineID: "machine_1",
            machineToken: "secret",
            machineLabel: "Test Mac"
        )
        try store.save(configuration)
        XCTAssertEqual(try store.load(), configuration)
        let attributes = try FileManager.default.attributesOfItem(atPath: store.paths.configuration.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }
}
