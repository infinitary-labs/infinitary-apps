import Foundation

/// An open card's unsent draft as the first mate's computer keeps it for every screen that shows the card
/// (docs/card-authoring.md, "Unsent picks follow you"; `CardDraft` in src/shared/cardDrafts.ts): the body's answers by
/// question, the words in the card's own field and the notes waiting to go with them.
public struct PhoneCardDraft: Equatable, Sendable {
    public var cardID: String
    /// The card's opening the draft belongs to (`lifecycleId`); nil for a card written before openings were kept.
    public var lifecycle: String?
    public var revision: Int
    public var answers: [PhoneJSON]
    public var words: String
    public var notes: [PhoneJSON]

    public init(cardID: String, lifecycle: String? = nil, revision: Int = 0, answers: [PhoneJSON] = [], words: String = "",
                notes: [PhoneJSON] = []) {
        self.cardID = cardID; self.lifecycle = lifecycle; self.revision = revision
        self.answers = answers; self.words = words; self.notes = notes
    }

    /// A draft as the computer sent it; nil for anything else in its place.
    public init?(_ value: PhoneJSON) {
        guard let cardID = value["cardId"].text, !cardID.isEmpty, let revision = value["revision"].numeric,
              revision >= 0, revision == revision.rounded(), let words = value["words"].text,
              case .array(let answers) = value["answers"], case .array(let notes) = value["notes"],
              answers.allSatisfy({ $0["name"].text != nil }) else { return nil }
        if value["lifecycle"] != .null && value["lifecycle"].text == nil { return nil }
        self.init(cardID: cardID, lifecycle: value["lifecycle"].text, revision: Int(revision), answers: answers, words: words,
                  notes: notes)
    }
}

/// The card's opening as the phone holds its card: unknown for a card the phone does not hold, which sends nothing until
/// it does; known, nil for a card written before openings were kept.
public enum PhoneDraftOpening: Equatable, Sendable {
    case unknown
    case known(String?)
}

/// What a change asks to set, or another screen's change to take here.
public struct PhoneDraftParts: Equatable, Sendable {
    public var answers: [PhoneJSON]?
    public var words: String?
    public var notes: [PhoneJSON]?
    public init(answers: [PhoneJSON]? = nil, words: String? = nil, notes: [PhoneJSON]? = nil) {
        self.answers = answers; self.words = words; self.notes = notes
    }
}

/// This phone's own state of a card: what it holds, each nil where it holds nothing.
public struct PhoneDraftLocal: Equatable, Sendable {
    public var answers: [PhoneJSON]?
    public var words: String?
    public var notes: [PhoneJSON]?
    public init(answers: [PhoneJSON]? = nil, words: String? = nil, notes: [PhoneJSON]? = nil) {
        self.answers = answers; self.words = words; self.notes = notes
    }
}

/// A pause that runs once unless cancelled.
@MainActor public struct PhoneDraftTimer {
    public let cancel: () -> Void
    public init(cancel: @escaping () -> Void) { self.cancel = cancel }
}

/// What the phone's draft rules reach: the card state it holds, the computer, and the clock.
@MainActor public struct PhoneDraftDeps {
    public var local: @MainActor (String) -> PhoneDraftLocal
    public var opening: @MainActor (String) -> PhoneDraftOpening
    public var apply: @MainActor (String, PhoneDraftParts) -> Void
    /// Sends one change (`inf:cards:draft`) and returns the computer's answer; throws when it did not go or its answer
    /// was lost.
    public var send: @MainActor (String, PhoneJSON) async throws -> PhoneJSON
    /// Whether a change can reach the first mate's computer now.
    public var canSend: @MainActor () -> Bool
    /// Runs the closure once the captain has paused for `PhoneContract.draftQuietMs`.
    public var later: @MainActor (@escaping @MainActor () -> Void) -> PhoneDraftTimer

    public init(local: @escaping @MainActor (String) -> PhoneDraftLocal, opening: @escaping @MainActor (String) -> PhoneDraftOpening,
                apply: @escaping @MainActor (String, PhoneDraftParts) -> Void, send: @escaping @MainActor (String, PhoneJSON) async throws -> PhoneJSON,
                canSend: @escaping @MainActor () -> Bool, later: @escaping @MainActor (@escaping @MainActor () -> Void) -> PhoneDraftTimer) {
        self.local = local; self.opening = opening; self.apply = apply; self.send = send; self.canSend = canSend
        self.later = later
    }

