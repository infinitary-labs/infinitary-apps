import Foundation

public enum PhoneError: LocalizedError, Sendable {
    case damagedLink, unsupportedLink, wrongMac, unavailable, invalidReply, refused(String)
    /// A change was sent and its result never came back: its outcome is unknown (INF-2553 keeps it shown until the
    /// next snapshot after reconnecting says otherwise).
    case unconfirmed
    /// This phone keeps an approval record it must never sign with, a software key on a physical device. Unlike
    /// a Keychain it cannot read now, only a new key replaces it.
    case unusableApproval
    /// This phone's Keychain gave back its approval record whole, but the phone cannot decode it. Unlike a
    /// Keychain it cannot read now, it stays damaged; only the person's Set up approvals again replaces it.
    case damagedApproval(ApprovalKey.Damage)
    public var errorDescription: String? {
        switch self {
        case .damagedLink: PhoneMessages.phoneJoinLinkDamaged()
        case .unsupportedLink: PhoneMessages.phoneJoinLinkUnsupported()
        case .wrongMac: PhoneMessages.phoneJoinWrongComputer()
        case .unavailable: PhoneMessages.phoneJoinUnavailable()
        case .invalidReply: PhoneMessages.phoneJoinInvalidReply()
        case .refused(let reason): reason
        case .unconfirmed: PhoneMessages.phoneJoinUnconfirmed()
        case .unusableApproval: ApprovalKey.unusable
        case .damagedApproval: ApprovalKey.damaged
        }
    }
}

public struct JoinLink: Equatable, Sendable {
    public let addresses: [String]
    public let pin: String
    public let code: String
    public let kind: String
    /// INF-1183: the address its person typed, at the link's port, tried before the link's own.
    public private(set) var first: String?
    public var computer: String { (try? Self.url(first ?? addresses[0], path: "/").host) ?? PhoneMessages.phoneJoinYourComputer() }

    /// The routes in the order a join tries them: the typed address, then the link's own.
    public var routes: [String] {
        let rest = PhoneAddresses.preferred(addresses)
        guard let first else { return rest }
        return [first] + rest.filter { $0 != first }
    }

    /// This link, tried first at `address`.
    public func trying(first address: String) -> JoinLink {
        var link = self; link.first = address; return link
    }

    /// The typed host at the port the link names.
    public func typedAddress(_ host: String) throws -> String {
        guard let port = try Self.url(addresses[0], path: "/").port else { throw PhoneError.damagedLink }
        let address = "\(host):\(port)"
        _ = try Self.url(address, path: "/pair")
        return address
    }

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
    /// The highest home number this phone heard (docs/devices.md, "Moving the first mate"); none before a move.
    public var homeNumber: Int?
    /// The takeover that made the home with that number (docs/devices.md, "Two homes with one number"); none when a
    /// move or the first join made it.
    public var takeOver: String?
    /// The computers that keep a copy of the record, as the home last listed them (docs/devices.md, "Taking over from
    /// a phone"): their names, the pins of their own keys and where they listen. None from a home from before.
    public var standbys: [PhoneStandby]?
    public init(addresses: [String], pin: String, deviceID: String, name: String, homeNumber: Int? = nil,
                takeOver: String? = nil, standbys: [PhoneStandby]? = nil) {
        self.addresses = addresses; self.pin = pin; self.deviceID = deviceID; self.name = name
        self.homeNumber = homeNumber; self.takeOver = takeOver; self.standbys = standbys
    }
}

/// INF-1156 option A: route preference survives a successful local fallback and a relaunch.
/// Only the existing shared IPv4 range is recognized; names are not resolved or guessed.
public enum PhoneAddresses {
    public static func isPrivate(_ address: String) -> Bool {
        guard let host = try? JoinLink.url(address, path: "/").host else { return false }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ part in UInt8(part).map { String($0) == part } ?? false }),
              parts[0] == "100", let second = UInt8(parts[1]) else { return false }
        return (64...127).contains(second)
    }

    public static func preferred(_ addresses: [String]) -> [String] {
        var unique: [String] = []
        for address in addresses where !unique.contains(address) {
            guard (try? JoinLink.url(address, path: "/")) != nil else { continue }
            unique.append(address)
        }
        return unique.filter(isPrivate) + unique.filter { !isPrivate($0) }
    }
}
