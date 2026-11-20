import Foundation
import Testing
@testable import InfinitaryKit

/// INF-4207 piece 9 (decision 9): the phone keeps each computer that keeps a copy from every welcome, follows the one
/// that took over at number 2, refuses number 1, and refuses a second home with the same number and another takeover.
struct PhoneTakeOverTests {
    private let pin = String(repeating: "a", count: 43)
    private let miniPin = String(repeating: "m", count: 43)
    private var paired: JoinedMac {
        JoinedMac(addresses: ["192.168.1.20:47213"], pin: pin, deviceID: "phone", name: "MacBook Pro")
    }

    /// A welcome as `src/core/connection/connection.ts` sends it to a phone, its `standbys` in `phoneStandbySchema`'s shape.
    private func welcome(_ extra: [String: Any]) throws -> [String: Any] {
        var frame: [String: Any] = ["t": "welcome", "epoch": "e1", "seq": 4, "catchUp": "reload", "name": "MacBook Pro",
                                    "addresses": ["192.168.1.20:47213", "192.168.1.30:47213"]]
        frame.merge(extra) { $1 }
        let sent = try JSONSerialization.data(withJSONObject: frame)
        return try #require(JSONSerialization.jsonObject(with: sent) as? [String: Any])
    }

    private var mini: [String: Any] {
        ["deviceId": "mini", "name": "Mac mini", "pin": miniPin, "listens": ["192.168.1.30:47624", "100.101.4.7:47624"]]
    }

    @Test func keepsTheComputersThatKeepACopyFromAWelcome() throws {
        let frame = try welcome(["standbys": [mini, ["deviceId": "broken", "name": "No pin"]]])
        let kept = try #require(PhoneTakeOver.welcomed(paired, frame: frame))
        // The private network first, as every route the phone dials; an entry that is not whole is left out.
        #expect(kept.standbys == [PhoneStandby(deviceID: "mini", name: "Mac mini", pin: miniPin,
                                               listens: ["100.101.4.7:47624", "192.168.1.30:47624"])])
        #expect(kept.takeOver == nil)
        // A home from before lists none, and the record keeps what it had.
        #expect(PhoneTakeOver.welcomed(kept, frame: try welcome([:])) == nil)
    }

    @Test func hearsTheListAgainWhenTheHomeChangesIt() throws {
        let kept = try #require(PhoneTakeOver.welcomed(paired, frame: try welcome(["standbys": [mini]])))
        let sent = try JSONSerialization.data(withJSONObject: ["t": "live", "channel": PhoneStandbyContract.routes,
            "payload": ["addresses": ["192.168.1.20:47213"], "standbys": [] as [Any]]])
        let frame = try #require(JSONSerialization.jsonObject(with: sent) as? [String: Any])
        let routed = try #require(PhoneTakeOver.routed(kept, payload: frame["payload"]))
        #expect(routed.standbys == [])
    }

    /// The Mac mini took over: it answers at the home's own key with number 2 and its takeover. Number 1, the MacBook
    /// Pro that comes back, is refused, and so is another copy that took over with number 2 too.
    @Test func followsTheComputerThatTookOverAndRefusesTheOthers() throws {
        let tookOver = try welcome(["name": "Mac mini", "homeNumber": 2, "takeOver": "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b"])
        #expect(PhoneHomeMove.accepts(welcome: PhoneHomeMove.number(inWelcome: tookOver), known: paired.homeNumber))
        #expect(!PhoneTakeOver.secondHome(tookOver, mac: paired))
        var mac = try #require(PhoneTakeOver.welcomed(paired, frame: tookOver))
        mac = try #require(PhoneHomeMove.kept(mac, welcome: 2))
        #expect(mac.homeNumber == 2 && mac.takeOver == "7e6d5c4b-3a2f-4e1d-9c8b-7a6f5e4d3c2b")

        #expect(!PhoneHomeMove.accepts(welcome: PhoneHomeMove.number(inWelcome: try welcome([:])), known: mac.homeNumber))
        let other = try welcome(["name": "Mac Studio", "homeNumber": 2, "takeOver": "5c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"])
        #expect(PhoneTakeOver.secondHome(other, mac: mac))
        #expect(!PhoneTakeOver.secondHome(tookOver, mac: mac))
        // A move from there makes number 3 with no takeover, which the phone takes, and then keeps no takeover.
        let moved = try welcome(["homeNumber": 3])
        #expect(!PhoneTakeOver.secondHome(moved, mac: mac))
        #expect(PhoneTakeOver.welcomed(mac, frame: moved)?.takeOver == nil)
    }

    /// What `phoneOffer` in `src/core/standby/takeOver.ts` answers, as the phone reads it.
    @Test func readsWhatTakeOverRestsOn() throws {
        let sent = try JSONSerialization.data(withJSONObject: [
            "copyAt": 1_763_000_000_000, "homeNumber": 1, "ready": true, "asked": NSNull(),
            "home": ["name": "MacBook Pro", "contact": "lost", "heardAt": 1_762_999_000_000, "slept": true],
            "copies": [["name": "Mac Studio", "copyAt": NSNull(), "newer": false]],
        ] as [String: Any])
        let offer = try #require(PhoneTakeOverOffer(try JSONSerialization.jsonObject(with: sent)))
        #expect(offer.copyAt == Date(timeIntervalSince1970: 1_763_000_000))
        #expect(offer.contact == .lost && offer.slept && offer.homeName == "MacBook Pro")
        #expect(offer.copies == [.init(name: "Mac Studio", copyAt: nil, newer: false)])
        #expect(offer.canTakeOver)

        // A computer that still hears the home offers no Take over: the home there refuses it anyway.
        let hears = try JSONSerialization.data(withJSONObject: [
            "copyAt": 1_763_000_000_000, "homeNumber": 1, "ready": true, "asked": NSNull(), "copies": [] as [Any],
            "home": ["name": "MacBook Pro", "contact": "in-reach", "heardAt": 1_763_000_000_000, "slept": false],
        ] as [String: Any])
        #expect(try #require(PhoneTakeOverOffer(try JSONSerialization.jsonObject(with: hears))).canTakeOver == false)
    }

    /// A record saved before takeovers were known decodes with neither, as a phone from before kept it.
    @Test func readsARecordSavedBeforeTakeovers() throws {
        let json = #"{"addresses":["192.168.1.20:47213"],"pin":"\#(pin)","deviceID":"phone","name":"MacBook Pro","homeNumber":2}"#
        let record = try JSONDecoder().decode(JoinedMac.self, from: Data(json.utf8))
        #expect(record.takeOver == nil && record.standbys == nil && record.homeNumber == 2)
    }
}