    /// The real pause, on the main actor.
    public static func pause(_ run: @escaping @MainActor () -> Void) -> PhoneDraftTimer {
        let task = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(PhoneContract.draftQuietMs))
            guard !Task.isCancelled else { return }
            run()
        }
        return PhoneDraftTimer { task.cancel() }
    }
}

/// The phone's side of each open card's draft: the rules of the Mac's `DraftSync` (src/renderer/src/app/draftSync.ts),
/// which every window shares, without its saved revisions. The phone reads every draft at each welcome, sends what the
/// captain changed here once they pause (`PhoneContract.draftQuietMs`), so words typed into the field never go key by
/// key, one request per card at a time with the newest change waiting behind it, and takes what another screen changed
/// from the `inf:cards:draft` live frame. A part changed here and not yet sent is never overwritten by another screen's
/// change: it goes next and is the later change. A part changed while the computer is out of reach keeps the revision
/// the phone had then, in memory only, so it goes on return unless another screen changed the same part meanwhile.
@MainActor public final class PhoneDraftSync {
    private static let words = "words"
    private static let notes = "notes"
    private static func answerPart(_ name: String) -> String { "answer:" + name }

    typealias Parts = [String: PhoneJSON]
    /// The revision a waiting part goes against: the newest the phone took, for a part changed in reach, which is the
    /// later change; the revision then taken, for one changed out of reach, which keeps another screen's newer change.
    enum Base: Equatable { case latest, at(Int) }
    /// A request in flight: the parts it carries and the revision each goes against.
    final class Flight {
        let parts: Parts
        let bases: [String: Base]
        init(parts: Parts, bases: [String: Base]) { self.parts = parts; self.bases = bases }
    }

    private let deps: PhoneDraftDeps
    /// The draft as the computer last said it, by card.
    private var heard: [String: PhoneCardDraft] = [:]
    /// Live frames heard before the first welcome's reading answered, by card.
    private var early: [String: PhoneCardDraft] = [:]
    /// Parts changed here and not yet sent, with the revision each goes against, by card.
    private var dirty: [String: [String: Base]] = [:]
    private var flying: [String: Flight] = [:]
    private var timers: [String: PhoneDraftTimer] = [:]
    /// Each card's changes refused for their size, none sent again unchanged.
    private var refused: [String: [PhoneJSON]] = [:]
    private var welcomed = false

    public init(_ deps: PhoneDraftDeps) { self.deps = deps }

    /// Whether the computer keeps drafts, as a welcome's reading said.
    public var enabled: Bool { welcomed }

    /// Every open card's draft, as the phone read them at a welcome.
    public func welcome(_ drafts: [PhoneCardDraft], cardIDs: [String]) {
        welcomed = true
        var byCard: [String: PhoneCardDraft] = [:]
        for draft in drafts { byCard[draft.cardID] = draft }
        for draft in early.values where (byCard[draft.cardID]?.revision ?? -1) < draft.revision { byCard[draft.cardID] = draft }
        early = [:]
        for cardID in Set(cardIDs).union(byCard.keys).sorted() {
            // A card the phone does not hold yet is read again once it does.
            if deps.opening(cardID) == .unknown { continue }
            let read = byCard[cardID]
            if let read, !current(read) { continue }
            // A card with no draft has an empty one.
            adopt(read ?? PhoneCardDraft(cardID: cardID))
            flush(cardID)
        }
    }

    /// Another screen changed a card's draft.
    public func heardLive(_ draft: PhoneCardDraft) {
        guard current(draft) else { return }
        if welcomed { adopt(draft); return }
        if (early[draft.cardID]?.revision ?? -1) < draft.revision { early[draft.cardID] = draft }
    }

    /// The phone's state of a card changed: each part that now differs from the draft, as it will stand once the request
    /// in flight is kept, waits to go, and one that came back to it goes nowhere.
    public func changed(_ cardID: String, before: PhoneDraftLocal, after: PhoneDraftLocal) {
        let was = Self.parts(before, presentOnly: false)
        let now = Self.parts(after, presentOnly: false)
        var expected = heardParts(cardID)
        for (part, value) in flying[cardID]?.parts ?? [:] { expected[part] = value }
        var marked = dirty[cardID] ?? [:]
        var moved = false
        for (part, value) in now where was[part] != value {
            moved = true
            if !Self.differs(part, value, expected) { marked[part] = nil }
            else if marked[part] == nil { marked[part] = deps.canSend() ? .latest : .at(revision(cardID)) }
        }
        dirty[cardID] = marked
        guard moved else { return }
        schedule(cardID)
    }

