@_exported import InfinitaryPush
import Foundation
import Observation

/// INF-4794, the phone's half of card pushes (docs/phone-push.md; docs/ios.md, "Card pushes"): the computer seals each
/// card for this phone under the phone's own key and posts it to Infinitary's relay, which wakes the phone through
/// Apple. The relay sends this phone a grant for its push address by a background push; the phone hands the address,
/// the grant and its key to its computer on each welcome, and the notification part opens what arrives.

/// What the phone hands its computer (`inf:devices:push`, `phonePushRegistrationSchema`).
public struct PhonePushRegistration: Equatable, Sendable {
    public let token: String
    public let environment: PhonePushEnvironment
    public let grant: String
    public let key: String
    /// The phone removes the notifications a withdrawal names; set only toward a computer that lists
    /// `phone-push-withdraw`, since an older computer's registration refuses any field it does not know.
    public var withdrawals = false

    /// The request's one argument.
    public var argument: [String: Any] {
        var argument: [String: Any] = ["token": token, "environment": environment.rawValue, "grant": grant, "key": key]
        if withdrawals { argument["withdrawals"] = true }
        return argument
    }
}

/// What one sealed withdrawal says once opened (`phonePushWithdrawalSchema`): the cards whose notifications go.
public struct PhonePushWithdrawal: Decodable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    /// Each card whose notifications go, with the pushes of it withdrawn (`PhonePushCard.push`).
    public let cards: [Card]

    public struct Card: Decodable, Equatable, Sendable {
        public let cardId: String
        public let pushes: [String]
    }
}

/// The computer's answer to a registration (`phonePushAnswerSchema`).
public struct PhonePushAnswer: Decodable, Sendable { public let kept: Bool }

public enum PhonePush {
    /// Where the phone asks for a grant: the relay's own register request, beside the address computers post to.
    public static let register: URL = {
        // i18n-exempt: a request path, never shown
        URL(string: PhoneContract.pushRelay)!.deletingLastPathComponent().appendingPathComponent("register")
    }()
    /// A grant lasts 30 days (the relay's `GRANT_DAYS`); the phone asks for the next one in its last three.
    public static let renewBefore: TimeInterval = 3 * 86_400
    /// Apple keeps background pushes to a few an hour, so the phone asks the relay for a grant at most once an hour.
    public static let askEvery: TimeInterval = 3_600
    /// The key `userInfo` names the card a notification opens with.
    public static let cardKey = PhonePushSeal.cardKey
    /// Where the relay's background push carries the grant.
    public static let grantKey = "grant"

    private static var tokenShape: Regex<Substring> { /^(?:[0-9a-f]{2}){32,100}$/ }
    private static var grantShape: Regex<(Substring, Substring)> { /^(\d{10})\.[A-Za-z0-9_-]{43}$/ }

