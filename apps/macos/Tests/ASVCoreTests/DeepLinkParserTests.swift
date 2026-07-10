import XCTest
@testable import ASVCore

final class DeepLinkParserTests: XCTestCase {
    func testParsesFragmentPairingLink() throws {
        let url = try XCTUnwrap(URL(string: "asv://connect#cloud=https%3A%2F%2Fviewer.example.com&pairing=pair_123&machine=Studio%20Mac"))
        let request = try DeepLinkParser.parse(url)
        XCTAssertEqual(request.cloudURL.absoluteString, "https://viewer.example.com")
        XCTAssertEqual(request.pairingCode, "pair_123")
        XCTAssertEqual(request.suggestedMachineLabel, "Studio Mac")
    }

    func testRejectsPairingCodeInQuery() throws {
        let url = try XCTUnwrap(URL(string: "asv://connect?cloud=https%3A%2F%2Fviewer.example.com&pairing=secret"))
        XCTAssertThrowsError(try DeepLinkParser.parse(url)) { error in
            XCTAssertEqual(error as? DeepLinkError, .missingCloudURL)
        }
    }

    func testRejectsInsecureCloudURL() throws {
        let url = try XCTUnwrap(URL(string: "asv://connect#cloud=http%3A%2F%2Fviewer.example.com&pairing=pair_123"))
        XCTAssertThrowsError(try DeepLinkParser.parse(url)) { error in
            XCTAssertEqual(error as? DeepLinkError, .insecureCloudURL)
        }
    }
}
