import Foundation

public enum PhoneError: LocalizedError, Sendable {
    case damagedLink, unsupportedLink, wrongMac, unavailable, invalidReply, refused(String)
    public var errorDescription: String? {
        switch self {
        case .damagedLink: "This link is damaged. Copy a new link from Devices on your Mac."
        case .unsupportedLink: "Use a link for another computer, not a command for another user."
        case .wrongMac: "This is not the Mac your link names. Nothing was sent."
        case .unavailable: "Your Mac is out of reach. Check that Infinitary is open and both devices share a network."
        case .invalidReply: "This Mac sent an answer Infinitary could not read."
        case .refused(let reason): reason
        }
    }
}

public struct JoinLink: Equatable, Sendable {
    public let addresses: [String]
    public let pin: String
    public let code: String
    public let kind: String
    public var computer: String { (try? Self.url(addresses[0], path: "/").host) ?? "your Mac" }

    public init(_ text: String) throws {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.utf8.count <= 4096,
              let url = URLComponents(string: text), url.scheme == "infinitary", url.host == "join",
              url.path.isEmpty, url.fragment == nil, url.user == nil, url.password == nil, url.port == nil
        else { throw PhoneError.damagedLink }
        var fields: [String: String] = [:]
        for item in url.queryItems ?? [] {
            guard ["as", "at", "key", "code", "also", "via"].contains(item.name),
                  fields[item.name] == nil, let value = item.value else { throw PhoneError.damagedLink }
            fields[item.name] = value
        }
        guard let kind = fields["as"], ["mac", "view", "work"].contains(kind),
              let at = fields["at"], let pin = fields["key"], let code = fields["code"],
              Self.validKey(pin), Self.validKey(code) else { throw PhoneError.damagedLink }
        guard kind != "work", fields["via"] == nil else { throw PhoneError.unsupportedLink }
        let also = fields["also"].map { $0.split(separator: ",").map(String.init) } ?? []
        guard also.count <= 8 else { throw PhoneError.damagedLink }
        var addresses: [String] = []
        for address in [at] + also {
            _ = try Self.url(address, path: "/pair")
            if !addresses.contains(address) { addresses.append(address) }
        }
        self.addresses = addresses; self.pin = pin; self.code = code; self.kind = kind
    }

    public static func validKey(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }

    public static func url(_ address: String, path: String, websocket: Bool = false) throws -> URL {
        guard address.range(of: "^(?:\\[[0-9a-fA-F:.]+\\]|[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}):[0-9]{1,5}$", options: .regularExpression) != nil,
              let parts = URLComponents(string: "https://" + address),
              let port = parts.port, (1...65535).contains(port), parts.host != nil,
              parts.user == nil, parts.password == nil, parts.path.isEmpty
        else { throw PhoneError.damagedLink }
        var result = parts; result.scheme = websocket ? "wss" : "https"; result.path = path
        guard let url = result.url else { throw PhoneError.damagedLink }
        return url
    }
}

/// No invitation code, private key, card or feed content is saved in this record.
public struct JoinedMac: Codable, Equatable, Sendable {
    public var addresses: [String]
    public let pin: String
    public let deviceID: String
    public var name: String
    public init(addresses: [String], pin: String, deviceID: String, name: String) {
        self.addresses = addresses; self.pin = pin; self.deviceID = deviceID; self.name = name
    }
}