    /// The card left the stack, or opened anew: its draft here goes with it.
    public func forget(_ cardID: String) {
        heard[cardID] = nil; early[cardID] = nil; dirty[cardID] = nil; flying[cardID] = nil; refused[cardID] = nil
        timers.removeValue(forKey: cardID)?.cancel()
    }

    private func schedule(_ cardID: String) {
        guard welcomed else { return }
        timers.removeValue(forKey: cardID)?.cancel()
        timers[cardID] = deps.later { [weak self] in
            guard let self else { return }
            self.timers[cardID] = nil
            self.flush(cardID)
        }
    }

    /// Sends what changed here, one request per card at a time and never before the captain pauses. One request carries
    /// the parts changed at the oldest revision, naming it; parts changed later go next with their own.
    private func flush(_ cardID: String) {
        guard welcomed, timers[cardID] == nil, flying[cardID] == nil, deps.canSend() else { return }
        guard var marked = dirty[cardID], !marked.isEmpty else { return }
        guard case .known(let lifecycle) = deps.opening(cardID) else { return }
        let local = localParts(cardID, presentOnly: false)
        let ready = marked.filter { part, _ in
            guard let value = local[part] else { return false }
            return !(part == Self.words && (value.text?.utf16.count ?? 0) > PhoneLimits.reply)
        }
        let taken = revision(cardID)
        func since(_ base: Base) -> Int { if case .at(let at) = base { return at }; return taken }
        // One group per revision, oldest first; a group refused for its size unchanged is passed by.
        for at in Set(ready.values.map(since)).sorted() {
            var sent: Parts = [:]
            var bases: [String: Base] = [:]
            for (part, base) in ready where since(base) == at { sent[part] = local[part]; bases[part] = base }
            let change = Self.change(since: at, lifecycle: lifecycle, sent)
            let key = Self.change(since: 0, lifecycle: lifecycle, sent)
            if refused[cardID]?.contains(key) == true { continue }
            for part in sent.keys { marked[part] = nil }
            dirty[cardID] = marked
            send(cardID, change: change, key: key, since: at, flight: Flight(parts: sent, bases: bases))
            return
        }
    }

    private func send(_ cardID: String, change: PhoneJSON, key: PhoneJSON, since: Int, flight: Flight) {
        flying[cardID] = flight
        // A change that did not go waits out of reach, against the revision it went with.
        let unsent = { [weak self] in
            guard let self else { return }
            var again = self.dirty[cardID] ?? [:]
            for part in flight.bases.keys where again[part] == nil { again[part] = .at(since) }
            self.dirty[cardID] = again
        }
        Task { @MainActor [weak self] in
            let answer: PhoneJSON
            do { answer = try await self?.deps.send(cardID, change) ?? .null }
            catch {
                // Out of reach, or the link dropped: it goes again at the next welcome.
                guard let self, self.flying[cardID] === flight else { return }
                self.flying[cardID] = nil
                unsent()
                return
            }
            // The card left, or opened anew, while this was on its way.
            guard let self, self.flying[cardID] === flight else { return }
            self.flying[cardID] = nil
            if let reason = answer["refused"].text {
                if reason == "closed" { self.forget(cardID); return }
                self.refused[cardID, default: []].append(key)
                unsent()
                // The card's other changes still go.
                self.flush(cardID)
                return
            }
            guard let draft = PhoneCardDraft(answer["draft"]) else { unsent(); return }
            // A part changed out of reach again while on its way goes against what the phone just kept, only where the
            // draft took the phone's change, not where a newer change passed it over.
            let passedAnswers = answer["passed"]["answers"].list.compactMap(\.text).map(Self.answerPart)
            let passed = Set(passedAnswers + (answer["passed"]["words"].flag ? [Self.words] : [])
                + (answer["passed"]["notes"].flag ? [Self.notes] : []))
            if var again = self.dirty[cardID] {
                for part in flight.parts.keys where !passed.contains(part) {
                    if case .at(let base) = again[part] { again[part] = .at(max(base, draft.revision)) }
                }
                self.dirty[cardID] = again
            }
            self.adopt(draft, sent: flight.parts)
            self.flush(cardID)
        }
    }

