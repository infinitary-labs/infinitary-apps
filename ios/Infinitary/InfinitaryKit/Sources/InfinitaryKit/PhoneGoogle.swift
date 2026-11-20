import Foundation
import Observation

/// What the computer says of its connections (`inf:integrations:list`), as far as Google's row reads it.
public struct PhoneIntegrations: Decodable, Sendable, Equatable {
    public struct Row: Decodable, Sendable, Equatable {
        public let id: String
        public let kind: String
        public let account: String?
        public let health: String
    }
    public let integrations: [Row]
}

private struct PhoneSignedIn: Decodable, Sendable { let id: String; let view: PhoneIntegrations }

/// Google's row in the phone's Settings (INF-3454's phone part; docs/ios.md, "Google in Settings"). The sign-in runs
/// on the computer, which keeps Google's keys; this phone shows its page, catches the browser's return on its own
/// loopback address and passes it to the computer, or passes the address the person pastes when it cannot listen.
@MainActor @Observable public final class PhoneGoogle {
    public enum Stage: Equatable {
        /// Nothing in progress.
        case idle
        /// Google's notice is up; nothing is asked of the computer until it is accepted.
        case notice
        /// The computer's sign-in waits. `page` is its page once heard; `caught` says this phone listens for the
        /// return, and false asks for the address instead.
        case waiting(page: PhoneSignInPage?, caught: Bool)
    }

    /// Google's connection on the computer, or nil when it has none.
    public private(set) var row: PhoneIntegrations.Row?
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

    /// Sign in: shows Google's notice first, which must be accepted before anything is asked of the computer.
    public func begin() { problem = nil; refused = nil; stage = .notice }

    public func declineNotice() { if stage == .notice { stage = .idle } }

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

    /// Shows the page again, as the computer's Settings offers.
    public func openAgain() { if case .waiting(let page?, _) = stage { showing = page.url } }

    /// Ends the computer's sign-in.
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
        read = true
    }

    /// The isolated phone check never opens a browser: the simulator shares its computer's loopback address, so a
    /// browser there would reach the computer's own sign-in directly, which no phone does.
    private static var isolated: Bool { ProcessInfo.processInfo.environment["INFINITARY_ISOLATED_PHONE_TEST"] == "1" }
}
