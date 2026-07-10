import XCTest
@testable import ASVCore

final class EndpointBuilderTests: XCTestCase {
    func testEncodesProjectAndSessionAsSinglePathSegments() throws {
        let url = try XCTUnwrap(EndpointBuilder.sessionURL(
            baseURL: URL(string: "http://127.0.0.1:3001")!,
            projectPath: "/Users/D/Code/My App",
            sessionID: "child/session",
            tail: 200
        ))
        XCTAssertEqual(url.absoluteString, "http://127.0.0.1:3001/api/session/%2FUsers%2FD%2FCode%2FMy%20App/child%2Fsession?tail=200")
    }
}
