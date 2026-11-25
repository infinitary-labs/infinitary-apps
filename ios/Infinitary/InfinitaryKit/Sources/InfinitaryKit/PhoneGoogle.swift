import Foundation
import Observation

/// What the computer says of its connections (`inf:integrations:list`), as far as Google's row reads it.
public struct PhoneIntegrations: Decodable, Sendable, Equatable {
    /// What the computer says of the person's own client for a row whose sign-in runs as it (`IntegrationClientView`).
    /// A computer from before INF-6342 sends none, and its sign-in needs no setup.
    public struct Client: Decodable, Sendable, Equatable {
        public let kept: Bool
        public let refused: String?
        public let retiring: Bool?
        public let runClient: Bool?
        /// When Google ends the sign-in, in milliseconds on the computer's clock.
        public let endsAt: Double?
        public init(kept: Bool, refused: String? = nil, retiring: Bool? = nil, runClient: Bool? = nil, endsAt: Double? = nil) {
            self.kept = kept; self.refused = refused; self.retiring = retiring; self.runClient = runClient; self.endsAt = endsAt
        }
    }
    public struct Row: Decodable, Sendable, Equatable {
        public let id: String
        public let kind: String
        public let account: String?
        public let health: String
        public let client: Client?
    }
    public struct Addable: Decodable, Sendable, Equatable {
        public let kind: String
        public let client: Client?
    }
    public let integrations: [Row]
    public let addable: [Addable]?
}

/// What the Google row says of its client when that outranks its health, and its one next step: the computer's
/// `googleClientState` (src/renderer/src/settings/GoogleClientSetup.tsx), in the same order.
public struct PhoneGoogleClientState: Equatable, Sendable {
    public enum Next: Sendable { case setUp, setUpAgain, signIn }
    public enum Tone: Sendable { case danger, warning }
    public let words: String
    public let detail: String
    public let tone: Tone
    public let next: Next

    public static func of(_ client: PhoneIntegrations.Client?, health: String?) -> PhoneGoogleClientState? {
        guard let client else { return nil }
        if client.refused != nil {
            return .init(words: PhoneMessages.integrationsGoogleStopped(), detail: PhoneMessages.integrationsGoogleStoppedDetail(),
                         tone: .danger, next: .setUpAgain)
        }
        guard let health, health != "needs_reauth" else { return nil }
        if client.retiring == true {
            return client.kept
                ? .init(words: PhoneMessages.integrationsGoogleRetiring(), detail: PhoneMessages.integrationsGoogleReadyDetail(),
                        tone: .warning, next: .signIn)
                : .init(words: PhoneMessages.integrationsGoogleRetiring(), detail: PhoneMessages.integrationsGoogleRetiringDetail(),
                        tone: .warning, next: .setUp)
        }
        if let endsAt = client.endsAt {
            let date = Date(timeIntervalSince1970: endsAt / 1000).formatted(date: .abbreviated, time: .omitted)
            return .init(words: PhoneMessages.integrationsGoogleStops(date: date),
                         detail: PhoneMessages.integrationsGoogleStopsDetail(date: date), tone: .warning, next: .setUpAgain)
        }
        return nil
    }

    public var nextWords: String {
        switch next {
        case .signIn: PhoneMessages.integrationsGoogleSignIn()
        case .setUp: PhoneMessages.integrationsGoogleSetUp()
        case .setUpAgain: PhoneMessages.integrationsGoogleSetUpAgain()
        }
    }
}

private struct PhoneSignedIn: Decodable, Sendable { let id: String; let view: PhoneIntegrations }

/// Google's row in the phone's Settings (INF-3454's phone part; docs/ios.md, "Google in Settings"). The sign-in runs
/// on the computer, which keeps Google's keys; this phone shows its page, catches the browser's return on its own
/// loopback address and passes it to the computer, or passes the address the person pastes when it cannot listen.
@MainActor @Observable public final class PhoneGoogle {
    public enum Stage: Equatable {
        case idle
        /// Google's notice is up; nothing is asked of the computer until it is accepted.
        case notice
        /// The setup of the person's own client is up: Google's page, then its client file for the computer to keep.
        case setup
        /// The computer's sign-in waits. `page` is its page once heard; `caught` says this phone listens for the
        /// return, and false asks for the address instead.
        case waiting(page: PhoneSignInPage?, caught: Bool)
    }