    /// Takes a draft the computer said: each part another screen changed, or that refused what the phone sent, shows
    /// here, unless the captain changed it here since and that change has yet to go.
    private func adopt(_ draft: PhoneCardDraft, sent: Parts? = nil) {
        let cardID = draft.cardID
        let before = heard[cardID]
        // An answer older than what the phone already took settles only what it refused.
        let stale = before.map { draft.revision < $0.revision } ?? false
        let latest = stale ? before! : draft
        let was = before.map(Self.parts(of:))
        let local = localParts(cardID, presentOnly: false)
        let marked = dirty[cardID]
        let flown = flying[cardID]?.parts
        var take: Parts = [:]
        for (part, value) in Self.parts(of: latest) {
            let elsewhere = was == nil || was?[part] != value
            let refusedHere = sent?[part] != nil && sent?[part] != value
            if !elsewhere && !refusedHere { continue }
            if marked?[part] != nil || flown?[part] != nil { continue }
            // A value the phone already shows goes nowhere at the first take; after it, it still goes, so it replaces an
            // older change that waits on a question being typed in.
            if was == nil && local[part] == value { continue }
            take[part] = value
        }
        if !stale { heard[cardID] = draft }
        if !take.isEmpty { deps.apply(cardID, Self.draftParts(take)) }
    }

    /// Whether a draft is of the card's current opening as the phone holds it.
    private func current(_ draft: PhoneCardDraft) -> Bool { deps.opening(draft.cardID) == .known(draft.lifecycle) }

    /// The revision a change here is made at: the newest the phone took.
    private func revision(_ cardID: String) -> Int { heard[cardID]?.revision ?? 0 }

    private func heardParts(_ cardID: String) -> Parts { Self.parts(of: heard[cardID] ?? PhoneCardDraft(cardID: cardID)) }

    private func localParts(_ cardID: String, presentOnly: Bool) -> Parts { Self.parts(deps.local(cardID), presentOnly: presentOnly) }

    /// An answer worth a draft where the draft holds none for its question: the captain's own.
    static func ownAnswer(_ answer: PhoneJSON) -> Bool {
        !answer["skipped"].flag && (answer["changed"].flag || answer["written"].text != nil)
    }

    /// Whether a value here is worth sending against the draft's.
    private static func differs(_ part: String, _ value: PhoneJSON, _ heard: Parts) -> Bool {
        guard let there = heard[part] else { return ownAnswer(value) }
        return there != value
    }

    private static func parts(of draft: PhoneCardDraft) -> Parts {
        var parts: Parts = [:]
        for answer in draft.answers { if let name = answer["name"].text { parts[answerPart(name)] = answer } }
        parts[words] = .string(draft.words)
        parts[notes] = .array(draft.notes)
        return parts
    }

    /// The phone's state as parts. Words and notes it holds none of read as none.
    private static func parts(_ local: PhoneDraftLocal, presentOnly: Bool) -> Parts {
        var parts: Parts = [:]
        for answer in local.answers ?? [] { if let name = answer["name"].text { parts[answerPart(name)] = answer } }
        if local.words != nil || !presentOnly { parts[words] = .string(local.words ?? "") }
        if local.notes != nil || !presentOnly { parts[notes] = .array(local.notes ?? []) }
        return parts
    }

    /// Parts as a change names them, the answers in their names' order.
    private static func draftParts(_ parts: Parts) -> PhoneDraftParts {
        var named = PhoneDraftParts()
        var answers: [PhoneJSON] = []
        for part in parts.keys.sorted() {
            let value = parts[part]!
            if part == words { named.words = value.text ?? "" }
            else if part == notes { named.notes = value.list }
            else { answers.append(value) }
        }
        if !answers.isEmpty { named.answers = answers }
        return named
    }

    /// The change a request carries (`CardDraftChange`).
    private static func change(since: Int, lifecycle: String?, _ parts: Parts) -> PhoneJSON {
        let named = draftParts(parts)
        var fields: [String: PhoneJSON] = ["since": .number(Double(since))]
        if let lifecycle { fields["lifecycle"] = .string(lifecycle) }
        if let answers = named.answers { fields["answers"] = .array(answers) }
        if let words = named.words { fields["words"] = .string(words) }
        if let notes = named.notes { fields["notes"] = .array(notes) }
        return .object(fields)
    }

    /// The answers a body would read with another screen's answers in it: each one by its question's name.
    public static func withDraftAnswers(_ reading: [PhoneJSON], _ answers: [PhoneJSON]) -> [PhoneJSON] {
        let byName = Dictionary(answers.compactMap { answer in answer["name"].text.map { ($0, answer) } }, uniquingKeysWith: { $1 })
        let kept = reading.map { answer in answer["name"].text.flatMap { byName[$0] } ?? answer }
        let known = Set(kept.compactMap { $0["name"].text })
        return kept + answers.filter { !known.contains($0["name"].text ?? "") }
    }
}
