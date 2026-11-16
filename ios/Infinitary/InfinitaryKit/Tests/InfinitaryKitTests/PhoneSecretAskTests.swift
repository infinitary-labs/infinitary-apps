import Foundation
import Testing
@testable import InfinitaryKit

/// INF-4239 piece 4: the phone reads an ask to keep a secret off Infinitary's own card, as the Mac's
/// `secretKeepFields` does, and its Keep sends what was typed with the button's pass in its own request. The card is
/// shaped as SecretsSettings.raiseAsk raises it (src/core/secrets/settings.ts); the home stand-in answers as its keep does.
@MainActor struct PhoneSecretAskTests {
    @MainActor final class Home: SecretsKeeping {
        private(set) var sent: [(channel: PhoneRequest, input: [String: Any])] = []
        var answer: [String: Any] = ["kept": true]

        func request<T: Decodable & Sendable>(_ channel: PhoneRequest, args: [Any], as: T.Type) async throws -> T {
            sent.append((channel, try #require(args.first as? [String: Any])))
            return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: answer))
        }
    }

    static func card(author: String = "host") throws -> PhoneCard {
        let offer = #"{"fields":[{"id":"s1","name":"Stripe test key","place":"Test"},{"id":"s2","name":"Webhook secret"}]}"#
        return try PhoneCard(.object([
            "id": .string("card-secrets-ask-t1-stripe"), "title": .string("Keep two secrets?"), "author": .string(author),
            "body": .string("<p>Asked.</p>"),
            "actions": .array([
                .object(["id": .string("pass-dont"), "label": .string("Don't keep"), "variant": .string("ghost"),
                         "effect": .object(["kind": .string("host"), "op": .string("secrets-decision"), "arg": .string("pass-dont")])]),
                .object(["id": .string("pass-keep"), "label": .string("Keep in Secrets"), "default": .bool(true),
                         "effect": .object(["kind": .string("host"), "op": .string("secrets-keep"), "arg": .string(offer)])]),
            ]),
        ]))
    }

    @Test func readsTheFieldsAnInfinitaryCardAsksFor() throws {
        let ask = try #require(PhoneSecretAsk.of(try Self.card()))
        #expect(ask.pass == "pass-keep")
        #expect(ask.fields.map(\.id) == ["s1", "s2"])
        #expect(ask.fields.map(\.place) == ["Test", nil])
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
        home.answer = ["kept": false, "words": "Secrets storage is locked. Unlock it, then keep again."]
        let outcome = try await ask.keep(["s1": "a", "s2": "b"], home: home)
        #expect(outcome == .refused("Secrets storage is locked. Unlock it, then keep again."))
    }
}
