import Foundation

public struct ConnectionConfiguration: Codable, Equatable, Sendable {
    public let cloudURL: URL
    public let machineID: String
    public let machineToken: String
    public let machineLabel: String
    public let localURL: URL

    public init(
        cloudURL: URL,
        machineID: String,
        machineToken: String,
        machineLabel: String,
        localURL: URL = URL(string: "http://127.0.0.1:3001")!
    ) {
        self.cloudURL = cloudURL
        self.machineID = machineID
        self.machineToken = machineToken
        self.machineLabel = machineLabel
        self.localURL = localURL
    }
}

public struct PairingRequest: Equatable, Sendable {
    public let cloudURL: URL
    public let pairingCode: String
    public let suggestedMachineLabel: String?

    public init(cloudURL: URL, pairingCode: String, suggestedMachineLabel: String? = nil) {
        self.cloudURL = cloudURL
        self.pairingCode = pairingCode
        self.suggestedMachineLabel = suggestedMachineLabel
    }
}

public struct ClaimResponse: Codable, Equatable, Sendable {
    public let machineId: String
    public let token: String
    public let cloudUrl: String?

    public init(machineId: String, token: String, cloudUrl: String? = nil) {
        self.machineId = machineId
        self.token = token
        self.cloudUrl = cloudUrl
    }
}
