import CryptoKit
import Foundation
import Security

/// INF-4794: what the app and its notification part share to open each card push (docs/ios.md, "Card pushes"),
/// kept apart from the rest of the phone's code so the notification part stays small under iOS's memory limit for it.

/// Which of Apple's push services this build's push address belongs to.
public enum PhonePushEnvironment: String, Codable, Sendable {
    case production, development
}

/// INF-5265: one kept computer's sealing key, named for the notification part. Each computer seals for this phone
/// under its own key, so the key that opens a push names the computer it came from.
public struct PhonePushComputer: Codable, Equatable, Sendable {
    /// The computer's pin, which names it in the phone's saved list and on each notification it opens.
    public var pin: String
    /// The computer's name, which a notification shows while the phone keeps more than one.
    public var name: String
    /// 32 random bytes in base64url, for AES-256-GCM.
    public var key: String

    public init(pin: String, name: String, key: String) { self.pin = pin; self.name = name; self.key = key }
}

/// What the phone keeps for its pushes, in the Keychain group the app shares with its notification part: the sealing
/// key of each kept computer the part opens each push with, and the push address, its service and the relay's grant
/// for them, which every kept computer shares.
public struct PhonePushHeld: Codable, Equatable, Sendable {
    /// 32 random bytes in base64url, for AES-256-GCM: the first kept computer's key, and the one key of a record kept
    /// before the phone kept several computers, which an older build reads.
    public var key: String
    /// INF-5265: each kept computer's own key, or none in a record kept before; the app fills it once it reads its
    /// saved computers (`PhonePushes.kept`).
    public var computers: [PhonePushComputer]?
    /// INF-5265: the computer the notifications shown before the phone kept a key per computer came from, which name
    /// none: the one computer kept when the record moved to a key per computer. None once it is forgotten.
    public var untagged: String?
    public var token: String?
    public var environment: PhonePushEnvironment?
    public var grant: String?
    /// When the phone last asked the relay for a grant: each ask costs one of Apple's few background pushes an hour.
    public var asked: Date?

    public init(key: String, token: String? = nil, environment: PhonePushEnvironment? = nil, grant: String? = nil, asked: Date? = nil,
                computers: [PhonePushComputer]? = nil) {
        self.key = key; self.token = token; self.environment = environment; self.grant = grant; self.asked = asked
        self.computers = computers
    }

    /// The keys a push may be sealed under, each with the computer it names: every kept computer's, or the one key of a
    /// record from before, which names none.
    public var openers: [(key: String, computer: PhonePushComputer?)] {
        guard let computers else { return [(key, nil)] }
        return computers.map { ($0.key, $0) }
    }
}

/// What one sealed push says once opened (`phonePushCardSchema`).
public struct PhonePushCard: Decodable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    public let cardId: String
    public let title: String
    public let body: String
    /// This push's own random name: a withdrawal names the pushes it withdraws, so any other push of the same card keeps
    /// its notification. An older computer sends none, and a notification without one is never withdrawn.
    public let push: String?
}

/// The words a notification shows for one push it opened: the card's title and its first line, and the card it opens.
public struct PhonePushNotice: Equatable, Sendable {
    public let title: String
    public let body: String
    public let cardID: String
    /// Which push of the card it is (`PhonePushCard.push`).
    public let push: String?
    /// INF-5265: the pin of the computer whose key opened it, or none for a record kept before.
    public let computer: String?
    /// The computer's name, shown under the title while the phone keeps more than one computer.
    public let subtitle: String?

    public init(title: String, body: String, cardID: String, push: String? = nil, computer: String? = nil, subtitle: String? = nil) {
        self.title = title; self.body = body; self.cardID = cardID; self.push = push; self.computer = computer
        self.subtitle = subtitle
    }

    /// What the notification carries for the app (`PhonePushSeal.userInfo(for:)`).
    public var userInfo: [AnyHashable: Any] { PhonePushSeal.userInfo(for: self) }
    }
}

public enum PhonePushSeal {
    /// The key `userInfo` names the card a notification opens with.
    public static let cardKey = "cardId"
    /// The key `userInfo` names which push of the card a notification shows with (`PhonePushCard.push`).
    public static let pushKey = "push"
    /// INF-5265: the key `userInfo` names the computer whose card it is, by its pin.
    public static let computerKey = "computer"

