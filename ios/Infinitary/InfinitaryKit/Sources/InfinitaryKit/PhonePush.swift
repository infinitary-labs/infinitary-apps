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
        // A computer the phone keeps no key for yet gets none, never another computer's key; the record's own key is
        // handed only from a record kept before the phone kept a key per computer.
        let key: String? = if let computer { held.computers?.first { $0.pin == computer }?.key }
            else if held.computers == nil { held.key } else { nil }
        guard let key else { return nil }
        return PhonePushRegistration(token: token, environment: environment, grant: grant, key: key)
    }

    /// Whether the phone asks the relay for a grant: it holds none for this address and service, or its grant expires
    /// within `renewBefore`.
    public static func needsGrant(_ held: PhonePushHeld, token: String, environment: PhonePushEnvironment, now: Date) -> Bool {
        // The grant is the address's alone, whichever computer's key goes with it.
        guard held.token == token, held.environment == environment, let grant = held.grant, let expiry = expiry(grant),
              expiry > now, token.wholeMatch(of: tokenShape) != nil else { return true }
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
    /// The held record, nil when none is kept; it throws when the record cannot be read now, such as while locked.
    public var load: @MainActor () throws -> PhonePushHeld?
    /// Writes the held record; it throws unless the write was confirmed.
    public var save: @MainActor (PhonePushHeld) throws -> Void
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
                load: @escaping @MainActor () throws -> PhonePushHeld?, save: @escaping @MainActor (PhonePushHeld) throws -> Void,
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
    /// INF-5265: it asks iOS for the push address only while the phone keeps a computer; with none kept, the address
    /// the last forget gave up stays given up, and the next join asks for one.
    public func opened() async {
        permission = await effects.permission()
        if permission == .on, keep()?.computers?.isEmpty == false { effects.registerForPushes() }
        update()
        await handOver()
    }

    /// INF-5265: the computers the phone keeps, by pin and name. Each gets its own key, named for the notification
    /// part, and a forgotten one's key goes. A record kept before gives its one key to the one computer kept then, the
    /// key that computer already holds, once; every computer added after gets a new key, never one another computer
    /// held. The record's own key then belongs to no computer (the captain's pick on INF-5265's review, "Keep keys
    /// separate; do not support notifications after downgrading"), so an older build hands no computer's key.
    ///
    /// The app hands the list only once it read it, so the list is the phone's own: a computer missing from it was
    /// forgotten, even if the app stopped before it let go of that computer's key, and it goes now with its
    /// notifications. An empty list is the last computer forgotten, which lets go of the push address too. The record
    /// changes only once the Keychain confirmed the write; until then nothing changes and the next list tries again.
    /// Each time, every notification for a card whose computer is not kept goes, and every one goes while none is
    /// kept, so a cleanup cut short is finished by the next list; who is kept is read once iOS answered, so a pass
    /// never removes a notification of a computer joined meanwhile. It answers that removal, under way, or nil when the
    /// record could not be read or written.
    @discardableResult public func kept(_ kept: [(pin: String, name: String)]) -> Task<Void, Never>? {
        guard var held = keep() else { return nil }
        let before = held
        if kept.isEmpty {
            guard before.computers == [] || reset() else { return nil }
            return Task { await removeUnkept() }
        }
        var computers = held.computers ?? []
        if held.computers == nil {
            if kept.count == 1 {
                computers = [PhonePushComputer(pin: kept[0].pin, name: kept[0].name, key: held.key)]
                held.untagged = kept[0].pin
            }
            held.key = PhonePushSeal.newKey()
        }
        computers.removeAll { computer in !kept.contains { $0.pin == computer.pin } }
        if let untagged = held.untagged, !kept.contains(where: { $0.pin == untagged }) { held.untagged = nil }
        for computer in kept {
            if let index = computers.firstIndex(where: { $0.pin == computer.pin }) { computers[index].name = computer.name; continue }
            computers.append(PhonePushComputer(pin: computer.pin, name: computer.name, key: PhonePushSeal.newKey()))
        }
        held.computers = computers
        guard held == before || commit(held) else { return nil }
        return Task { await removeUnkept() }
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
        // The handover stays with the computer it reaches, unless that is the one forgotten.
        if computer == nil || computer == reaching { left() }
        // A record that cannot be read now changes nothing: the list, read again once it can be, lets go of the key.
        guard var held = keep() else { return }
        let rest = (held.computers ?? []).filter { $0.pin != computer }
        if let computer, !rest.isEmpty {
            // Committed before the wait for iOS's list, so a later join or forget starts from this record.
            held.computers = rest
            if held.untagged == computer { held.untagged = nil }
            // A write that fails changes nothing; the list handed next lets go of the key and its notifications.
            guard commit(held) else { return }
            // `untagged` went with it, so a notification from before that was this computer's has no kept owner.
            await removeUnkept()
            return
        }
        reset()
        await removeUnkept()
    }

    /// The last computer is forgotten: no handover, no push address, and a new key that belongs to no computer. False
    /// when the new record could not be written, which the next empty list tries again.
    @discardableResult private func reset() -> Bool {
        left()
        token = nil; askedFor = nil
        effects.unregisterForPushes()
        return commit(PhonePushHeld(key: PhonePushSeal.newKey(), computers: []))
    }

    /// Keeps `next` once the write is confirmed, so the app never hands a key the notification part cannot read, nor
    /// keeps using one it still reads.
    private func commit(_ next: PhonePushHeld) -> Bool {
        do { try effects.save(next) } catch { return false }
        held = next
        return true
    }

    /// Removes the notifications shown now that `which` picks; `which` runs once iOS answered, so it reads the record
    /// as it stands then.
    private func removeDelivered(_ which: ((id: String, cardID: String?, push: String?, computer: String?)) -> Bool) async {
        let gone = await effects.delivered().filter(which).map(\.id)
        if !gone.isEmpty { effects.remove(gone) }
    }

    /// Removes every notification for a card whose computer the record does not keep now, and every one while it keeps
    /// none. One that opened no card stays while a computer is kept, since no one knows whose it is.
    private func removeUnkept() async {
        await removeDelivered { shown in
            guard let held = self.held, let computers = held.computers else { return false }
            guard !computers.isEmpty else { return true }
            guard shown.cardID != nil else { return false }
            let owner = self.owner(named: shown.computer, in: held)
            return !computers.contains { $0.pin == owner }
        }
    }

    /// INF-5265: the computer a shown notification came from: the one it names, or for one that names none, shown
    /// before the phone kept a key per computer, the computer kept then (`PhonePushHeld.untagged`). None when it names
    /// none and no computer kept then is still kept, or the record cannot be read now: such a notification belongs to
    /// no computer, so a tap opens nothing and clearing leaves it.
    public func owner(named computer: String?) -> String? { computer ?? keep()?.untagged }

    private func owner(named computer: String?, in held: PhonePushHeld) -> String? { computer ?? held.untagged }

    /// iOS gave the push address: a new one, or one with no grant that lasts, asks the relay for a grant.
    public func tokenArrived(_ data: Data) async {
        let token = PhonePush.token(data)
        self.token = token
        guard let held = keep() else { return }
        if PhonePush.needsGrant(held, token: token, environment: environment, now: effects.now()) { await askRelay() }
        else { await handOver() }
    }

    /// A background push arrived; true when it carried the relay's grant, which is kept and handed on.
    @discardableResult public func pushArrived(_ userInfo: [AnyHashable: Any]) async -> Bool {
        guard var held = keep() else { return false }
        // A grant that wakes the app before iOS gave this run's address belongs to the address it last asked for.
        guard let grant = PhonePush.grant(inPush: userInfo),
              let named = askedFor ?? (token ?? held.token).map({ ($0, environment) }) else { return false }
        held.token = named.token; held.environment = named.environment; held.grant = grant
        guard commit(held) else { return false }
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
        guard let held = keep(), let opened = held.openers.lazy.compactMap({ opener in
            PhonePush.withdrawal(inPush: userInfo, key: opener.key).map { ($0, opener.computer?.pin) }
        }).first else { return false }
        let (withdrawal, computer) = opened
        let named = Set(withdrawal.cards.flatMap { card in card.pushes.map { "\(card.cardId) \($0)" } })
        await removeDelivered { shown in
            guard let card = shown.cardID, let push = shown.push, named.contains("\(card) \(push)") else { return false }
            // A record from before a key per computer opens with its one key, whose computer is every notification's.
            guard let computer else { return true }
            return self.owner(named: shown.computer, in: held) == computer
        }
        return true
    }

    /// Removes the notifications for cards no longer on the stage or already seen, once the computer's cards are read
    /// and again whenever one is seen (INF-5209's plan, piece 1): a card seen anywhere needs no notification left on the phone.
    /// INF-5265: only `computer`'s notifications (`owner(named:)`); one that opened no card names no computer, so it
    /// goes only while the phone keeps one computer.
    public func clear(stage: [PhoneCard], seen: (PhoneCard) -> Bool, computer: String) async {
        let due = Set(stage.filter { !seen($0) }.map(\.id))
        guard let held = keep() else { return }
        let one = (held.computers?.count ?? 0) <= 1
        await removeDelivered { shown in
            guard let card = shown.cardID else { return one }
            return self.owner(named: shown.computer, in: held) == computer && !due.contains(card)
        }
    }

    private func update() {
        asking = hand != nil && permission == .notAsked && !effects.askedPerson()
    }

    /// The held record, made on first use and kept so the notification part can open pushes; nil while the Keychain
    /// cannot read it, which is asked again next time rather than taken for none.
    private func keep() -> PhonePushHeld? {
        if let held { return held }
        do {
            if let found = try effects.load() { held = found; return found }
        } catch { return nil }
        return commit(PhonePushHeld(key: PhonePushSeal.newKey())) ? held : nil
    }

    /// Hands the computer what the phone holds: the registration while notifications are on and a grant is held,
    /// null while they are off in the phone's Settings, and nothing before iOS has asked.
    private func handOver() async {
        guard let hand, let permission else { return }
        switch permission {
        case .notAsked: return
        case .off: _ = try? await hand(nil)
        case .on:
            guard let held = keep(), let token = token ?? held.token,
                  var registration = PhonePush.registration(held, token: token, environment: environment, now: effects.now(),
                                                            computer: reaching) else { return }
            registration.withdrawals = homeTakesWithdrawals
            guard let kept = try? await hand(registration), !kept else { return }
            // The computer did not keep the grant: the relay refused it this run, so the phone asks for a new one. The
            // record is read again after the wait, and only that grant goes, so a key kept or forgotten meanwhile stays.
            guard var forgotten = keep(), forgotten.grant == registration.grant else { return }
            forgotten.grant = nil
            guard commit(forgotten) else { return }
            await askRelay()
        }
    }

    /// Asks the relay to send this address a grant, at most once every `askEvery`.
    private func askRelay() async {
        guard let token, permission == .on, var held = keep() else { return }
        let now = effects.now()
        if let asked = held.asked, now.timeIntervalSince(asked) < PhonePush.askEvery { return }
        held.asked = now
        // An ask the phone could not note waits, so a failing write never asks the relay more than once an hour.
        guard commit(held) else { return }
        askedFor = (token, environment)
        let body = try? JSONSerialization.data(withJSONObject: ["token": token, "environment": environment.rawValue])
        // 202: the grant comes by a background push. Anything else waits for the next ask.
        _ = await effects.post(PhonePush.register, body ?? Data())
    }
}
