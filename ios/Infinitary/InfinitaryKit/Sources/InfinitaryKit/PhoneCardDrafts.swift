import Foundation
import Observation

/// INF-5445 piece 2: each open card's unsent draft on the phone - the body's answers as it last read them, the words in
/// the card's field and its queued notes - kept in memory while the app runs and shared with every other screen through
/// the first mate's computer (docs/ios.md, "Unsent picks on the phone"; `PhoneDraftSync` holds the rules). Nothing here
/// is written to the phone's saved connection file, and nothing is sent to anyone until the captain presses a button or
/// sends a reply.
@MainActor @Observable public final class PhoneCardDrafts {
    /// Each card's answers as its body last read them, the reading's `answers` list.
    public private(set) var answers: [String: PhoneJSON] = [:]
    /// The words in each card's own field.
    public private(set) var words: [String: String] = [:]
    /// The notes waiting to go with each card's reply.
    public private(set) var notes: [String: [PhoneJSON]] = [:]
    /// The bodies on screen for each card, which take another screen's answers at once (the bridge's `fill`).
    @ObservationIgnored private var bodies: [String: [UUID: @MainActor (PhoneJSON) -> Bool]] = [:]
    /// The cards whose field holds the keyboard: another screen's words wait until it lets go.
    @ObservationIgnored private var typing = Set<String>()
    /// Another screen's words that arrived while the card's field was typed in, with the words they arrived over.
    @ObservationIgnored private var waitingWords: [String: (words: String, over: String?)] = [:]
    /// The opening each card's draft here belongs to, as the computer's cards last said.
    @ObservationIgnored private var openings: [String: String?] = [:]
    @ObservationIgnored private var sync: PhoneDraftSync!

    /// `send` sends one change to the computer, `canSend` says whether one can reach it now, and `later` runs a closure
    /// after the captain's pause.
    public init(send: @escaping @MainActor (String, PhoneJSON) async throws -> PhoneJSON, canSend: @escaping @MainActor () -> Bool,
                later: @escaping @MainActor (@escaping @MainActor () -> Void) -> PhoneDraftTimer = PhoneDraftDeps.pause) {
        let local: @MainActor (String) -> PhoneDraftLocal = { [unowned self] in self.local($0) }
        sync = PhoneDraftSync(PhoneDraftDeps(
            local: local,
            opening: { [unowned self] in self.openings[$0].map(PhoneDraftOpening.known) ?? .unknown },
            apply: { [unowned self] in self.apply($0, $1) },
            send: send, canSend: canSend, later: later))
    }

    /// Whether the computer keeps drafts, as a welcome's reading said.
    public var enabled: Bool { sync.enabled }

    /// The answers a body born now starts with.
    public func fill(_ cardID: String) -> PhoneJSON { answers[cardID] ?? .array([]) }

    /// The card's body read its answers.
    public func read(_ cardID: String, answers reading: PhoneJSON) {
        guard answers[cardID] != reading else { return }
        let before = local(cardID)
        answers[cardID] = reading
        sync.changed(cardID, before: before, after: local(cardID))
    }

    /// The captain changed the words in the card's field.
    public func type(_ cardID: String, words typed: String) {
        let typed = typed.isEmpty ? nil : typed
        guard words[cardID] != typed else { return }
        let before = local(cardID)
        words[cardID] = typed
        sync.changed(cardID, before: before, after: local(cardID))
    }

    /// The captain queued, edited or removed a note, or a reply took them.
    public func note(_ cardID: String, notes queued: [PhoneJSON]) {
        let queued = queued.isEmpty ? nil : queued
        guard notes[cardID] != queued else { return }
        let before = local(cardID)
        notes[cardID] = queued
        sync.changed(cardID, before: before, after: local(cardID))
    }

    /// The card's field holds the keyboard, or lets it go; words that waited on it show once it lets go, unless the
    /// captain typed there since they arrived.
    public func typing(_ cardID: String, _ holds: Bool) {
        if holds { typing.insert(cardID); return }
        typing.remove(cardID)
        guard let waiting = waitingWords.removeValue(forKey: cardID), words[cardID] == waiting.over else { return }
        set(\.words, cardID, waiting.words.isEmpty ? nil : waiting.words)
    }

    /// A body on screen for the card, which takes another screen's answers while it shows; call the returned closure
    /// when it goes. `fill` answers whether the body took them.
    public func attach(_ cardID: String, fill: @escaping @MainActor (PhoneJSON) -> Bool) -> @MainActor () -> Void {
        let id = UUID()
        bodies[cardID, default: [:]][id] = fill
        return { [weak self] in
            self?.bodies[cardID]?[id] = nil
            if self?.bodies[cardID]?.isEmpty == true { self?.bodies[cardID] = nil }
        }
    }

    /// The computer's cards, as its last snapshot said: a card that left lets its draft here go, and one opened anew under
    /// the same id drops what the phone held for its earlier opening. True when the cards hold a card or opening the phone
    /// did not hold before, whose draft is then read.
    @discardableResult public func cards(_ cards: [PhoneCard]) -> Bool {
        let present = Dictionary(cards.map { ($0.id, $0.lifecycleID) }, uniquingKeysWith: { $1 })
        var arrived = false
        for (cardID, opening) in openings where present[cardID].map({ $0 != opening }) ?? true { drop(cardID) }
        for (cardID, opening) in present where openings[cardID].map({ $0 != opening }) ?? true {
            arrived = true
            openings[cardID] = opening
        }
        return arrived
    }

    /// Every open card's draft, as the phone read them at a welcome.
    public func welcome(_ drafts: [PhoneCardDraft]) {
        let held = Set(openings.keys).union(answers.keys).union(words.keys).union(notes.keys)
        sync.welcome(drafts, cardIDs: held.sorted())
    }

    /// Another screen changed a card's draft.
    public func heard(_ draft: PhoneCardDraft) { sync.heardLive(draft) }

    private func drop(_ cardID: String) {
        sync.forget(cardID)
        openings[cardID] = nil
        answers[cardID] = nil; words[cardID] = nil; notes[cardID] = nil
        waitingWords[cardID] = nil; typing.remove(cardID)
    }

    private func local(_ cardID: String) -> PhoneDraftLocal {
        PhoneDraftLocal(answers: answers[cardID].map(\.list), words: words[cardID], notes: notes[cardID])
    }

    private func apply(_ cardID: String, _ parts: PhoneDraftParts) {
        if let taken = parts.answers {
            let held = answers[cardID]?.list ?? []
            let merged = PhoneDraftSync.withDraftAnswers(held, taken)
            // Answers the phone already holds, such as its own kept change coming back, would only redraw the body.
            if merged != held {
                // A body on screen takes them at once and reads them back; a body born later starts with them.
                var filled = false
                for fill in (bodies[cardID] ?? [:]).values where fill(.array(taken)) { filled = true }
                if !filled { set(\.answers, cardID, .array(merged)) }
            }
        }
        if let given = parts.words {
            if typing.contains(cardID) { waitingWords[cardID] = (given, words[cardID]) }
            else { waitingWords[cardID] = nil; set(\.words, cardID, given.isEmpty ? nil : given) }
        }
        if let given = parts.notes { set(\.notes, cardID, given.isEmpty ? nil : given) }
    }

    /// Writes one card's part only when it changes: every write redraws each screen that reads the drafts.
    private func set<Value: Equatable>(_ part: ReferenceWritableKeyPath<PhoneCardDrafts, [String: Value]>, _ cardID: String,
                                       _ value: Value?) {
        if self[keyPath: part][cardID] != value { self[keyPath: part][cardID] = value }
    }
}