    /// What the notification part keeps on a notification it opened: the card it opens, which push of it this is and,
    /// when known, its computer.
    public static func userInfo(for notice: PhonePushNotice) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = [cardKey: notice.cardID]
        if let push = notice.push { info[pushKey] = push }
        if let computer = notice.computer { info[computerKey] = computer }
        return info
    }

    /// What the app reads back from a shown notification's `userInfo`: its card, which push of it and its computer,
    /// when it says.
    public static func shown(_ userInfo: [AnyHashable: Any]) -> (cardID: String?, push: String?, computer: String?) {
        (userInfo[cardKey] as? String, userInfo[pushKey] as? String, userInfo[computerKey] as? String)
    }

    /// A new sealing key: 32 random bytes in base64url.
    public static func newKey() -> String { base64url(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }) }

    /// Opens one sealed push: base64url of the 12-byte nonce, the ciphertext and the 16-byte tag, under the phone's key.
    public static func open(_ sealed: String, key: String) -> PhonePushCard? {
        guard let opened = openBytes(sealed, key: key),
              let card = try? JSONDecoder().decode(PhonePushCard.self, from: opened),
              card.v == 1, ["card", "reply"].contains(card.kind), !card.cardId.isEmpty else { return nil }
        return card
    }

    /// The plain bytes of one sealed push or withdrawal, or nil when this key did not seal it.
    public static func openBytes(_ sealed: String, key: String) -> Data? {
        guard let bytes = fromBase64url(sealed), bytes.count > 28, let keyBytes = fromBase64url(key), keyBytes.count == 32,
              let box = try? AES.GCM.SealedBox(combined: bytes),
              let opened = try? AES.GCM.open(box, using: SymmetricKey(data: keyBytes)) else { return nil }
        return opened
    }

    /// The words a push from the relay shows (`{ "aps": …, "sealed": … }`), opened with the phone's key; nil when it
    /// cannot be opened, and the notification keeps the relay's own words, "A card is ready".
    public static func notice(_ userInfo: [AnyHashable: Any], key: String?) -> PhonePushNotice? {
        guard let sealed = userInfo["sealed"] as? String, let key, let card = open(sealed, key: key) else { return nil }
        return PhonePushNotice(title: card.title, body: card.body, cardID: card.cardId, push: card.push)
    }

    /// INF-5265: a push opened with each kept computer's key in turn. The key that opens it names its computer, and
    /// while the phone keeps more than one computer that computer's name is the notification's subtitle. Nil when no
    /// key opens it, and the notification keeps the relay's own words.
    public static func notice(_ userInfo: [AnyHashable: Any], held: PhonePushHeld?) -> PhonePushNotice? {
        guard let held, let sealed = userInfo["sealed"] as? String else { return nil }
        let several = (held.computers?.count ?? 0) > 1
        for opener in held.openers {
            guard let card = open(sealed, key: opener.key) else { continue }
            return PhonePushNotice(title: card.title, body: card.body, cardID: card.cardId, push: card.push,
                                   computer: opener.computer?.pin,
                                   subtitle: several ? opener.computer?.name : nil)
        }
        return nil
    }

    public static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func fromBase64url(_ text: String) -> Data? {
        var plain = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        plain += String(repeating: "=", count: (4 - plain.count % 4) % 4)
        return Data(base64Encoded: plain)
    }
}

/// The held record in the keychain group the app shares with its notification part, which reads the key to open
/// each push. It stays on this device, readable after the first unlock so a push that arrives while locked opens.
public enum PhonePushStore {
    static let service = "com.getinfinitary.infinitary.phone-push"
    /// The team-prefixed push group both parts' entitlements list. It is not the app's own default group, so the
    /// notification part reaches this record alone, never the phone's identity, SSH or approval keys.
    public static let group = "9T2J7MNUP9.com.getinfinitary.infinitary.push"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccessGroup as String: group, kSecAttrSynchronizable as String: false]
    }

    public static func load() -> PhonePushHeld? {
        var item: CFTypeRef?
        var ask = query; ask[kSecReturnData as String] = true
        guard SecItemCopyMatching(ask as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(PhonePushHeld.self, from: data)
    }

    public static func save(_ held: PhonePushHeld) {
        guard let data = try? JSONEncoder().encode(held) else { return }
        let found = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard found == errSecItemNotFound else { return }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