    /// The push address Apple gave, as the relay and the computer take it: lowercase hexadecimal.
    public static func token(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    /// When a grant expires, or nil for text that is not one.
    public static func expiry(_ grant: String) -> Date? {
        guard let match = grant.wholeMatch(of: grantShape), let seconds = TimeInterval(match.1) else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }

    /// The registration to hand, when the phone holds a grant for this address and service that has not expired.
    /// INF-5265: the key is the one kept for `computer`, or the record's own key for a record kept before.
    public static func registration(_ held: PhonePushHeld, token: String, environment: PhonePushEnvironment, now: Date,
                                    computer: String? = nil) -> PhonePushRegistration? {
        guard held.token == token, held.environment == environment, let grant = held.grant,
              let expiry = expiry(grant), expiry > now, token.wholeMatch(of: tokenShape) != nil else { return nil }
        // A computer the phone keeps no key for yet gets none, never another computer's key.
        guard let key = computer.map({ pin in held.computers?.first { $0.pin == pin }?.key }) ?? held.key else { return nil }
        return PhonePushRegistration(token: token, environment: environment, grant: grant, key: key)
    }

    /// Whether the phone asks the relay for a grant: it holds none for this address and service, or its grant expires
    /// within `renewBefore`.
    public static func needsGrant(_ held: PhonePushHeld, token: String, environment: PhonePushEnvironment, now: Date) -> Bool {
        guard let registration = registration(held, token: token, environment: environment, now: now),
              let expiry = expiry(registration.grant) else { return true }
        return expiry.timeIntervalSince(now) < renewBefore
    }

    /// The grant a background push from the relay carries (`{ "aps": { "content-available": 1 }, "grant": … }`).
    public static func grant(inPush userInfo: [AnyHashable: Any]) -> String? {
        guard let grant = userInfo[grantKey] as? String, expiry(grant) != nil else { return nil }
        return grant
    }

    /// The withdrawal a silent push from the relay carries (`{ "aps": { "content-available": 1 }, "sealed": … }`),
    /// opened with the phone's key; nil for any other push, or one this key did not seal.
    public static func withdrawal(inPush userInfo: [AnyHashable: Any], key: String) -> PhonePushWithdrawal? {
        guard let sealed = userInfo["sealed"] as? String, let opened = PhonePushSeal.openBytes(sealed, key: key),
              let withdrawal = try? JSONDecoder().decode(PhonePushWithdrawal.self, from: opened),
              withdrawal.v == 1, withdrawal.kind == "withdraw" else { return nil }
        return withdrawal
    }

    /// Which service a build's pushes go through, read from its embedded provisioning profile: a build signed for
    /// development names `development`; a TestFlight or App Store build carries no profile and is production.
    public static func environment(profile: Data?) -> PhonePushEnvironment {
        guard let profile, let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: profile[start.lowerBound..<end.upperBound], format: nil) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any],
              entitlements["aps-environment"] as? String == "development" else { return .production }
        return .development
    }

    /// Whether a push shows while Infinitary is in front. In reach, the in-app notice already shows the card; with no
    /// computer joined, it comes from a computer this phone forgot; and one the notification part could not open names
    /// no card. Away from its computer with Infinitary open, the in-app notice cannot show it, so the push shows.
    /// INF-5265: a push names its computer; one from a kept computer the phone does not show cannot be shown by the
    /// in-app notice, so it shows. One that names no computer comes from the one kept before.
    public static func showsInFront(contact: String?, cardID: String?, computer: String? = nil, shown: String? = nil) -> Bool {
        guard let contact, cardID != nil else { return false }
        if let computer, computer != shown { return true }
        return contact != "in-reach"
    }

}

/// Whether this phone may show Infinitary's notifications, as iOS says.
public enum PhonePushPermission: Equatable, Sendable {
    /// iOS has not asked yet.
    case notAsked
    case on
    /// Off in the phone's own Settings.
    case off
}

/// What the phone's pushes reach outside this file: iOS, the relay, the Keychain and the computer.
public struct PhonePushEffects {
    public var permission: @MainActor () async -> PhonePushPermission
    /// iOS's own question; true when the person allowed notifications.
    public var askPermission: @MainActor () async -> Bool
    /// Asks iOS for the push address, which arrives at `PhonePushes.tokenArrived`.
    public var registerForPushes: @MainActor () -> Void
    /// Gives up the push address. When iOS later gives a new one, Apple stops delivering to the old one and the relay
    /// answers a computer still sending that it reaches no phone; iOS may also hand back the same address.
    public var unregisterForPushes: @MainActor () -> Void
    /// Posts to the relay's register request; the answer's status, or nil when none came.
    public var post: @Sendable (URL, Data) async -> Int?
    public var load: @MainActor () -> PhonePushHeld?
    public var save: @MainActor (PhonePushHeld) -> Void
    /// Whether this phone asked the person once already, and noting that it did.
    public var askedPerson: @MainActor () -> Bool
    public var noteAskedPerson: @MainActor () -> Void
    /// The notifications shown now, each with the card it opens, which push of it this is and the pin of its
    /// computer, and removing some by their ids.
    public var delivered: @MainActor () async -> [(id: String, cardID: String?, push: String?, computer: String?)]
    public var remove: @MainActor ([String]) -> Void
    public var now: @MainActor () -> Date