    /// Google's connection on the computer, or nil when it has none.
    public private(set) var row: PhoneIntegrations.Row?
    /// The computer's facts on the person's own Google client, from its row or, with none, its addable entry.
    public private(set) var client: PhoneIntegrations.Client?
    /// Why the computer refused the client file, under the setup's field.
    public private(set) var setupProblem: String?
    /// The computer answered its connections: the row shows only then.
    public private(set) var read = false
    public private(set) var stage: Stage = .idle
    public private(set) var problem: String?
    /// The pasted address's refusal, under its field.
    public private(set) var refused: String?
    public private(set) var busy = false
    /// The page to show now; the app shows it in a browser inside the app and clears it when that browser closes.
    public var showing: URL?

    @ObservationIgnored private let session: ReadOnlySession
    @ObservationIgnored private var listener: PhoneSignInReturnListener?
    @ObservationIgnored private var asking = 0
    @ObservationIgnored private var cancelling = false

    public init(session: ReadOnlySession) {
        self.session = session
        session.onSignInPage = { [weak self] page in self?.heard(page) }
        session.onSignInEnded = { [weak self] id in self?.ended(id) }
    }

    /// The computer takes a sign-in's return from this phone; an older one is named instead of the Sign in button.
    public var homeTakesReturn: Bool { session.homeTakesSignInReturn }

    /// Reads the computer's connections again. One that refuses the read hides the row.
    public func refresh() async {
        do {
            let view = try await session.request(.integrations, as: PhoneIntegrations.self)
            take(view); read = true
        } catch {
            if case PhoneError.unavailable = error { return }
            read = false
        }
    }

    /// Google signs in only as the person's own client: with none kept, or one Google refused, a sign-in is its setup.
    public var needsSetup: Bool {
        guard let client else { return false }
        return (!client.kept && client.runClient != true) || client.refused != nil
    }

    /// The row's client state, when it outranks the row's health.
    public var clientState: PhoneGoogleClientState? { PhoneGoogleClientState.of(client, health: row?.health) }

    /// Sign in: shows Google's notice first, which must be accepted before anything is asked of the computer; with no
    /// client of the person's kept, the setup comes first.
    public func begin() {
        problem = nil; refused = nil; setupProblem = nil
        stage = needsSetup ? .setup : .notice
    }

    /// Set up (again): the setup, whatever is kept now.
    public func beginSetup() { problem = nil; refused = nil; setupProblem = nil; stage = .setup }

    public func declineNotice() { if stage == .notice { stage = .idle } }

    public func declineSetup() { if stage == .setup { stage = .idle } }

    /// Hands the client file to the computer, which keeps its secret in Secrets and answers its connections; kept, the
    /// sign-in goes on to Google's notice, as on the computer.
    public func keepClient(_ file: String) async {
        guard stage == .setup, !file.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        busy = true; setupProblem = nil; defer { busy = false }
        do {
            let view = try await session.request(.keepClient, args: [PhoneGoogleWords.kind, file], as: PhoneIntegrations.self)
            take(view)
            if stage == .setup { stage = .notice }
        } catch { setupProblem = error.localizedDescription }
    }

    /// The notice was accepted: the computer starts its sign-in and answers once the browser came back.
    public func accept() {
        guard stage == .notice else { return }
        problem = nil; refused = nil; cancelling = false
        stage = .waiting(page: nil, caught: false)
        asking += 1
        let current = asking
        Task {
            do {
                let answer = try await session.request(.signIn, args: [PhoneGoogleWords.kind, ["noticeAccepted": true]],
                                                       as: PhoneSignedIn.self, waits: false)
                take(answer.view)
                if current == asking { finish() }
            } catch {
                guard current == asking else { return }
                switch error {
                // Out of reach or unconfirmed: the sign-in still waits there, and its end says when it stopped.
                case PhoneError.unavailable, PhoneError.unconfirmed: return
                default:
                    if !cancelling { problem = error.localizedDescription }
                    finish()
                }
            }
        }
    }

