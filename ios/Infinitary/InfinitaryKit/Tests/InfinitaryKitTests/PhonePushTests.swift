import Foundation
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
        var delivered: [(id: String, cardID: String?, push: String?)] = []
        var removed: [String] = []
        var now = Date(timeIntervalSince1970: 1_795_000_000)

        func pushes(_ environment: PhonePushEnvironment = .production) -> PhonePushes {
            let posted: @Sendable (URL, Data) async -> Int? = { [weak self] url, body in
                await MainActor.run {
                    #expect(url.absoluteString == "https://push.getinfinitary.com/v1/register")
                    self?.posts.append((try? JSONSerialization.jsonObject(with: body)) as? [String: String] ?? [:])
                }
                return 202
            }
            return PhonePushes(effects: PhonePushEffects(
                permission: { self.permission },
                askPermission: { self.askedIOS += 1; self.permission = self.allowsWhenAsked ? .on : .off; return self.allowsWhenAsked },
                registerForPushes: { self.registered += 1 }, unregisterForPushes: { self.unregistered += 1 },
                post: posted,
                load: { self.held }, save: { self.held = $0 },
                askedPerson: { self.askedPerson }, noteAskedPerson: { self.askedPerson = true },
                delivered: { self.delivered }, remove: { self.removed += $0 },
                now: { self.now }), environment: environment)
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
        await pushes.opened()
        #expect(outside.registered == 1)
        await pushes.tokenArrived(address)
        #expect(outside.posts == [["token": token, "environment": "production"]])
        // The relay's grant arrives by a background push and goes to the computer at once.
        await pushes.reached(takesPushes: true, hand: outside.hand)
        #expect(outside.handed.isEmpty)
        #expect(await pushes.pushArrived(outside.grantPush(grant(expiring: 30))))
        let key = try #require(outside.held?.key)
        #expect(outside.handed == [PhonePushRegistration(token: token, environment: .production, grant: grant(expiring: 30), key: key)])
        // The next run's open, address and welcome hand the same grant and ask the relay nothing.
        let next = outside.pushes()
        await next.opened()
        await next.tokenArrived(address)
        await next.reached(takesPushes: true, hand: outside.hand)
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
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", nil), ("n2", nil, nil)]
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
        await pushes.reached(takesPushes: true, hand: outside.hand)
        #expect(outside.registered == registeredBefore + 1)
        #expect(outside.handed.count == handedBefore, "No registration to hand before the new address has its grant")
        let nextAddress = Data(repeating: 0xcd, count: 32)
        let next = PhonePush.token(nextAddress)
        await pushes.tokenArrived(nextAddress)
        #expect(outside.posts.last?["token"] == next)
        await pushes.pushArrived(outside.grantPush(grant(expiring: 30)))
        #expect(outside.handed.last??.token == next)
        #expect(outside.handed.last??.key == fresh.key)
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
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", "Hs2pW9cXe4Rm"),
                             ("n2", "card-5c02e4f1-pick-venue", "Xa0vB3nM6pQe"),
                             ("n3", "card-2b81d0aa-review-onboarding", "q3Vn8yLk0TfA"),
                             ("n4", nil, nil),
                             ("n5", "card-7f3a9c1e-plan-launch-week", "b7JtQ0uZa1Nd"),
                             ("n6", "card-7f3a9c1e-plan-launch-week", nil)]
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
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", "Hs2pW9cXe4Rm"),
                             ("n2", "card-2b81d0aa-review-onboarding", "Zr5kD1wYt8Lc")]
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
        outside.delivered = [("n1", olderShown.cardID, olderShown.push), ("n2", newerShown.cardID, newerShown.push)]
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
        outside.delivered = [("n1", "card-7f3a9c1e-plan-launch-week", nil), ("n2", "card-2b81d0aa-review-onboarding", nil),
                             ("n3", nil, nil), ("n4", "card-9d4e6b20-renew-certificate", nil)]
        await outside.pushes().clear(stage: stage, seen: \.currentUpdateSeen)
        // Kept: the unseen card on the stage. Gone: the card that left it, one naming no card, and the seen card.
        #expect(outside.removed == ["n2", "n3", "n4"])
    }
}
