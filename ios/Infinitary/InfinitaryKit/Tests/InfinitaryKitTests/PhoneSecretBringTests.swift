import Foundation
import Testing
@testable import InfinitaryKit

/// The approved plan for letting the phone bring a secret, part 1 (the captain: "let's plan how to allow phone to approve
/// this"): the phone reads a bring card's rows off Infinitary's own Bring into Secrets button, as the Mac's
/// `secretBringRows` does, and its Bring sends only the button's pass and the ticked rows' ids in their own request. The
/// card is shaped as SecretBrings.raise raises it (src/core/secrets/bring.ts) for a bring of two names from an
/// Automic Vault command, the second already kept; the home stand-in answers as `bringInto` does.
@MainActor struct PhoneSecretBringTests {
    @MainActor final class Home: SecretsKeeping {
        private(set) var sent: [(channel: PhoneRequest, input: [String: Any])] = []
        var answer: [String: Any] = ["brought": true]

        func request<T: Decodable & Sendable>(_ channel: PhoneRequest, args: [Any], as: T.Type) async throws -> T {
            sent.append((channel, try #require(args.first as? [String: Any])))
            return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: answer))
        }
    }

    static let twoRows = #"{"rows":[{"id":"s1","name":"Staging token","source":"STAGING_TOKEN","place":"Staging","ticked":true},{"id":"s2","name":"DB_PASSWORD","place":"","replaces":{"ref":"db-password","version":1},"ticked":false}]}"#

    static func card(id: String = "card-secrets-bring-t1-staging-keys", author: String = "host", offer: String = twoRows) throws -> PhoneCard {
        try PhoneCard(.object([
            "id": .string(id), "title": .string("Bring 2 secrets from Automic Vault?"), "author": .string(author),
            "body": .string("<p>From Automic Vault.</p>"),
            "actions": .array([
                .object(["id": .string("pass-dont"), "label": .string("Don't bring"), "variant": .string("ghost"), "declines": .bool(true),
                         "effect": .object(["kind": .string("host"), "op": .string("secrets-decision"), "arg": .string("pass-dont")])]),
                .object(["id": .string("pass-go"), "label": .string("Bring into Secrets"), "default": .bool(true), "variant": .string("primary"),
                         "effect": .object(["kind": .string("host"), "op": .string("secrets-bring"), "arg": .string(offer)])]),
            ]),
        ]))
    }

    @Test func readsTheRowsAnInfinitaryCardOffers() throws {
        let bring = try #require(PhoneSecretBring.of(try Self.card()))
        #expect(bring.pass == "pass-go")
        #expect(bring.rows.map(\.name) == ["Staging token", "DB_PASSWORD"])
        #expect(bring.rows.map(\.place) == ["Staging", nil])
        // A name Secrets already keeps arrives unticked and says which version it would replace.
        #expect(bring.ticked == ["s1"])
        #expect(bring.rows.map(\.note) == [nil, PhoneMessages.secretsBringReplaces(version: "1")])
    }

    /// A value the source holds as empty, too large or not text arrives unticked, says why, and cannot be ticked.
    @Test func aRowThatCannotBeKeptSaysWhyAndStaysUnticked() throws {
        let offer = #"{"rows":[{"id":"s1","name":"API_KEY","ticked":true,"cannot":"empty"},{"id":"s2","name":"CERT","ticked":false,"cannot":"too-large"}]}"#
        let bring = try #require(PhoneSecretBring.of(try Self.card(offer: offer)))
        #expect(bring.ticked.isEmpty)
        #expect(bring.rows.map(\.note) == [PhoneMessages.secretsBringCannotEmpty(), PhoneMessages.secretsBringCannotTooLarge()])
    }

    /// An agent's own card cannot make the phone draw tick boxes or send a Bring.
    @Test func anAgentsCardOffersNothing() throws {
        #expect(PhoneSecretBring.of(try Self.card(author: "crewmate")) == nil)
    }

    @Test func bringSendsOnlyThePassAndTheTickedRows() async throws {
        let offer = #"{"rows":[{"id":"s1","name":"A","ticked":true},{"id":"s2","name":"B","ticked":true},{"id":"s3","name":"C","ticked":false,"cannot":"not-text"}]}"#
        let bring = try #require(PhoneSecretBring.of(try Self.card(offer: offer)))
        let home = Home()
        // The offer's order, and never a row that cannot be kept, whatever the set holds.
        let outcome = try await bring.bring(["s3", "s2", "s1"], home: home)
        #expect(outcome == .brought)
        #expect(home.sent.count == 1)
        #expect(home.sent.first?.channel == .secretBring)
        let input = try #require(home.sent.first?.input)
        #expect(Set(input.keys) == ["pass", "picked"])
        #expect(input["pass"] as? String == "pass-go")
        #expect(input["picked"] as? [String] == ["s1", "s2"])
    }

    @Test func aBringTheHomeRefusesSaysWhy() async throws {
        let bring = try #require(PhoneSecretBring.of(try Self.card()))
        let home = Home()
        home.answer = ["brought": false, "words": "Secrets storage is locked. Unlock it in Settings → Secrets, then press again."]
        let outcome = try await bring.bring(bring.ticked, home: home)
        #expect(outcome == .refused("Secrets storage is locked. Unlock it in Settings → Secrets, then press again."))
    }

    /// Don't bring and Read it hand nothing out, so the phone sends them; another Secrets card's one-time choice, such as
    /// an ask's Unlock, still waits for the computer's own confirmation.
    @Test func onlyABringCardsDecisionsArePressedHere() throws {
        let bring = try Self.card()
        let dont = try #require(bring.actions.first)
        #expect(PhoneSecretBring.isDecision(dont, on: bring))
        #expect(!PhoneSecretBring.isDecision(try #require(bring.actions.last), on: bring))
        #expect(!PhoneSecretBring.isDecision(dont, on: try Self.card(id: "card-secrets-ask-t1-stripe")))
        #expect(!PhoneSecretBring.isDecision(dont, on: try Self.card(author: "crewmate")))
    }
}
