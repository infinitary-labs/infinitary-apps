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
        #expect(PhoneGoogleClientState.of(nil, health: "ok", computer: "Studio Mac") == nil)
    }

    @Test func aRetiringFactFromAComputerOnAnEarlierVersionIsReadAsNoState() throws {
        // A computer from before Infinitary's own client retired still sends it, and the phone ignores it.
        let (retiring, health) = try row(health: "ok", client: #"{"kept":false,"retiring":true}"#)
        #expect(retiring == PhoneIntegrations.Client(kept: false))
        #expect(PhoneGoogleClientState.of(retiring, health: health, computer: "Studio Mac") == nil)
    }

    @Test func aClientOutsidePersonalModeSaysWhenItStops() throws {
        // 2026-10-23 16:00 UTC, on the computer's clock in milliseconds.
        let (client, health) = try row(health: "ok", client: #"{"kept":true,"endsAt":1792771200000}"#)
        let state = try #require(PhoneGoogleClientState.of(client, health: health, computer: "Studio Mac"))
        #expect(state.words.hasPrefix("Stops "))
        #expect(state.words.count > "Stops ".count)
        #expect(state.nextWords == "Set up again")
    }

    @Test func aRefusedClientOutranksSignInAgainAndARefusedSignInShowsItsHealth() throws {
        let (refused, health) = try row(health: "needs_reauth", client: #"{"kept":true,"refused":"deleted_client"}"#)
        let state = try #require(PhoneGoogleClientState.of(refused, health: health, computer: "Studio Mac"))
        #expect(state.words == "Your Google client stopped")
        #expect(state.tone == .danger)
        #expect(state.nextWords == "Set up again")
        let (ended, endedHealth) = try row(health: "needs_reauth", client: #"{"kept":true,"endsAt":1792771200000}"#)
        #expect(PhoneGoogleClientState.of(ended, health: endedHealth, computer: "Studio Mac") == nil)
    }

    /// INF-7012's approved plan, piece 1: "A row line with a link appears when Google refuses an unmarked client or a
    /// service is off, on the computer and the phone. The row keeps its sign-in."
    @Test func googlesRefusalOfAnUnmarkedClientOpensItsPageAndOutranksWhenTheSignInStops() throws {
        let link = "https://console.cloud.google.com/auth/clients/582093176224-p8d0vq3hr5k1n6e2.apps.googleusercontent.com?project=582093176224"
        let (client, health) = try row(
            health: "ok", client: #"{"kept":true,"endsAt":1792771200000,"mcp":{"refused":"agent","link":"\#(link)"}}"#)
        let state = try #require(PhoneGoogleClientState.of(client, health: health, computer: "Studio Mac"))
        #expect(state.words == "Mark your client for agents")
        #expect(state.detail.hasSuffix("then choose Check now on the Google row in Settings → Integrations on Studio Mac."))
        #expect(state.tone == .warning)
        #expect(state.next == .open(try #require(URL(string: link))))
        #expect(state.nextWords == "Open Google Cloud")
    }

    @Test func aServiceTurnedOffNamesItAndOpensGooglesPageForIt() throws {
        let link = "https://console.developers.google.com/apis/api/calendarmcp.googleapis.com/overview?project=582093176224"
        let (one, health) = try row(health: "ok", client: #"{"kept":true,"mcp":{"refused":"service","services":["calendar"],"link":"\#(link)"}}"#)
        let state = try #require(PhoneGoogleClientState.of(one, health: health, computer: "Studio Mac"))
        #expect(state.words == "A Google service is off")
        #expect(state.detail.hasPrefix("The Calendar MCP service is off in your Google Cloud project"))
        #expect(state.next.link == URL(string: link))
        let (both, _) = try row(
            health: "ok",
            client: #"{"kept":true,"mcp":{"refused":"service","services":["gmail","calendar"],"link":"https://console.cloud.google.com/flows/enableapi?apiid=gmailmcp.googleapis.com,calendarmcp.googleapis.com&project=582093176224"}}"#)
        let two = try #require(PhoneGoogleClientState.of(both, health: health, computer: "Studio Mac"))
        #expect(two.detail.hasPrefix("The Gmail and Calendar MCP services are off"))
    }

    @Test func aRefusalLinkThatIsNotHttpsOpensNothing() throws {
        let (client, health) = try row(health: "ok", client: #"{"kept":true,"mcp":{"refused":"agent","link":"http://console.cloud.google.com/auth/clients"}}"#)
        #expect(PhoneGoogleClientState.of(client, health: health, computer: "Studio Mac") == nil)
    }

    /// The captain's answer 2a on INF-6447: "Keep Gmail and Calendar; Drive waits for a new sign-in". The row says so
    /// quietly, with Sign in again, below every warning.
    @Test func aSignInWithoutDriveSaysSoQuietlyWithSignInAgain() throws {
        let (client, health) = try row(health: "ok", client: #"{"kept":true,"withoutDrive":true}"#)
        let state = try #require(PhoneGoogleClientState.of(client, health: health, computer: "Studio Mac"))
        #expect(state.words == "Drive, Docs and Sheets not added")
        #expect(state.detail.hasPrefix("Your Google sign-in on Studio Mac leaves out Drive, Docs and Sheets."))
        #expect(state.tone == .quiet)
        #expect(state.next == .signInAgain)
        #expect(state.nextWords == "Sign in again")
        let (ending, _) = try row(health: "ok", client: #"{"kept":true,"endsAt":1792771200000,"withoutDrive":true}"#)
        #expect(PhoneGoogleClientState.of(ending, health: health, computer: "Studio Mac")?.tone == .warning)
    }

    @Test func driveOffIsNamedFromTheOffList() throws {
        let link = "https://console.developers.google.com/apis/api/drivemcp.googleapis.com/overview?project=582093176224"
        let (client, health) = try row(health: "ok", client: #"{"kept":true,"mcp":{"refused":"service","off":["drive"],"link":"\#(link)"}}"#)
        let state = try #require(PhoneGoogleClientState.of(client, health: health, computer: "Studio Mac"))
        #expect(state.detail.hasPrefix("The Drive MCP service is off in your Google Cloud project"))
    }
}
