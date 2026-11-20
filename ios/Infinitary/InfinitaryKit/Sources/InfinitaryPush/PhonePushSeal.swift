import CryptoKit
import Foundation
import Security

/// INF-4794: what the app and its notification part share to open each card push (docs/ios.md, "Card pushes"),
/// kept apart from the rest of the phone's code so the notification part stays small under iOS's memory limit for it.

/// Which of Apple's push services this build's push address belongs to.
public enum PhonePushEnvironment: String, Codable, Sendable {
    case production, development
}

/// What the phone keeps for its pushes, in the Keychain group the app shares with its notification part: the sealing
/// key the part opens each push with, and the push address, its service and the relay's grant for them.
public struct PhonePushHeld: Codable, Equatable, Sendable {
    /// 32 random bytes in base64url, for AES-256-GCM.
    public var key: String
    public var token: String?
    public var environment: PhonePushEnvironment?
    public var grant: String?
    /// When the phone last asked the relay for a grant: each ask costs one of Apple's few background pushes an hour.
    public var asked: Date?

    public init(key: String, token: String? = nil, environment: PhonePushEnvironment? = nil, grant: String? = nil, asked: Date? = nil) {
        self.key = key; self.token = token; self.environment = environment; self.grant = grant; self.asked = asked
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

    public init(title: String, body: String, cardID: String, push: String? = nil) {
        self.title = title; self.body = body; self.cardID = cardID; self.push = push
    }
}

public enum PhonePushSeal {
    /// The key `userInfo` names the card a notification opens with.
    public static let cardKey = "cardId"
    /// The key `userInfo` names which push of the card a notification shows with (`PhonePushCard.push`).
    public static let pushKey = "push"

    /// What the notification part keeps on a notification it opened: the card it opens and which push of it this is.
    public static func userInfo(for notice: PhonePushNotice) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = [cardKey: notice.cardID]
        if let push = notice.push { info[pushKey] = push }
        return info
    }

    /// What the app reads back from a shown notification's `userInfo`: its card and which push of it, when it says.
    public static func shown(_ userInfo: [AnyHashable: Any]) -> (cardID: String?, push: String?) {
        (userInfo[cardKey] as? String, userInfo[pushKey] as? String)
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
