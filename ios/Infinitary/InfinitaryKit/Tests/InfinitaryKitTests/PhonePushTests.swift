import Foundation
import Security
import Testing
@testable import InfinitaryKit

/// INF-4794, the phone's half of card pushes (docs/phone-push.md, INF-4774's approved plan): the notification part opens
/// what the computer sealed, the phone asks the relay for a grant only when it holds none that lasts for its address
/// and service or its computer did not keep it, hands its grant on every welcome, and tells its computer to stop while
/// notifications for Infinitary are off in the phone's Settings.
struct PhonePushTests {
    /// Pushes sealed by the computer's own `sealCardPush` (src/core/phonePush.ts), with the key they were sealed under.
    private struct Sealed: Decodable {
        struct Push: Decodable { let sealed: String }
        struct Withdrawal: Decodable { let sealed: String; let opens: PhonePushWithdrawal }
        let key: String
        let card: Push
        let reply: Push
        let otherKey: Push
        let withdrawal: Withdrawal
        let otherKeyWithdrawal: Push
        let secondKey: String
        let second: Push
        let secondWithdrawal: Withdrawal
    }

    private func sealed() throws -> Sealed {
        let url = try #require(Bundle.module.url(forResource: "PhonePush", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Sealed.self, from: Data(contentsOf: url))
    }

    /// A push as the relay sends it to Apple (its contract, `POST /v1/push`).
    private func relayed(_ sealed: String) -> [AnyHashable: Any] {
        ["aps": ["alert": ["body": "A card is ready"], "sound": "default", "mutable-content": 1], "sealed": sealed]
    }

    // An Apple push address is 32 bytes today; a grant is its expiry in seconds, a dot and a 43-character signature.
    private let address = Data((0..<32).map { UInt8(($0 * 37 + 11) % 256) })
    private var token: String { PhonePush.token(address) }
    private let now = Date(timeIntervalSince1970: 1_795_000_000)
    private func grant(expiring days: Double) -> String {
        "\(Int(now.timeIntervalSince1970 + days * 86_400)).Dy98c6Z0_-kag0UUqCPONV9N3A2aRCMVgIl-3H8xsb8"
    }