    public func openAgain() { if case .waiting(let page?, _) = stage { showing = page.url } }

    public func cancel() async {
        cancelling = true
        busy = true; defer { busy = false }
        do {
            let view = try await session.request(.signInCancel, as: PhoneIntegrations.self)
            take(view)
        } catch { problem = error.localizedDescription }
        finish()
    }

    /// Hands the address the browser ended on to the computer, which passes it to its waiting sign-in once.
    public func paste(_ address: String) async {
        guard case .waiting(let page?, _) = stage else { return }
        let said = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { return }
        busy = true; refused = nil; defer { busy = false }
        do {
            let answer = try await session.request(.signInReturn, args: [["id": page.id, "address": said]], as: PhoneSignInAnswer.self)
            if answer.status != 200 { refused = PhoneGoogleWords.pasteRefused }
        } catch { refused = error.localizedDescription }
    }

    /// Signs out: the computer forgets Google's sign-in and removes the connection.
    public func signOut() async {
        guard let row else { return }
        busy = true; problem = nil; defer { busy = false }
        do {
            let view = try await session.request(.integrationRemove, args: [row.id], as: PhoneIntegrations.self)
            take(view)
        } catch { problem = error.localizedDescription }
    }

    /// The computer's sign-in opened its page for its views. Only a sign-in this phone asked for shows it here.
    private func heard(_ page: PhoneSignInPage) {
        guard case .waiting(nil, _) = stage else { return }
        stage = .waiting(page: page, caught: false)
        Task {
            let session = session
            let started = await PhoneSignInReturnListener.start(port: page.port) { [weak self] path in
                let answer = await Self.handBack(session, id: page.id, address: path)
                if answer.status == 502 { await self?.lost(page.id) }
                return answer
            }
            guard case .waiting(let now?, _) = stage, now.id == page.id else { started?.stop(); return }
            listener = started
            stage = .waiting(page: page, caught: started != nil)
            if !Self.isolated { showing = page.url }
        }
    }

    /// Passes the browser's return to the computer and answers the page it said; one it cannot pass says why.
    nonisolated private static func handBack(_ session: ReadOnlySession, id: String, address: String) async -> PhoneSignInAnswer {
        do {
            return try await session.request(.signInReturn, args: [["id": id, "address": address]], as: PhoneSignInAnswer.self)
        } catch {
            return PhoneSignInAnswer(status: 502, page: "<!doctype html><meta charset=utf-8><p>\(error.localizedDescription)</p>")
        }
    }

    /// The return could not reach the computer: the address is asked for instead, as on the computers.
    private func lost(_ id: String) {
        guard case .waiting(let page?, true) = stage, page.id == id else { return }
        stage = .waiting(page: page, caught: false)
    }

    /// The computer's sign-in stopped waiting, whatever ended it.
    private func ended(_ id: String) {
        guard case .waiting(let page?, _) = stage, page.id == id else { return }
        finish()
        Task { await refresh() }
    }

    private func finish() {
        listener?.stop(); listener = nil
        stage = .idle; showing = nil
    }

    private func take(_ view: PhoneIntegrations) {
        row = view.integrations.first { $0.kind == PhoneGoogleWords.kind }
        client = row?.client ?? view.addable?.first { $0.kind == PhoneGoogleWords.kind }?.client
        read = true
    }

    /// The isolated phone check never opens a browser: the simulator shares its computer's loopback address, so a
    /// browser there would reach the computer's own sign-in directly, which no phone does.
    private static var isolated: Bool { ProcessInfo.processInfo.environment["INFINITARY_ISOLATED_PHONE_TEST"] == "1" }
}
