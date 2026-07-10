import Foundation

public enum EndpointBuilder {
    private static let pathSegmentAllowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))

    public static func sessionURL(baseURL: URL, projectPath: String, sessionID: String, tail: Int) -> URL? {
        guard let project = projectPath.addingPercentEncoding(withAllowedCharacters: pathSegmentAllowed),
              let session = sessionID.addingPercentEncoding(withAllowedCharacters: pathSegmentAllowed)
        else { return nil }
        return URL(string: "\(baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/api/session/\(project)/\(session)?tail=\(tail)")
    }
}
