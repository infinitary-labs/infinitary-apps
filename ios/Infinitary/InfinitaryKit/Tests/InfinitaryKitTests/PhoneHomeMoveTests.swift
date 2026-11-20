import Foundation
import Testing
@testable import InfinitaryKit

/// INF-4207 piece 5, the captain's "let me move my home from macbook to mac mini": the phone follows the first mate
/// to its new computer with no new link or code, and refuses the home the move left behind.
struct PhoneHomeMoveTests {
    private let paired = JoinedMac(addresses: ["192.168.1.20:47213"], pin: String(repeating: "a", count: 43),
                                   deviceID: "phone", name: "MacBook Pro")

    /// The live frame as `src/core/connection/connection.ts` sends it, its payload in `homeMovedSchema`'s shape.
    private func movedFrame(_ number: Int, _ addresses: [String]) throws -> [String: Any] {
        let payload: [String: Any] = ["homeNumber": number, "addresses": addresses, "to": "mini", "name": "Mac mini"]
        let sent = try JSONSerialization.data(withJSONObject: ["t": "live", "channel": "inf:home:moved", "payload": payload])
        return try #require(JSONSerialization.jsonObject(with: sent) as? [String: Any])
    }

    @Test func followsTheMoveToTheNewHome() throws {
        let frame = try movedFrame(2, ["192.168.1.30:47213"])
        #expect(frame["channel"] as? String == PhoneHomeMove.movedChannel)
        let followed = try #require(PhoneHomeMove.followed(paired, payload: frame["payload"]))
        #expect(followed.homeNumber == 2)
        #expect(followed.addresses == ["192.168.1.30:47213", "192.168.1.20:47213"])
        #expect(followed.name == "Mac mini")
        #expect(followed.pin == paired.pin)
    }

    /// Number 1 is the home that never moved; once 2 was heard, its welcome is refused and nothing is kept from it.
    @Test func refusesTheHomeTheMoveLeftBehind() throws {
        let followed = try #require(PhoneHomeMove.followed(paired, payload: try movedFrame(2, ["192.168.1.30:47213"])["payload"]))
        #expect(!PhoneHomeMove.accepts(welcome: PhoneHomeMove.number(inWelcome: ["t": "welcome"]), known: followed.homeNumber))
        #expect(!PhoneHomeMove.accepts(welcome: 1, known: 2))
        #expect(PhoneHomeMove.accepts(welcome: 2, known: 2))
        #expect(PhoneHomeMove.accepts(welcome: 1, known: nil))
        #expect(PhoneHomeMove.followed(followed, payload: try movedFrame(2, ["10.0.0.9:47213"])["payload"]) == nil)
    }

    @Test func keepsTheHighestNumberAWelcomeNames() {
        #expect(PhoneHomeMove.kept(paired, welcome: 1) == nil)
        #expect(PhoneHomeMove.kept(paired, welcome: 3)?.homeNumber == 3)
    }

    /// A record saved before moves were known decodes with no number, as a home that never moved.
    @Test func readsARecordSavedBeforeMoves() throws {
        let json = #"{"addresses":["192.168.1.20:47213"],"pin":"\#(String(repeating: "a", count: 43))","deviceID":"phone","name":"MacBook Pro"}"#
        let record = try JSONDecoder().decode(JoinedMac.self, from: Data(json.utf8))
        #expect(record.homeNumber == nil && record == paired)
    }
}
