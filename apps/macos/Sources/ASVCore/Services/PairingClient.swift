import Foundation

public enum PairingClientError: LocalizedError {
    case invalidResponse
    case rejected(Int, String)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse: "The cloud returned an invalid pairing response."
        case let .rejected(status, detail): "Pairing failed (HTTP \(status)): \(detail)"
        }
    }
}

public struct PairingClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func claim(_ request: PairingRequest, machineLabel: String) async throws -> ConnectionConfiguration {
        let endpoint = request.cloudURL.appendingPathComponent("api/cloud/claim")
        var urlRequest = URLRequest(url: endpoint, timeoutInterval: 20)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "pairingCode": request.pairingCode,
            "label": machineLabel,
        ])
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw PairingClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let detail = String(data: data, encoding: .utf8) ?? "Request rejected"
            throw PairingClientError.rejected(http.statusCode, String(detail.prefix(240)))
        }
        let claim = try JSONDecoder().decode(ClaimResponse.self, from: data)
        guard !claim.machineId.isEmpty, !claim.token.isEmpty else { throw PairingClientError.invalidResponse }
        let returnedURL = claim.cloudUrl.flatMap(URL.init(string:))
        return ConnectionConfiguration(
            cloudURL: returnedURL ?? request.cloudURL,
            machineID: claim.machineId,
            machineToken: claim.token,
            machineLabel: machineLabel
        )
    }
}