    @Test func opensWhatTheComputerSealedForThisPhone() throws {
        let fixture = try sealed()
        let card = PhonePushSeal.notice(relayed(fixture.card.sealed), key: fixture.key)
        #expect(card == PhonePushNotice(title: "Plan the launch week", body: "Three dates fit; pick one.",
                                        cardID: "card-7f3a9c1e-plan-launch-week"))
        let reply = PhonePushSeal.notice(relayed(fixture.reply.sealed), key: fixture.key)
        #expect(reply?.title == "Überarbeitung des Onboardings – 初回起動の見直し")
        #expect(reply?.cardID == "card-2b81d0aa-review-onboarding")
        // The notification keeps which push of the card it shows; an older computer's push names none.
        #expect(reply?.push == "q3Vn8yLk0TfA")
        #expect(card?.push == nil)
    }

    /// The notification then keeps the relay's own words, "A card is ready", and opens no card.
    @Test func opensNothingForAPushItCannotOpen() throws {
        let fixture = try sealed()
        // Sealed for another key, with no key kept yet, cut short, or with no sealed text at all.
        #expect(PhonePushSeal.notice(relayed(fixture.otherKey.sealed), key: fixture.key) == nil)
        #expect(PhonePushSeal.notice(relayed(fixture.card.sealed), key: nil) == nil)
        #expect(PhonePushSeal.notice(relayed(String(fixture.card.sealed.dropLast(8))), key: fixture.key) == nil)
        #expect(PhonePushSeal.notice(["aps": ["alert": ["body": "A card is ready"]]], key: fixture.key) == nil)
    }

    @Test func asksForAGrantOnlyWhenNoneLastsForThisAddressAndService() {
        let held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        #expect(!PhonePush.needsGrant(held, token: token, environment: .production, now: now))
        #expect(PhonePush.registration(held, token: token, environment: .production, now: now)?.grant == held.grant)
        // Nothing held yet, a new push address, the other service, a grant in its last days, and an expired one.
        #expect(PhonePush.needsGrant(PhonePushHeld(key: held.key), token: token, environment: .production, now: now))
        #expect(PhonePush.needsGrant(held, token: String(repeating: "ab", count: 32), environment: .production, now: now))
        #expect(PhonePush.needsGrant(held, token: token, environment: .development, now: now))
        var ending = held; ending.grant = grant(expiring: 2)
        #expect(PhonePush.needsGrant(ending, token: token, environment: .production, now: now))
        #expect(PhonePush.registration(ending, token: token, environment: .production, now: now) != nil)
        var expired = held; expired.grant = grant(expiring: -1)
        #expect(PhonePush.registration(expired, token: token, environment: .production, now: now) == nil)
    }

    @Test func readsItsServiceFromTheBuildsProvisioningProfile() {
        // A provisioning profile is a signed envelope around its property list; only the list is read.
        func profile(_ aps: String) -> Data {
            Data([0x30, 0x82, 0x2b, 0x5e, 0x06, 0x09]) + Data("""
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0"><dict><key>AppIDName</key><string>Infinitary</string>
            <key>Entitlements</key><dict><key>application-identifier</key><string>9T2J7MNUP9.com.getinfinitary.infinitary</string>
            <key>aps-environment</key><string>\(aps)</string></dict></dict></plist>
            """.utf8) + Data([0xa0, 0x82, 0x0e, 0x01])
        }
        #expect(PhonePush.environment(profile: profile("development")) == .development)
        #expect(PhonePush.environment(profile: profile("production")) == .production)
        // TestFlight and App Store builds carry no profile.
        #expect(PhonePush.environment(profile: nil) == .production)
    }

    /// What the phone's pushes did outside, recorded.
    @MainActor private final class Outside {
        var permission = PhonePushPermission.on
        var allowsWhenAsked = true
        var held: PhonePushHeld?
        var askedPerson = false
        var registered = 0
        var unregistered = 0
        var askedIOS = 0
        var posts: [[String: String]] = []
        var handed: [PhonePushRegistration?] = []
        var keeps = true
        /// The Keychain cannot read the record now, as before the phone's first unlock.
        var locked = false
        /// The Keychain refuses writes now.
        var refusesWrites = false
        var delivered: [(id: String, cardID: String?, push: String?, computer: String?)] = []
        var removed: [String] = []
        var now = Date(timeIntervalSince1970: 1_795_000_000)
        /// INF-5275: each letter posted to the relay's letter request, and its answers in turn (204 once they run out).
        var letters: [[String: String]] = []
        var letterAnswers: [Int?] = []
        var waits: [TimeInterval] = []

        func pushes(_ environment: PhonePushEnvironment = .production) -> PhonePushes {
            let posted: @Sendable (URL, Data) async -> Int? = { [weak self] url, body in
                await MainActor.run {
                    let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: String] ?? [:]
                    guard let self else { return 202 }
                    if url.absoluteString == "https://push.getinfinitary.com/v1/letter" {
                        self.letters.append(fields)
                        return self.letterAnswers.isEmpty ? 204 : self.letterAnswers.removeFirst()
                    }
                    #expect(url.absoluteString == "https://push.getinfinitary.com/v1/register")
                    self.posts.append(fields)
                    return 202
                }
            }
            return PhonePushes(effects: PhonePushEffects(
                permission: { self.permission },
                askPermission: { self.askedIOS += 1; self.permission = self.allowsWhenAsked ? .on : .off; return self.allowsWhenAsked },
                registerForPushes: { self.registered += 1 }, unregisterForPushes: { self.unregistered += 1 },
                post: posted,
                load: {
                    if self.locked { throw PhonePushStore.Unreadable(status: errSecInteractionNotAllowed) }
                    return self.held
                },
                save: {
                    if self.locked || self.refusesWrites { throw PhonePushStore.Unreadable(status: errSecInteractionNotAllowed) }
                    self.held = $0
                },
                askedPerson: { self.askedPerson }, noteAskedPerson: { self.askedPerson = true },
                delivered: { self.delivered }, remove: { self.removed += $0 },
                now: { self.now },
                wait: { [weak self] seconds in await MainActor.run { self?.waits.append(seconds) } }), environment: environment)
        }

        func hand(_ registration: PhonePushRegistration?) async throws -> Bool {
            handed.append(registration)
            return registration != nil && keeps
        }

        func grantPush(_ grant: String) -> [AnyHashable: Any] { ["aps": ["content-available": 1], "grant": grant] }
    }

    @MainActor @Test func asksTheRelayOnceAndHandsItsGrantOnEveryWelcome() async throws {
        let outside = Outside()
        let pushes = outside.pushes()
        // INF-5265: the app hands the push record its computer before it opens; the address is asked for only then.
        await pushes.kept([studio])?.value
        await pushes.opened()
        #expect(outside.registered == 1)
        await pushes.tokenArrived(address)
        #expect(outside.posts == [["token": token, "environment": "production"]])
        // The relay's grant arrives by a background push and goes to the computer at once.
        await pushes.reached(computer: studio.pin, takesPushes: true, hand: outside.hand)
        #expect(outside.handed.isEmpty)
        #expect(await pushes.pushArrived(outside.grantPush(grant(expiring: 30))))
        let key = try #require(outside.held?.computers?.first?.key)
        #expect(outside.handed == [PhonePushRegistration(token: token, environment: .production, grant: grant(expiring: 30), key: key)])
        // The next run's open, address and welcome hand the same grant and ask the relay nothing.
        let next = outside.pushes()
        await next.kept([studio])?.value
        await next.opened()
        await next.tokenArrived(address)
        await next.reached(computer: studio.pin, takesPushes: true, hand: outside.hand)
        #expect(outside.posts.count == 1)
        #expect(outside.handed.last??.grant == grant(expiring: 30))
        #expect(outside.handed.last??.key == key)
    }

    @MainActor @Test func asksAgainWhenItsComputerDidNotKeepTheGrant() async {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production,
                                     grant: grant(expiring: 20), asked: now.addingTimeInterval(-10 * 86_400))
        outside.keeps = false
        let pushes = outside.pushes()
        await pushes.opened()
        await pushes.tokenArrived(address)
        #expect(outside.posts.isEmpty)
        await pushes.reached(takesPushes: true, hand: outside.hand)
        #expect(outside.posts.count == 1)
        #expect(outside.held?.grant == nil)
        // A second refusal within the hour waits: each ask costs one of Apple's few background pushes an hour.
        outside.held?.grant = grant(expiring: 30)
        let again = outside.pushes()
        await again.opened()
        await again.tokenArrived(address)
        await again.reached(takesPushes: true, hand: outside.hand)
        #expect(outside.handed.count == 2)
        #expect(outside.posts.count == 1)
        outside.now = outside.now.addingTimeInterval(PhonePush.askEvery)
        outside.held?.grant = grant(expiring: 30)
        let later = outside.pushes()
        await later.opened()
        await later.tokenArrived(address)
        await later.reached(takesPushes: true, hand: outside.hand)
        #expect(outside.posts.count == 2)
    }

    @MainActor @Test func tellsItsComputerToStopWhileNotificationsAreOffInSettings() async {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        outside.permission = .off
        let pushes = outside.pushes()
        await pushes.opened()
        #expect(outside.registered == 0)
        // Null at each welcome while they are off, and at an open while the computer is in reach.
        await pushes.reached(takesPushes: true, hand: outside.hand)
        await pushes.opened()
        #expect(outside.handed == [nil, nil])
        #expect(outside.posts.isEmpty)
        // Turned back on in Settings: the next open hands the grant again.
        outside.permission = .on
        await pushes.opened()
        await pushes.tokenArrived(address)
        #expect(outside.handed.last??.grant == grant(expiring: 20))
    }

    @MainActor @Test func asksThePersonOnceAfterJoiningAComputerThatPushes() async {
        let outside = Outside()
        outside.permission = .notAsked
        let pushes = outside.pushes()
        await pushes.opened()
        #expect(!pushes.asking)
        // A computer without the change asks nothing of the phone, which names it for an update instead.
        await pushes.reached(takesPushes: false, hand: outside.hand)
        #expect(!pushes.asking)
        #expect(!pushes.homeTakesPushes)
        await pushes.reached(takesPushes: true, hand: outside.hand)
        #expect(pushes.asking)
        #expect(outside.handed.isEmpty)
        await pushes.answer(false)
        #expect(!pushes.asking)
        #expect(outside.askedIOS == 0)
        await pushes.reached(takesPushes: true, hand: outside.hand)
        #expect(!pushes.asking)
        // Settings' Turn on goes to iOS's own question; a no there hands the computer null.
        outside.allowsWhenAsked = false
        await pushes.turnOn()
        #expect(outside.askedIOS == 1)
        #expect(outside.handed == [nil])
    }

    /// A tap opens that card on Home, as the in-app pill's tap does.
    @Test func aTapFindsItsCardAfterInReachOnTheStackOrInPast() {
        let stack = ["card-7f3a9c1e-plan-launch-week", "card-2b81d0aa-review-onboarding"]
        // Infinitary was closed: the tap waits until the computer's cards are read.
        #expect(ReadOnlySession.pushOpening(stack[0], contact: "reaching", stack: []) == .onReach)
        #expect(ReadOnlySession.pushOpening(stack[0], contact: "lost", stack: stack) == .onReach)
        #expect(ReadOnlySession.pushOpening(stack[1], contact: "in-reach", stack: stack) == .stack)
        // Answered on the computer meanwhile, so it left the stage: Past has it.
        #expect(ReadOnlySession.pushOpening("card-5c02e4f1-answered", contact: "in-reach", stack: stack) == .past)
    }

    /// The captain's answer on INF-4794's review: "if i forget a computer, then the phone app should stop showing any
    /// push notifications from that home".
    @MainActor @Test func forgettingAComputerStopsItsNotifications() async throws {
        let outside = Outside()
        let key = PhonePushSeal.newKey()
        outside.held = PhonePushHeld(key: key, token: token, environment: .production, grant: grant(expiring: 20))
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", nil, nil), ("n2", nil, nil, nil)]
        let pushes = outside.pushes()
        await pushes.reached(takesPushes: true, hand: outside.hand)
        await pushes.opened()
        #expect(outside.handed.last??.key == key)

        await pushes.forgot()
        // The phone gives up its address; once iOS gives a new one, the relay tells that computer it reaches no phone.
        #expect(outside.unregistered == 1)
        // A push already on its way was sealed for the old key, which the phone no longer holds.
        let fresh = try #require(outside.held)
        #expect(fresh.key != key && fresh.grant == nil && fresh.token == nil)
        #expect(outside.removed == ["n1", "n2"])

        // The next computer it joins in the same sitting asks iOS for an address, then gets a new grant and key.
        let handedBefore = outside.handed.count
        let registeredBefore = outside.registered
        pushes.kept([office])
        await pushes.reached(computer: office.pin, takesPushes: true, hand: outside.hand)
        #expect(outside.registered == registeredBefore + 1)
        #expect(outside.handed.count == handedBefore, "No registration to hand before the new address has its grant")
        let nextAddress = Data(repeating: 0xcd, count: 32)
        let next = PhonePush.token(nextAddress)
        await pushes.tokenArrived(nextAddress)
        #expect(outside.posts.last?["token"] == next)
        await pushes.pushArrived(outside.grantPush(grant(expiring: 30)))
        #expect(outside.handed.last??.token == next)
        let officeKey = try #require(outside.held?.computers?.first?.key)
        #expect(officeKey != key)
        #expect(outside.handed.last??.key == officeKey)
    }

    /// The captain's answer on INF-4794's review: show the notification when Infinitary is open but out of reach.
    @Test func aPushShowsInFrontOnlyAwayFromItsComputer() {
        let card = "card-7f3a9c1e-plan-launch-week"
        #expect(!PhonePush.showsInFront(contact: "in-reach", cardID: card))
        #expect(PhonePush.showsInFront(contact: "reaching", cardID: card))
        #expect(PhonePush.showsInFront(contact: "lost", cardID: card))
        // No computer joined: the push comes from one this phone forgot.
        #expect(!PhonePush.showsInFront(contact: nil, cardID: card))
        // The notification part could not open it, so it names no card of this phone's computer.
        #expect(!PhonePush.showsInFront(contact: "lost", cardID: nil))
    }

    /// A withdrawal as the relay sends it to Apple (its contract, `POST /v1/withdraw`): silent, with only the sealed text.
    private func silent(_ sealed: String) -> [AnyHashable: Any] { ["aps": ["content-available": 1], "sealed": sealed] }

    /// INF-5209's plan, piece 3: the computer's sealed withdrawal names the cards whose notifications go.
    @Test func opensAWithdrawalTheComputerSealedForThisPhone() throws {
        let fixture = try sealed()
        #expect(PhonePush.withdrawal(inPush: silent(fixture.withdrawal.sealed), key: fixture.key)?.cards
                == fixture.withdrawal.opens.cards)
        #expect(fixture.withdrawal.opens.cards.map(\.cardId) == ["card-2b81d0aa-review-onboarding", "card-7f3a9c1e-plan-launch-week"])
        // Sealed for another key, a card push, a grant push, and a withdrawal cut short open as no withdrawal.
        #expect(PhonePush.withdrawal(inPush: silent(fixture.otherKeyWithdrawal.sealed), key: fixture.key) == nil)
        #expect(PhonePush.withdrawal(inPush: relayed(fixture.card.sealed), key: fixture.key) == nil)
        #expect(PhonePush.withdrawal(inPush: ["aps": ["content-available": 1], "grant": grant(expiring: 30)], key: fixture.key) == nil)
        #expect(PhonePush.withdrawal(inPush: silent(String(fixture.withdrawal.sealed.dropLast(8))), key: fixture.key) == nil)
        // A withdrawal is not a card: the notification part never shows it as one.
        #expect(PhonePushSeal.notice(silent(fixture.withdrawal.sealed), key: fixture.key) == nil)
    }

    @MainActor @Test func aWithdrawalRemovesOnlyTheNotificationsItNames() async throws {
        let fixture = try sealed()
        let outside = Outside()
        outside.held = PhonePushHeld(key: fixture.key, token: token, environment: .production, grant: grant(expiring: 20))
        // The pushes the withdrawal names, an unseen card's, one that opened no card, and an older computer's push.
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", "Hs2pW9cXe4Rm", nil),
                             ("n2", "card-5c02e4f1-pick-venue", "Xa0vB3nM6pQe", nil),
                             ("n3", "card-2b81d0aa-review-onboarding", "q3Vn8yLk0TfA", nil),
                             ("n4", nil, nil, nil),
                             ("n5", "card-7f3a9c1e-plan-launch-week", "b7JtQ0uZa1Nd", nil),
                             ("n6", "card-7f3a9c1e-plan-launch-week", nil, nil)]
        let pushes = outside.pushes()
        #expect(!(await pushes.withdrawArrived(silent(fixture.otherKeyWithdrawal.sealed))))
        #expect(outside.removed.isEmpty)
        #expect(await pushes.withdrawArrived(silent(fixture.withdrawal.sealed)))
        // The unseen card's notification, one that names no card, and one that names no push stay.
        #expect(outside.removed == ["n1", "n3", "n5"])
    }

    /// INF-5235's review, and the captain's choice to clear only the original alert: Apple may deliver an author's newer
    /// reply before an older, slower withdrawal that names its card; the reply's notification stays.
    @MainActor @Test func anOlderWithdrawalKeepsANewerNotificationOfItsCard() async throws {
        let fixture = try sealed()
        let outside = Outside()
        outside.held = PhonePushHeld(key: fixture.key, token: token, environment: .production, grant: grant(expiring: 20))
        // A newer reply of the onboarding card: its own push, which the withdrawal does not name.
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", "Hs2pW9cXe4Rm", nil),
                             ("n2", "card-2b81d0aa-review-onboarding", "Zr5kD1wYt8Lc", nil)]
        #expect(await outside.pushes().withdrawArrived(silent(fixture.withdrawal.sealed)))
        #expect(outside.removed == ["n1"])
    }

    /// INF-5235's review: what the notification part keeps on a notification it opened is what the app reads back,
    /// so a withdrawal finds the push it names, and a newer reply's notification of the same card stays.
    @MainActor @Test func theNotificationPartKeepsWhichPushTheAppReadsBack() async throws {
        let fixture = try sealed()
        let older = try #require(PhonePushSeal.notice(relayed(fixture.reply.sealed), key: fixture.key))
        let newer = PhonePushNotice(title: older.title, body: older.body, cardID: older.cardID, push: "Zr5kD1wYt8Lc")
        let olderShown = PhonePushSeal.shown(PhonePushSeal.userInfo(for: older))
        let newerShown = PhonePushSeal.shown(PhonePushSeal.userInfo(for: newer))
        #expect(olderShown.cardID == "card-2b81d0aa-review-onboarding")
        #expect(olderShown.push == "q3Vn8yLk0TfA")
        let outside = Outside()
        outside.held = PhonePushHeld(key: fixture.key, token: token, environment: .production, grant: grant(expiring: 20))
        outside.delivered = [("n1", olderShown.cardID, olderShown.push, nil), ("n2", newerShown.cardID, newerShown.push, nil)]
        #expect(await outside.pushes().withdrawArrived(silent(fixture.withdrawal.sealed)))
        #expect(outside.removed == ["n1"])
    }

    /// An older computer's registration refuses a field it does not know, so the phone says it takes withdrawals only
    /// to a computer that lists `phone-push-withdraw`.
    @MainActor @Test func saysItTakesWithdrawalsOnlyToAComputerThatListsThem() async {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        await pushes.opened()
        await pushes.tokenArrived(address)
        await pushes.reached(takesPushes: true, hand: outside.hand)
        #expect(outside.handed.last??.withdrawals == false)
        #expect(outside.handed.last??.argument["withdrawals"] == nil)
        await pushes.reached(takesPushes: true, takesWithdrawals: true, hand: outside.hand)
        #expect(outside.handed.last??.withdrawals == true)
        #expect(outside.handed.last??.argument["withdrawals"] as? Bool == true)
    }

    /// INF-5209's plan, piece 1: a card whose newest version was seen anywhere needs no notification left on the phone.
    @MainActor @Test func clearsNotificationsForCardsSeenOrNoLongerOnTheStage() async throws {
        func card(_ id: String, title: String, seen: Bool) throws -> PhoneCard {
            try PhoneCard(.object([
                "id": .string(id), "title": .string(title), "author": .string("firstmate"),
                "body": .string("<p>Three dates fit; pick one.</p>"), "actions": .array([]),
                "lifecycleId": .string("\(id)-life"), "currentUpdateId": .string("\(id)-update"), "currentUpdateSeen": .bool(seen)
            ]))
        }
        let stage = [try card("card-7f3a9c1e-plan-launch-week", title: "Plan the launch week", seen: false),
                     try card("card-9d4e6b20-renew-certificate", title: "Renew the signing certificate", seen: true)]
        let outside = Outside()
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", nil, nil), ("n2", "card-2b81d0aa-review-onboarding", nil, nil), ("n3", nil, nil, nil),
                             ("n4", "card-9d4e6b20-renew-certificate", nil, nil)]
        // The one computer kept: these notifications, shown before the phone kept a key per computer, are its own.
        let pushes = outside.pushes()
        pushes.kept([studio])
        await pushes.clear(stage: stage, seen: \.currentUpdateSeen, computer: studio.pin)
        // Kept: the unseen card on the stage. Gone: the card that left it, one naming no card, and the seen card.
        #expect(outside.removed == ["n2", "n3", "n4"])
    }

    // INF-5265 (docs/ios.md, "Several computers"): one phone keeps several computers, each sealing under its own key.
    private let office = (pin: "c2VwYXJhdGUtb2ZmaWNlLXBpbg", name: "Work computer")
    private let studio = (pin: "c2VwYXJhdGUtc3R1ZGlvLXBpbg", name: "Personal server")

    /// The notification part tries each kept computer's key: the one that opens a push names its computer, shown as
    /// the subtitle only while the phone keeps more than one.
    @Test func opensEachComputersPushUnderItsOwnKeyAndNamesIt() throws {
        let fixture = try sealed()
        let held = PhonePushHeld(key: fixture.key, computers: [
            PhonePushComputer(pin: studio.pin, name: studio.name, key: fixture.key),
            PhonePushComputer(pin: office.pin, name: office.name, key: fixture.secondKey)])
        let fromOffice = try #require(PhonePushSeal.notice(relayed(fixture.second.sealed), held: held))
        #expect(fromOffice == PhonePushNotice(title: "Decision · billing", body: "Pick the export job's retry limit",
                                              cardID: "card-41d6e0b2-export-retries", computer: office.pin, subtitle: office.name))
        #expect(fromOffice.userInfo[PhonePushSeal.computerKey] as? String == office.pin)
        #expect(fromOffice.userInfo[PhonePushSeal.cardKey] as? String == "card-41d6e0b2-export-retries")
        let fromStudio = try #require(PhonePushSeal.notice(relayed(fixture.card.sealed), held: held))
        #expect(fromStudio.computer == studio.pin && fromStudio.subtitle == studio.name)
        // Sealed under neither key: the relay's own words stay.
        #expect(PhonePushSeal.notice(relayed(fixture.otherKey.sealed), held: held) == nil)
        // With one computer kept the notification shows no subtitle, as before, and still names its computer for a tap.
        let one = PhonePushHeld(key: fixture.secondKey, computers: [PhonePushComputer(pin: office.pin, name: office.name, key: fixture.secondKey)])
        let alone = try #require(PhonePushSeal.notice(relayed(fixture.second.sealed), held: one))
        #expect(alone.subtitle == nil && alone.computer == office.pin)
        #expect(PhonePushSeal.notice(relayed(fixture.card.sealed), held: one) == nil)
        // A record kept before the phone kept several opens with its one key and names no computer.
        let before = try #require(PhonePushSeal.notice(relayed(fixture.card.sealed), held: PhonePushHeld(key: fixture.key)))
        #expect(before.computer == nil && before.subtitle == nil)
    }

    /// A phone with one computer moves to the list with no new key: that computer keeps the key it was handed. A second
    /// computer gets a key of its own at its own welcome, sharing the address and grant.
    @MainActor @Test func keepsTheOneComputersKeyAndGivesASecondItsOwn() async throws {
        let outside = Outside()
        let key = PhonePushSeal.newKey()
        outside.held = PhonePushHeld(key: key, token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        pushes.kept([studio])
        #expect(outside.held?.computers == [PhonePushComputer(pin: studio.pin, name: studio.name, key: key)])
        // The record's own key now belongs to no computer, so an older build hands no computer's key.
        #expect(outside.held?.key != key)
        await pushes.opened()
        await pushes.tokenArrived(address)
        await pushes.reached(computer: studio.pin, takesPushes: true, hand: outside.hand)
        #expect(outside.handed.last??.key == key)

        pushes.left()
        pushes.kept([office, studio])
        let officeKey = try #require(outside.held?.computers?.first { $0.pin == office.pin }?.key)
        #expect(officeKey != key)
        #expect(outside.held.map { held in held.computers?.contains { $0.key == held.key } } == false,
                "The record's own key is no computer's")
        await pushes.reached(computer: office.pin, takesPushes: true, hand: outside.hand)
        #expect(outside.handed.last??.key == officeKey)
        #expect(outside.handed.last??.grant == grant(expiring: 20))
        #expect(outside.posts.isEmpty, "One address and grant for every computer: no new ask of the relay")
        #expect(outside.unregistered == 0)
        // Renamed on the computer: the name follows; the key does not change.
        pushes.kept([(office.pin, "Work laptop"), studio])
        #expect(outside.held?.computers?.first { $0.pin == office.pin } == PhonePushComputer(pin: office.pin, name: "Work laptop", key: officeKey))
    }

    /// The captain's pick on INF-5265's review, "Keep keys separate": a computer added after another was forgotten gets a
    /// new key, never the forgotten one's or the record's own.
    @MainActor @Test func aComputerAddedLaterNeverTakesAnotherComputersKey() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        pushes.kept([studio])
        pushes.kept([studio, office])
        let studioKey = try #require(outside.held?.computers?.first?.key)
        let officeKey = try #require(outside.held?.computers?.last?.key)
        pushes.kept([office])
        let lab = (pin: "c2VwYXJhdGUtbGFiLXBpbi0", name: "Lab Mac")
        pushes.kept([office, lab])
        let held = try #require(outside.held)
        let labKey = try #require(held.computers?.first { $0.pin == lab.pin }?.key)
        #expect(![studioKey, officeKey, held.key].contains(labKey))
        // With no computer named, a record with a key per computer hands none.
        #expect(PhonePush.registration(held, token: token, environment: .production, now: outside.now) == nil)
    }

    /// A computer the phone keeps no key for yet is handed no registration, never another computer's key.
    @MainActor @Test func handsNoKeyToAComputerItKeepsNone() async {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        pushes.kept([studio])
        await pushes.opened()
        await pushes.tokenArrived(address)
        await pushes.reached(computer: office.pin, takesPushes: true, hand: outside.hand)
        #expect(outside.handed.isEmpty)
    }

    /// Reaching one computer clears only its own notifications for cards that left its stage; another computer's stay.
    /// A notification shown before the phone kept a key per computer names none: it is the computer's kept then, and
    /// one that opened no card, whose computer no one knows, stays while two are kept.
    @MainActor @Test func clearsOnlyTheReachedComputersNotifications() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        pushes.kept([studio])
        pushes.kept([studio, office])
        let stage = [try PhoneCard(.object([
            "id": .string("card-7f3a9c1e-plan-launch-week"), "title": .string("Plan the launch week"), "author": .string("firstmate"),
            "body": .string("<p>Three dates fit; pick one.</p>"), "actions": .array([]),
            "lifecycleId": .string("plan-launch-week-life"), "currentUpdateId": .string("plan-launch-week-update"), "currentUpdateSeen": .bool(false)
        ]))]
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", nil, studio.pin), ("n2", "card-2b81d0aa-review-onboarding", nil, studio.pin),
                             ("n3", "card-41d6e0b2-export-retries", nil, office.pin), ("n4", nil, nil, nil),
                             ("n5", "card-0e7e2c55-from-before", nil, nil)]
        await pushes.clear(stage: stage, seen: { _ in false }, computer: studio.pin)
        // n2 left the studio's stage and n5 came from the studio before; n3 is the office's; n4's computer is unknown.
        #expect(outside.removed == ["n2", "n5"])
        #expect(pushes.owner(named: nil) == studio.pin, "A tap on a notification from before shows the studio")
        outside.removed = []
        await pushes.clear(stage: [], seen: { _ in false }, computer: office.pin)
        #expect(outside.removed == ["n3"])
    }

    /// A withdrawal opens under the key of the computer that sealed it and removes only that computer's notifications
    /// of the pushes it names; another computer's notification stays even where its card and push read the same.
    @MainActor @Test func aWithdrawalRemovesOnlyItsOwnComputersNotifications() async throws {
        let fixture = try sealed()
        let outside = Outside()
        outside.held = PhonePushHeld(key: fixture.key, token: token, environment: .production, grant: grant(expiring: 20),
                                     computers: [PhonePushComputer(pin: studio.pin, name: studio.name, key: fixture.key),
                                                 PhonePushComputer(pin: office.pin, name: office.name, key: fixture.secondKey)])
        outside.delivered = [("n1", "card-41d6e0b2-export-retries", "Zr5dK2mWq8Tc", office.pin),
                             ("n2", "card-41d6e0b2-export-retries", "Zr5dK2mWq8Tc", studio.pin),
                             ("n3", "card-7f3a9c1e-plan-launch-week", "Hs2pW9cXe4Rm", studio.pin),
                             ("n4", "card-41d6e0b2-export-retries", "Qm4tY7aLp2Wx", office.pin)]
        let pushes = outside.pushes()
        #expect(await pushes.withdrawArrived(silent(fixture.secondWithdrawal.sealed)))
        #expect(outside.removed == ["n1"])
        outside.removed = []
        // The studio's own withdrawal, under the first key, still removes the studio's pushes it names.
        #expect(await pushes.withdrawArrived(silent(fixture.withdrawal.sealed)))
        #expect(outside.removed == ["n3"])
    }

    /// Forgetting the computer the notifications from before came from removes them too, and no later notification
    /// that names no computer is taken for it.
    @MainActor @Test func forgettingTheComputerFromBeforeRemovesItsUntaggedNotifications() async {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        await pushes.kept([studio])?.value
        await pushes.kept([office, studio])?.value
        outside.delivered = [("n1", "card-0e7e2c55-from-before", nil, nil), ("n2", "card-41d6e0b2-export-retries", nil, office.pin), ("n3", nil, nil, nil)]
        await pushes.forgot(computer: studio.pin)
        #expect(outside.removed == ["n1"])
        #expect(outside.held?.untagged == nil)
        #expect(pushes.owner(named: nil) == nil)
    }

    /// The list the app read is the phone's own (INF-5265's review): a computer missing from it was forgotten even if
    /// the app stopped before it let go of that computer's key, so its key and its notifications go now; an empty list
    /// lets go of the push address too, as forgetting the last computer does, and once only.
    @MainActor @Test func aListReadAfterAForgetCutShortLetsGoOfTheForgottenKeys() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        await pushes.kept([studio, office])?.value
        let officeKey = try #require(outside.held?.computers?.last?.key)
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", nil, studio.pin), ("n2", "card-41d6e0b2-export-retries", nil, office.pin),
                             ("n3", nil, nil, nil)]

        await pushes.kept([office])?.value
        #expect(outside.held?.computers == [PhonePushComputer(pin: office.pin, name: office.name, key: officeKey)])
        #expect(outside.held?.grant == grant(expiring: 20) && outside.unregistered == 0)
        #expect(outside.removed == ["n1"])

        outside.removed = []
        await pushes.kept([])?.value
        #expect(outside.held?.computers == [] && outside.held?.grant == nil && outside.held?.token == nil)
        #expect(outside.unregistered == 1)
        #expect(outside.removed == ["n1", "n2", "n3"])
        outside.removed = []
        await pushes.kept([])?.value
        #expect(outside.unregistered == 1, "An empty list read again lets go of nothing more")
    }

    /// A forget cut short after its key went but before its notifications did is finished by the next list: every
    /// notification for a card whose computer is not kept goes, one from before the phone kept a key per computer
    /// included, while a kept computer's and one that opened no card stay.
    @MainActor @Test func theNextListFinishesACleanupCutShort() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        await pushes.kept([office])?.value
        await pushes.kept([office, studio])?.value
        await pushes.forgot(computer: office.pin)
        outside.delivered = [("n1", "card-41d6e0b2-export-retries", nil, office.pin), ("n2", "card-0e7e2c55-from-before", nil, nil),
                             ("n3", "card-7f3a9c1e-plan-launch-week", nil, studio.pin), ("n4", nil, nil, nil)]
        await pushes.kept([studio])?.value
        #expect(outside.removed == ["n1", "n2"])
        outside.removed = []
        await pushes.kept([studio])?.value
        #expect(outside.removed == ["n1", "n2"], "Each list removes what is still shown, so a removal cut short is tried again")
    }

    /// A cleanup reads who is kept once iOS answered: a pass begun before a computer was joined leaves that computer's
    /// notifications, and an empty list's pass removes nothing of a computer joined meanwhile.
    @MainActor @Test func aCleanupKeepsTheNotificationsOfAComputerJoinedMeanwhile() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        await pushes.kept([studio])?.value
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", nil, studio.pin), ("n2", "card-41d6e0b2-export-retries", nil, office.pin)]
        let emptied = pushes.kept([])
        let narrowed = pushes.kept([office])
        await emptied?.value
        await narrowed?.value
        #expect(outside.removed == ["n1", "n1"])
    }

    /// Opening Infinitary asks iOS for the push address only while a computer is kept, so it never takes back the
    /// address the last forget gave up.
    @MainActor @Test func opensWithoutAnAddressWhileNoComputerIsKept() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        await pushes.kept([studio])?.value
        await pushes.kept([])?.value
        await pushes.opened()
        #expect(outside.registered == 0)
        pushes.kept([office])
        await pushes.opened()
        #expect(outside.registered == 1)
    }

    /// A write the Keychain refuses changes nothing the notification part or a computer sees: no new computer's key is
    /// handed and a forgotten one's key stays until a write lands, which the next list tries again.
    @MainActor @Test func aWriteTheKeychainRefusesIsTriedAgainByTheNextList() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        pushes.kept([studio])
        let saved = try #require(outside.held)
        outside.refusesWrites = true
        pushes.kept([studio, office])
        await pushes.opened()
        await pushes.tokenArrived(address)
        await pushes.reached(computer: office.pin, takesPushes: true, hand: outside.hand)
        #expect(outside.handed.isEmpty, "No key is handed before the notification part can read it")
        await pushes.forgot(computer: studio.pin)
        #expect(outside.held == saved)
        outside.refusesWrites = false
        pushes.kept([office])
        await pushes.reached(computer: office.pin, takesPushes: true, hand: outside.hand)
        let officeKey = try #require(outside.held?.computers?.first { $0.pin == office.pin }?.key)
        #expect(outside.held?.computers?.map(\.pin) == [office.pin])
        #expect(outside.handed.last??.key == officeKey)
    }

    /// A record the Keychain cannot read now, as before the first unlock, is never taken for none: nothing new is
    /// made or saved over it, and once it can be read every computer keeps its key.
    @MainActor @Test func aRecordItCannotReadNowKeepsEveryKey() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        outside.pushes().kept([studio, office])
        let saved = try #require(outside.held)
        outside.locked = true
        let pushes = outside.pushes()
        pushes.kept([studio])
        #expect(pushes.owner(named: nil) == nil)
        await pushes.tokenArrived(address)
        #expect(await pushes.pushArrived(outside.grantPush(grant(expiring: 30))) == false)
        await pushes.forgot(computer: office.pin)
        #expect(outside.held == saved)
        outside.locked = false
        await pushes.reached(computer: office.pin, takesPushes: true, hand: outside.hand)
        await pushes.opened()
        #expect(outside.handed.last??.key == saved.computers?.last?.key)
    }

    /// Forgetting a computer that is not shown leaves the handover with the one shown, so a new grant still reaches it.
    @MainActor @Test func forgettingAComputerNotShownKeepsTheShownOnesHandover() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        pushes.kept([studio, office])
        await pushes.opened()
        await pushes.tokenArrived(address)
        await pushes.reached(computer: studio.pin, takesPushes: true, hand: outside.hand)
        let studioKey = try #require(outside.held?.computers?.first?.key)
        await pushes.forgot(computer: office.pin)
        let handed = outside.handed.count
        #expect(await pushes.pushArrived(outside.grantPush(grant(expiring: 30))))
        #expect(outside.handed.count == handed + 1)
        #expect(outside.handed.last??.grant == grant(expiring: 30) && outside.handed.last??.key == studioKey)
    }

    /// A computer's answer that it did not keep the grant drops that grant alone: a key kept meanwhile stays.
    @MainActor @Test func aRefusedGrantKeepsAKeyKeptWhileItWasHanded() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        pushes.kept([studio])
        await pushes.opened()
        await pushes.tokenArrived(address)
        await pushes.reached(computer: studio.pin, takesPushes: true) { _ in
            // The person joined another computer while this answer was on its way.
            pushes.kept([self.office, self.studio])
            return false
        }
        let held = try #require(outside.held)
        #expect(held.grant == nil)
        #expect(held.computers?.map(\.pin) == [studio.pin, office.pin])
    }

    /// Forgetting one of two computers drops only its key and its notifications; the address and grant stay for the
    /// other. Forgetting the last gives up the address as before.
    @MainActor @Test func forgettingOneOfSeveralKeepsTheAddress() async throws {
        let outside = Outside()
        let key = PhonePushSeal.newKey()
        outside.held = PhonePushHeld(key: key, token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        await pushes.kept([studio, office])?.value
        let officeKey = try #require(outside.held?.computers?.last?.key)
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", nil, studio.pin), ("n2", "card-41d6e0b2-export-retries", nil, office.pin)]

        await pushes.forgot(computer: studio.pin)
        #expect(outside.unregistered == 0)
        #expect(outside.removed == ["n1"])
        let held = try #require(outside.held)
        #expect(held.computers == [PhonePushComputer(pin: office.pin, name: office.name, key: officeKey)])
        #expect(held.key != key && held.key != officeKey, "The forgotten computer's key is kept nowhere")
        #expect(held.token == token && held.grant == grant(expiring: 20))

        outside.removed = []
        await pushes.forgot(computer: office.pin)
        #expect(outside.unregistered == 1)
        #expect(outside.removed == ["n1", "n2"])
        #expect(outside.held?.grant == nil && outside.held?.computers == [] && outside.held?.key != officeKey)
    }

    /// A push from a kept computer the phone does not show shows in front, since the in-app notice cannot show it.
    @Test func aPushFromAComputerNotShownShowsInFront() {
        let card = "card-41d6e0b2-export-retries"
        #expect(PhonePush.showsInFront(contact: "in-reach", cardID: card, computer: office.pin, shown: studio.pin))
        #expect(!PhonePush.showsInFront(contact: "in-reach", cardID: card, computer: studio.pin, shown: studio.pin))
        #expect(!PhonePush.showsInFront(contact: "in-reach", cardID: card, computer: nil, shown: studio.pin))
    }

    // INF-5275's plan, piece 2 (docs/phone-push.md, "Letters"): the phone leaves each kept computer a sealed letter at
    // the relay, so a computer it does not show still learns a renewed grant or a new push address, or that it was
    // forgotten.

    /// Letters sealed by the phone's own `PhonePush.sealLetter`, which src/core/phoneLetters.test.ts opens.
    private struct Letters: Decodable {
        struct Letter: Decodable { let sealed: String; let opens: PhonePushLetter }
        struct Sealed: Decodable { let sealed: String }
        let key: String
        let box: String
        let otherKey: String
        let otherBox: String
        let renew: Letter
        let stop: Letter
        /// The renew letter as the computer's own `sealLetter` seals it (src/core/phoneLetters.ts).
        let computerSealed: Sealed
    }

    @Test func opensTheLettersItSealedInTheBoxBothSidesName() throws {
        let url = try #require(Bundle.module.url(forResource: "PhonePushLetters", withExtension: "json", subdirectory: "Fixtures"))
        let fixture = try JSONDecoder().decode(Letters.self, from: Data(contentsOf: url))
        #expect(PhonePush.letterBox(key: fixture.key) == fixture.box)
        #expect(PhonePush.letterBox(key: fixture.otherKey) == fixture.otherBox)
        #expect(PhonePush.openLetter(fixture.renew.sealed, key: fixture.key) == fixture.renew.opens)
        #expect(PhonePush.openLetter(fixture.stop.sealed, key: fixture.key) == fixture.stop.opens)
        #expect(PhonePush.openLetter(fixture.renew.sealed, key: fixture.otherKey) == nil)
        #expect(PhonePush.openLetter(fixture.computerSealed.sealed, key: fixture.key) == fixture.renew.opens)
        #expect(fixture.renew.opens == .renew(token: "5f3c8e1a9b2d4c6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e",
                                              environment: .production,
                                              grant: "1797811200.Dy98c6Z0_-kag0UUqCPONV9N3A2aRCMVgIl-3H8xsb8",
                                              at: 1_795_000_000_123))
    }

    /// The letter one post carries, opened with the key of the computer whose box it names.
    private func letter(_ posted: [String: String], keys: [String]) -> (key: String, letter: PhonePushLetter)? {
        for key in keys where posted["box"] == PhonePush.letterBox(key: key) {
            guard let sealed = posted["sealed"], let letter = PhonePush.openLetter(sealed, key: key) else { return nil }
            return (key, letter)
        }
        return nil
    }

    @MainActor @Test func writesEachKeptComputerALetterAfterANewGrantAndOnlyThen() async throws {
        let outside = Outside()
        let pushes = outside.pushes()
        await pushes.kept([studio, office])?.value
        await pushes.opened()
        await pushes.tokenArrived(address)
        #expect(outside.letters.isEmpty, "No grant is held yet")
        #expect(await pushes.pushArrived(outside.grantPush(grant(expiring: 30))))
        let keys = try #require(outside.held?.computers?.map(\.key))
        #expect(outside.letters.count == 2)
        let opened = outside.letters.compactMap { letter($0, keys: keys) }
        #expect(Set(opened.map(\.key)) == Set(keys), "One letter to each computer's own box")
        for (posted, (_, sealed)) in zip(outside.letters, opened) {
            #expect(posted["token"] == token && posted["environment"] == "production" && posted["grant"] == grant(expiring: 30))
            #expect(sealed.kind == "renew" && sealed.token == token && sealed.environment == .production)
            #expect(sealed.grant == grant(expiring: 30))
            // Nothing but the box names the computer: no key or pin crosses to the relay.
            for key in keys { #expect(!posted.values.contains(key)) }
        }
        #expect(opened[1].letter.at > opened[0].letter.at)
        #expect(outside.held?.computers?.allSatisfy { $0.lettered == grant(expiring: 30) } == true)

        // Lettered with the grant held: the next opens write nothing.
        await pushes.opened()
        let next = outside.pushes()
        await next.kept([studio, office])?.value
        await next.opened()
        #expect(outside.letters.count == 2)
        // The next grant goes to both again.
        outside.now = outside.now.addingTimeInterval(PhonePush.askEvery)
        #expect(await next.pushArrived(outside.grantPush(grant(expiring: 31))))
        #expect(outside.letters.count == 4)
    }

    @MainActor @Test func writesAtOpenOnlyToAComputerWhoseLastLetterPredatesTheGrant() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        await pushes.kept([studio, office])?.value
        outside.held?.computers?[0].lettered = grant(expiring: 20)
        outside.held?.computers?[1].lettered = grant(expiring: 10)
        let officeKey = try #require(outside.held?.computers?[1].key)
        let again = outside.pushes()
        await again.opened()
        #expect(outside.letters.count == 1)
        #expect(letter(outside.letters[0], keys: [officeKey])?.letter.grant == grant(expiring: 20))
    }

    @MainActor @Test func writesNoLetterWhileNotificationsAreOffOrWithAGrantTheRelayNoLongerTakes() async {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        outside.permission = .off
        await outside.pushes().kept([studio])?.value
        await outside.pushes().opened()
        #expect(outside.letters.isEmpty)
        // A minute or less left: the relay refuses such a letter.
        outside.permission = .on
        outside.held?.grant = "\(Int(now.timeIntervalSince1970 + 60)).Dy98c6Z0_-kag0UUqCPONV9N3A2aRCMVgIl-3H8xsb8"
        await outside.pushes().opened()
        #expect(outside.letters.isEmpty)
    }

    @MainActor @Test func forgettingAComputerLeavesItAStopLetterTheLastOneToo() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        await pushes.kept([studio, office])?.value
        let studioKey = try #require(outside.held?.computers?[0].key)
        let officeKey = try #require(outside.held?.computers?[1].key)

        await pushes.forgot(computer: office.pin)
        #expect(outside.letters.count == 1)
        let stop = try #require(letter(outside.letters[0], keys: [officeKey]))
        #expect(stop.letter == .stop(at: stop.letter.at))
        #expect(outside.letters[0]["grant"] == grant(expiring: 20) && outside.letters[0]["token"] == token)
        #expect(outside.held?.stops == nil, "The relay stored it, so it waits no more")
        #expect(outside.held?.openers.contains { $0.key == officeKey } == false)

        // The last computer: the push address goes, and its stop still goes with the grant it was made with.
        await pushes.forgot(computer: studio.pin)
        #expect(outside.unregistered == 1)
        #expect(outside.letters.count == 2)
        #expect(letter(outside.letters[1], keys: [studioKey])?.letter.kind == "stop")
        #expect(outside.letters[1]["grant"] == grant(expiring: 20))
        #expect(outside.held?.stops == nil && outside.held?.grant == nil)
    }

    @MainActor @Test func aStopTheRelayDidNotAnswerWaitsForTheNextOpen() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        let pushes = outside.pushes()
        // A list read without the office, forgotten while Infinitary was closed: its stop goes too.
        await pushes.kept([studio, office])?.value
        let officeKey = try #require(outside.held?.computers?[1].key)
        outside.letterAnswers = [nil]
        await pushes.kept([studio])?.value
        #expect(outside.letters.count == 1)
        #expect(outside.held?.stops?.count == 1)
        #expect(outside.held?.openers.contains { $0.key == officeKey } == false, "Its key opens nothing meanwhile")
        await outside.pushes().opened()
        // The stop first, then the studio's renew letter, which no open had written yet.
        #expect(outside.letters.count == 3)
        #expect(outside.letters[1] == outside.letters[0], "The same stop, written again")
        #expect(letter(outside.letters[1], keys: [officeKey])?.letter.kind == "stop")
        #expect(outside.held?.stops == nil)
    }

    @MainActor @Test func writesTheNewestLetterAgainASecondAfterTheBoxWasBusyAFewTimesAtMost() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20))
        await outside.pushes().kept([studio])?.value
        outside.letterAnswers = [429, 429, 204]
        await outside.pushes().opened()
        #expect(outside.letters.count == 3)
        #expect(Set(outside.letters).count == 1, "The same letter each time, never an older one")
        #expect(outside.waits == [1, 1])
        #expect(outside.held?.computers?.first?.lettered == grant(expiring: 20))

        outside.held?.computers?[0].lettered = nil
        outside.letterAnswers = [429, 429, 429]
        await outside.pushes().opened()
        #expect(outside.letters.count == 6)
        #expect(outside.held?.computers?.first?.lettered == nil, "Not stored: the next open writes it again")
    }

    @MainActor @Test func aLetterTheRelayRefusesAsksForANewGrantAndARelayWithoutLettersEndsThePass() async throws {
        let outside = Outside()
        outside.held = PhonePushHeld(key: PhonePushSeal.newKey(), token: token, environment: .production, grant: grant(expiring: 20),
                                     asked: now.addingTimeInterval(-10 * 86_400))
        await outside.pushes().kept([studio, office])?.value
        // A relay without letters: one try, nothing kept, and the other computer is not tried this time.
        outside.letterAnswers = [404]
        await outside.pushes().opened()
        #expect(outside.letters.count == 1)
        #expect(outside.held?.computers?.allSatisfy { $0.lettered == nil } == true)
        // The relay refuses the grant: the phone drops it and asks for a new one, as when its computer did not keep it.
        outside.letterAnswers = [403]
        let pushes = outside.pushes()
        await pushes.opened()
        await pushes.tokenArrived(address)
        #expect(outside.letters.count == 2)
        #expect(outside.held?.grant == nil)
        #expect(outside.posts == [["token": token, "environment": "production"]])
    }
}
