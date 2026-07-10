import Foundation

public enum DeepLinkError: LocalizedError, Equatable {
    case unsupportedURL
    case missingCloudURL
    case insecureCloudURL
    case missingPairingCode

    public var errorDescription: String? {
        switch self {
        case .unsupportedURL: "This is not an Agent Session Viewer connection link."
        case .missingCloudURL: "The connection link is missing its cloud address."
        case .insecureCloudURL: "The cloud address must use HTTPS."
        case .missingPairingCode: "The connection link is missing its one-time pairing code."
        }
    }
}

public enum DeepLinkParser {
    public static func parse(_ url: URL) throws -> PairingRequest {
        guard url.scheme?.lowercased() == "asv", url.host?.lowercased() == "connect" else {
            throw DeepLinkError.unsupportedURL
        }
        var components = URLComponents()
        components.percentEncodedQuery = url.fragment
        let values = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        guard let cloudString = values["cloud"], let cloudURL = URL(string: cloudString) else {
            throw DeepLinkError.missingCloudURL
        }
        guard cloudURL.scheme?.lowercased() == "https", cloudURL.host != nil else {
            throw DeepLinkError.insecureCloudURL
        }
        guard let pairingCode = values["pairing"]?.trimmingCharacters(in: .whitespacesAndNewlines), !pairingCode.isEmpty else {
            throw DeepLinkError.missingPairingCode
        }
        let machine = values["machine"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        return PairingRequest(
            cloudURL: cloudURL,
            pairingCode: pairingCode,
            suggestedMachineLabel: machine?.isEmpty == false ? machine : nil
        )
    }
}