    public init(permission: @escaping @MainActor () async -> PhonePushPermission, askPermission: @escaping @MainActor () async -> Bool,
                registerForPushes: @escaping @MainActor () -> Void, unregisterForPushes: @escaping @MainActor () -> Void, post: @escaping @Sendable (URL, Data) async -> Int?,
                load: @escaping @MainActor () -> PhonePushHeld?, save: @escaping @MainActor (PhonePushHeld) -> Void,
                askedPerson: @escaping @MainActor () -> Bool, noteAskedPerson: @escaping @MainActor () -> Void,
                delivered: @escaping @MainActor () async -> [(id: String, cardID: String?, push: String?, computer: String?)],
                remove: @escaping @MainActor ([String]) -> Void,
                now: @escaping @MainActor () -> Date = { Date() }) {
        self.permission = permission; self.askPermission = askPermission; self.registerForPushes = registerForPushes
        self.unregisterForPushes = unregisterForPushes
        self.post = post; self.load = load; self.save = save; self.askedPerson = askedPerson
        self.noteAskedPerson = noteAskedPerson; self.delivered = delivered; self.remove = remove; self.now = now
    }
}

/// The phone's pushes over a run: it asks the person once after joining, keeps its push address and grant current
/// with as few asks of the relay as it can, and hands its computer the registration, or null while notifications for
/// Infinitary are off in the phone's Settings, at each open and each welcome. INF-5265: every kept computer shares the
/// address and grant, and each has its own sealing key, handed at its own welcome.
@MainActor @Observable public final class PhonePushes {
    public private(set) var permission: PhonePushPermission?
    /// The computer's welcome lists `phone-push`; one without it is named for an update in Settings.
    public private(set) var homeTakesPushes = false
    /// The computer's welcome lists `phone-push-withdraw`, so the registration says this phone takes withdrawals.
    @ObservationIgnored private var homeTakesWithdrawals = false
    /// The one-sentence ask before iOS's own question shows now.
    public private(set) var asking = false

    @ObservationIgnored private let effects: PhonePushEffects
    @ObservationIgnored private let environment: PhonePushEnvironment
    @ObservationIgnored private var held: PhonePushHeld?
    @ObservationIgnored private var token: String?
    /// The address and service the last ask of the relay named, which the grant it sends belongs to.
    @ObservationIgnored private var askedFor: (token: String, environment: PhonePushEnvironment)?
    /// Hands the computer a registration or null and answers whether it kept it; nil while it is not in reach.
    @ObservationIgnored private var hand: ((PhonePushRegistration?) async throws -> Bool)?
    /// The pin of the computer `hand` reaches.
    @ObservationIgnored private var reaching: String?

    public init(effects: PhonePushEffects, environment: PhonePushEnvironment) {
        self.effects = effects
        self.environment = environment
    }

    /// Infinitary came to the front: iOS's setting is read again, since iOS tells no app when it changes.
    public func opened() async {
        permission = await effects.permission()
        if permission == .on { effects.registerForPushes() }
        update()
        await handOver()
    }

    /// INF-5265: the computers the phone keeps, by pin and name. Each gets its own key, named for the notification
    /// part, and a forgotten one's key goes. A record kept before gives its one key to the one computer kept then, the
    /// key that computer already holds, and a phone's first computer takes the record's key.
    public func kept(_ kept: [(pin: String, name: String)]) {
        // No computer kept is the last one forgotten, which `forgot` owns; here it would drop every key.
        guard !kept.isEmpty else { return }
        var held = keep()
        let before = held
        var computers = held.computers ?? []
        if held.computers == nil, kept.count == 1 {
            computers = [PhonePushComputer(pin: kept[0].pin, name: kept[0].name, key: held.key)]
            held.untagged = kept[0].pin
        }
        computers.removeAll { computer in !kept.contains { $0.pin == computer.pin } }
        if let untagged = held.untagged, !kept.contains(where: { $0.pin == untagged }) { held.untagged = nil }
        for computer in kept {
            if let index = computers.firstIndex(where: { $0.pin == computer.pin }) { computers[index].name = computer.name; continue }
            computers.append(PhonePushComputer(pin: computer.pin, name: computer.name,
                                               key: computers.isEmpty ? held.key : PhonePushSeal.newKey()))
        }
        held.computers = computers
        if let first = computers.first { held.key = first.key }
        guard held != before else { return }
        self.held = held; effects.save(held)
    }

