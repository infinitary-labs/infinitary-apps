import Foundation
import Testing
@testable import InfinitaryKit

/// INF-4239 piece 4: the phone reads an ask to keep a secret off Infinitary's own card, as the Mac's
/// `secretKeepFields` does, and its Keep sends what was typed with the button's pass in its own request. The card is
/// shaped as SecretAsks.raiseAsk raises it (src/core/secrets/askToKeep.ts); the home stand-in answers as its keep does.
@MainActor struct PhoneSecretAskTests {
    @MainActor final class Home: SecretsKeeping {
        private(set) var sent: [(channel: PhoneRequest, input: [String: Any])] = []
        var answer: [String: Any] = ["kept": true]

        func request<T: Decodable & Sendable>(_ channel: PhoneRequest, args: [Any], as: T.Type) async throws -> T {
            sent.append((channel, try #require(args.first as? [String: Any])))
            return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: answer))
        }
    }

    static let twoSecrets = #"{"fields":[{"id":"s1","name":"Stripe test key","place":"Test"},{"id":"s2","name":"Webhook secret"}]}"#

    static func card(author: String = "host", offer: String = twoSecrets) throws -> PhoneCard {
        return try PhoneCard(.object([
            "id": .string("card-secrets-ask-t1-stripe"), "title": .string("Add Stripe test key and Webhook secret to Secrets?"), "author": .string(author),
            "body": .string("<p>Asked.</p>"),
            "actions": .array([
                .object(["id": .string("pass-dont"), "label": .string("Don't save"), "variant": .string("ghost"),
                         "effect": .object(["kind": .string("host"), "op": .string("secrets-decision"), "arg": .string("pass-dont")])]),
                .object(["id": .string("pass-keep"), "label": .string("Save secrets"), "default": .bool(true),
                         "effect": .object(["kind": .string("host"), "op": .string("secrets-keep"), "arg": .string(offer)])]),
            ]),
        ]))
    }

    @Test func readsTheFieldsAnInfinitaryCardAsksFor() throws {
        let ask = try #require(PhoneSecretAsk.of(try Self.card()))
        #expect(ask.pass == "pass-keep")
        #expect(ask.fields.map(\.id) == ["s1", "s2"])
        #expect(ask.fields.map(\.place) == ["Test", nil])
        #expect(ask.fields.map(\.details) == [[PhoneMessages.phoneSecretsAskPlace(place: "Test")], []])
    }

    /// INF-5516's plan: a replacement's label names the version it replaces, read from the Save button's offer, once
    /// beside the name rather than inside the field.
    @Test func aReplacementNamesTheVersionItReplaces() throws {
        let offer = #"{"fields":[{"id":"s1","name":"Planning calendar","place":"staging","replaces":{"ref":"planning-calendar","version":2}}]}"#
        let ask = try #require(PhoneSecretAsk.of(try Self.card(offer: offer)))
        #expect(ask.fields.first?.replaces == 2)
        #expect(ask.fields.first?.details == [
            PhoneMessages.phoneSecretsAskPlace(place: "staging"), PhoneMessages.phoneSecretsAskReplaces(version: "2"),
        ])
    }

    /// An agent's own card cannot make the phone draw a secret field.
    @Test func anAgentsCardAsksForNothing() throws {
        #expect(PhoneSecretAsk.of(try Self.card(author: "crewmate")) == nil)
    }

    @Test func keepSendsEachValueWithThePassInItsOwnRequest() async throws {
        let ask = try #require(PhoneSecretAsk.of(try Self.card()))
        let home = Home()
        let outcome = try await ask.keep(["s1": "sk_test_invented", "s2": "whsec_invented"], home: home)
        #expect(outcome == .kept)
        #expect(home.sent.count == 1)
        #expect(home.sent.first?.channel == .secretKeep)
        #expect(home.sent.first?.input["pass"] as? String == "pass-keep")
        let values = try #require(home.sent.first?.input["values"] as? [[String: String]])
        #expect(values == [["field": "s1", "value": "sk_test_invented"], ["field": "s2", "value": "whsec_invented"]])
    }

    @Test func aKeepTheHomeRefusesSaysWhy() async throws {
        let ask = try #require(PhoneSecretAsk.of(try Self.card()))
        let home = Home()
        home.answer = ["kept": false, "words": "Secrets storage is locked. Unlock it, then save again."]
        let outcome = try await ask.keep(["s1": "a", "s2": "b"], home: home)
        #expect(outcome == .refused("Secrets storage is locked. Unlock it, then save again."))
    }
}
