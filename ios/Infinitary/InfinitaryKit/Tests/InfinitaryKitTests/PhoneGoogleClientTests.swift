import Foundation
import Testing
@testable import InfinitaryKit

/// INF-6342, the captain's choice setup-on-phone ("Bring the client file setup to the phone itself"): the phone's Google
/// row reads the computer's client facts and says what the computer's row says, in the same order. Data: integrations
/// views as a computer sends them (`inf:integrations:list`).
@Suite struct PhoneGoogleClientTests {
    private func view(_ json: String) throws -> PhoneIntegrations {
        try JSONDecoder().decode(PhoneIntegrations.self, from: Data(json.utf8))
    }

    private func row(health: String, client: String) throws -> (PhoneIntegrations.Client?, String) {
        let read = try view(#"{"integrations":[{"id":"google","kind":"google","name":"Google","account":"ada@example.com","health":"\#(health)","client":\#(client)}],"addable":[]}"#)
        return (read.integrations.first?.client, read.integrations.first?.health ?? "")
    }

    @Test func aComputerBeforeTheOwnClientSendsNoClientFacts() throws {
        let read = try view(#"{"integrations":[{"id":"google","kind":"google","name":"Google","account":"ada@example.com","health":"ok"}],"addable":[{"kind":"github","name":"GitHub"}]}"#)
        #expect(read.integrations.first?.client == nil)
        #expect(PhoneGoogleClientState.of(nil, health: "ok") == nil)
    }

    @Test func aSignInOnInfinitarysClientAsksToSetUpAnOwnOneThenToSignInWithIt() throws {
        let (retiring, health) = try row(health: "ok", client: #"{"kept":false,"retiring":true}"#)
        let state = try #require(PhoneGoogleClientState.of(retiring, health: health))
        #expect(state.words == "Set up your own connection")
        #expect(state.nextWords == "Set up")
        let (kept, _) = try row(health: "ok", client: #"{"kept":true,"retiring":true}"#)
        let ready = try #require(PhoneGoogleClientState.of(kept, health: health))
        #expect(ready.detail == "Your own Google client is kept. Sign in with it to move off Infinitary's shared client.")
        #expect(ready.next == .signIn)
    }

    @Test func aClientOutsidePersonalModeSaysWhenItStops() throws {
        // 2026-10-23 16:00 UTC, on the computer's clock in milliseconds.
        let (client, health) = try row(health: "ok", client: #"{"kept":true,"endsAt":1792771200000}"#)
        let state = try #require(PhoneGoogleClientState.of(client, health: health))
        #expect(state.words.hasPrefix("Stops "))
        #expect(state.words.count > "Stops ".count)
        #expect(state.next == .setUpAgain)
    }

    @Test func aRefusedClientOutranksSignInAgainAndARefusedSignInShowsItsHealth() throws {
        let (refused, health) = try row(health: "needs_reauth", client: #"{"kept":true,"refused":"deleted_client"}"#)
        let state = try #require(PhoneGoogleClientState.of(refused, health: health))
        #expect(state.words == "Your Google client stopped")
        #expect(state.tone == .danger)
        #expect(state.nextWords == "Set up again")
        let (ended, endedHealth) = try row(health: "needs_reauth", client: #"{"kept":true,"endsAt":1792771200000}"#)
        #expect(PhoneGoogleClientState.of(ended, health: endedHealth) == nil)
    }
}