    /// The computer's welcome reached In reach: `hand` asks `inf:devices:push` on this connection, and hands the key
    /// kept for `computer`.
    public func reached(computer: String? = nil, takesPushes: Bool, takesWithdrawals: Bool = false,
                        hand: @escaping (PhonePushRegistration?) async throws -> Bool) async {
        homeTakesPushes = takesPushes
        homeTakesWithdrawals = takesWithdrawals
        reaching = computer
        self.hand = takesPushes ? hand : nil
        if permission == nil { permission = await effects.permission() }
        // A computer joined after this phone forgot another, in the same sitting, needs an address before a grant.
        if takesPushes, permission == .on, token == nil { effects.registerForPushes() }
        update()
        await handOver()
    }

    /// The connection ended, or this phone left its computer.
    public func left() { hand = nil; reaching = nil; update() }

    /// This phone forgot its computer (the captain's answer on INF-4794's review: "if i forget a computer, then the
    /// phone app should stop showing any push notifications from that home"). The phone gives up its push address,
    /// makes a new key and drops the grant, so that computer's pushes open to no card and show nothing while
    /// Infinitary is in front, and it removes the notifications that computer's cards left. A forgotten computer may
    /// still show "A card is ready" while Infinitary is closed (the captain's pick, "Say plainly that a forgotten
    /// computer may still show these"): the relay cannot cancel its grant, and iOS may hand back the same address.
    /// INF-5265: forgetting one computer while the phone keeps others drops only that computer's key and its
    /// notifications; the push address and grant stay, since the others still push to them.
    public func forgot(computer: String? = nil) async {
        left()
        var held = keep()
        let rest = (held.computers ?? []).filter { $0.pin != computer }
        if let computer, !rest.isEmpty {
            // Committed before the wait for iOS's list, so a later join or forget starts from this record.
            let before = held
            held.computers = rest
            held.key = rest[0].key
            if held.untagged == computer { held.untagged = nil }
            self.held = held; effects.save(held)
            let shown = await effects.delivered().filter { owner(named: $0.computer, in: before) == computer }.map(\.id)
            if !shown.isEmpty { effects.remove(shown) }
            return
        }
        token = nil; askedFor = nil
        let fresh = PhonePushHeld(key: PhonePushSeal.newKey(), computers: [])
        self.held = fresh; effects.save(fresh)
        effects.unregisterForPushes()
        let shown = await effects.delivered().map(\.id)
        if !shown.isEmpty { effects.remove(shown) }
    }

    /// INF-5265: the computer a shown notification came from: the one it names, or for one that names none, shown
    /// before the phone kept a key per computer, the computer kept then (`PhonePushHeld.untagged`).
    public func owner(named computer: String?) -> String? { owner(named: computer, in: keep()) }

    private func owner(named computer: String?, in held: PhonePushHeld, alone: String? = nil) -> String? {
        computer ?? held.untagged ?? alone
    }

    /// iOS gave the push address: a new one, or one with no grant that lasts, asks the relay for a grant.
    public func tokenArrived(_ data: Data) async {
        let token = PhonePush.token(data)
        self.token = token
        let held = keep()
        if PhonePush.needsGrant(held, token: token, environment: environment, now: effects.now()) { await askRelay() }
        else { await handOver() }
    }

    /// A background push arrived; true when it carried the relay's grant, which is kept and handed on.
    @discardableResult public func pushArrived(_ userInfo: [AnyHashable: Any]) async -> Bool {
        var held = keep()
        // A grant that wakes the app before iOS gave this run's address belongs to the address it last asked for.
        guard let grant = PhonePush.grant(inPush: userInfo),
              let named = askedFor ?? (token ?? held.token).map({ ($0, environment) }) else { return false }
        held.token = named.token; held.environment = named.environment; held.grant = grant
        self.held = held; effects.save(held)
        askedFor = nil
        await handOver()
        return true
    }

    /// The person answered the one-sentence ask: yes goes on to iOS's own question.
    public func answer(_ yes: Bool) async {
        asking = false
        effects.noteAskedPerson()
        guard yes else { return }
        permission = await effects.askPermission() ? .on : .off
        if permission == .on { effects.registerForPushes() }
        await handOver()
    }

    /// Settings' Turn on, after the person said Not now: iOS's own question, which iOS asks only once.
    public func turnOn() async { await answer(true) }

    /// A silent push from the relay carried a withdrawal: the notifications of the pushes it names go. Any other push of
    /// a named card, such as a newer reply Apple delivered before this slower silent push, stays, and so does a
    /// notification that names no push. True when one of this phone's keys opened it. INF-5265: each kept computer's
    /// key is tried in turn, and the one that opens it names the computer whose notifications it may remove.
    @discardableResult public func withdrawArrived(_ userInfo: [AnyHashable: Any]) async -> Bool {
        let held = keep()
        guard let opened = held.openers.lazy.compactMap({ opener in
            PhonePush.withdrawal(inPush: userInfo, key: opener.key).map { ($0, opener.computer?.pin) }
        }).first else { return false }
        let (withdrawal, computer) = opened
        let one = (held.computers?.count ?? 0) <= 1
        let named = Set(withdrawal.cards.flatMap { card in card.pushes.map { "\(card.cardId) \($0)" } })
        let gone = await effects.delivered().filter { shown in
            guard let card = shown.cardID, let push = shown.push, named.contains("\(card) \(push)") else { return false }
            guard let computer else { return true }
            return owner(named: shown.computer, in: held, alone: one ? computer : nil) == computer
        }.map(\.id)
        if !gone.isEmpty { effects.remove(gone) }
        return true
    }

    /// Removes the notifications for cards no longer on the stage or already seen, once the computer's cards are read
    /// and again whenever one is seen (INF-5209's plan, piece 1): a card seen anywhere needs no notification left on the phone.
    /// INF-5265: only `computer`'s notifications (`owner(named:)`); one that opened no card names no computer, so it
    /// goes only while the phone keeps one computer.
    public func clear(stage: [PhoneCard], seen: (PhoneCard) -> Bool, computer: String) async {
        let due = Set(stage.filter { !seen($0) }.map(\.id))
        let held = keep()
        let one = (held.computers?.count ?? 0) <= 1
        let gone = await effects.delivered().filter { shown in
            guard let card = shown.cardID else { return one }
            return owner(named: shown.computer, in: held, alone: one ? computer : nil) == computer && !due.contains(card)
        }.map(\.id)
        if !gone.isEmpty { effects.remove(gone) }
    }

    private func update() {
        asking = hand != nil && permission == .notAsked && !effects.askedPerson()
    }

    /// The held record, made with a new key on first use and kept so the notification part can open pushes.
    private func keep() -> PhonePushHeld {
        if let held { return held }
        let loaded = effects.load() ?? {
            let made = PhonePushHeld(key: PhonePushSeal.newKey())
            effects.save(made)
            return made
        }()
        held = loaded
        return loaded
    }

    /// Hands the computer what the phone holds: the registration while notifications are on and a grant is held,
    /// null while they are off in the phone's Settings, and nothing before iOS has asked.
    private func handOver() async {
        guard let hand, let permission else { return }
        switch permission {
        case .notAsked: return
        case .off: _ = try? await hand(nil)
        case .on:
            let held = keep()
            guard let token = token ?? held.token,
                  var registration = PhonePush.registration(held, token: token, environment: environment, now: effects.now(),
                                                            computer: reaching) else { return }
            registration.withdrawals = homeTakesWithdrawals
            guard let kept = try? await hand(registration), !kept else { return }
            // The computer did not keep the grant: the relay refused it this run, so the phone asks for a new one. The
            // record is read again after the wait, and only that grant goes, so a key kept or forgotten meanwhile stays.
            var forgotten = keep()
            guard forgotten.grant == registration.grant else { return }
            forgotten.grant = nil
            self.held = forgotten; effects.save(forgotten)
            await askRelay()
        }
    }

    /// Asks the relay to send this address a grant, at most once every `askEvery`.
    private func askRelay() async {
        guard let token, permission == .on else { return }
        var held = keep()
        let now = effects.now()
        if let asked = held.asked, now.timeIntervalSince(asked) < PhonePush.askEvery { return }
        held.asked = now
        self.held = held; effects.save(held)
        askedFor = (token, environment)
        let body = try? JSONSerialization.data(withJSONObject: ["token": token, "environment": environment.rawValue])
        // 202: the grant comes by a background push. Anything else waits for the next ask.
        _ = await effects.post(PhonePush.register, body ?? Data())
    }
}
