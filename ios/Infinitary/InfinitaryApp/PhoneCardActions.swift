import InfinitaryKit
import PhotosUI
import SwiftUI

/// What the card pane does on a press: secret fields, choosing, replying, notes, putting aside and connecting the host.
/// Split from PhoneCards.swift; the pane's state stays there.

extension PhoneCardPane {
    /// INF-4239 piece 4: one masked field per secret an ask names, as the Mac's SecretAskFields draws them: each under
    /// its secret's name, with its place and the version it replaces beside it once (INF-5516's plan). A return moves
    /// to the next field and, in the last, saves.
    func secretFields(_ ask: PhoneSecretAsk) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space3) {
            ForEach(Array(ask.fields.enumerated()), id: \.element.id) { at, field in
                VStack(alignment: .leading, spacing: 6) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(field.name).font(PhoneFont.subheadline.weight(.medium)).foregroundStyle(PhoneTheme.text)
                        ForEach(field.details, id: \.self) { detail in
                            Text(detail).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                        }
                    }
                    .accessibilityHidden(true)
                    SecureField(PhoneMessages.phoneSecretsAskPlaceholder(), text: Binding(
                        get: { secretValues[field.id] ?? "" },
                        set: { secretValues[field.id] = $0 }))
                        .textFieldStyle(.phone).textContentType(.password)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .focused($secretFocus, equals: field.id)
                        .submitLabel(at + 1 < ask.fields.count ? .next : .done)
                        .onSubmit {
                            if at + 1 < ask.fields.count { secretFocus = ask.fields[at + 1].id } else { keepSecrets(ask) }
                        }
                        .disabled(host.changing || !session.canChange)
                        .accessibilityLabel(([field.name] + field.details).joined(separator: ", "))
                        .accessibilityIdentifier("secret-ask-\(field.id)")
                }
            }
            Text(ask.fields.count > 1 ? PhoneMessages.phoneSecretsAskNoteMany() : PhoneMessages.phoneSecretsAskNoteOne())
                .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
        }
        .onDisappear { secretValues.removeAll() }
    }

    /// Sends what was typed with the Save button's pass in its own request, never as a card choice. The home withdraws
    /// the card once everything is kept; otherwise the card stays, says why, and keeps the fields for another Keep.
    func keepSecrets(_ ask: PhoneSecretAsk) {
        let values = secretValues
        perform {
            pending = ask.pass
            defer { pending = nil }
            switch try await ask.keep(values, home: session) {
            case .kept:
                secretValues.removeAll()
                secretFocus = nil
                host.chosen = true
                onSent()
            // The home raises the card again with new passes, so the words outlast this pane on its side.
            case .refused(let words): side.refused = words
            }
        }
    }

    func choose(_ action: PhoneJSON) {
        if onMac(action) { host.notice = PhoneMessages.phoneCardsDoThisOn(computer: session.mac.name); return }
        if PhoneSecretAsk.isKeep(action) {
            if let ask = PhoneSecretAsk.of(card) { CharacterCues.pressed(card.id); keepSecrets(ask) }
            return
        }
        let id = action["id"].text
        perform {
            pending = id
            defer { pending = nil }
            let snapshot = try await host.submissionReading()
            let reading = snapshot.value
            guard !action["default"].flag || reading["answered"] == reading["of"] else {
                throw PhoneRequestError(PhoneMessages.phoneCardsAnswerRequiredFirst())
            }
            // INF-1524: the field's words go with the choice as its anything-else answer, as the Mac's withAnythingElse sends them.
            let words = replyWords
            var answers = sendable(reading["answers"].list.filter { $0["name"].text != PhoneCardWords.anythingElse })
            if !words.isEmpty { answers.append(PhoneCardHeld.written(words)) }
            // INF-5608 piece 2: the field's photos and queued notes go in the same press to a computer that takes them.
            let held = carry.holds ? PhoneCardHeld() : PhoneCardHeld(photos: photos, notes: notes)
            // INF-2553: the card leaves at the tap with its words; a refusal brings it back to its place with them.
            if replyWords == words { reply = "" }
            held.take(from: $photos, $notes)
            let sent = await send(.choose(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID), .act,
                [.string(card.id), action["id"], .string("chrome"), .object(held.value(answers: answers)),
                 card.submission(reading: reading, fresh: snapshot.fresh)],
                restore: held.restoring(words: words, $reply, $photos, $notes))
            if sent { host.chosen = true; onSent() }
        }
    }

    /// The answers as the home reads them: one that does not list `card-answer-skipped` reads them strictly, so each skip's
    /// mark is left out and its Default goes as an answer kept as proposed (the Mac's `skippedAnswersFor`, INF-4425).
    func sendable(_ answers: [PhoneJSON]) -> [PhoneJSON] {
        guard !session.homeReadsSkips else { return answers }
        return answers.map { answer in
            guard case .object(var fields) = answer else { return answer }
            fields.removeValue(forKey: "skipped")
            return .object(fields)
        }
    }

    func sendReply() {
        perform {
            let text = reply, held = PhoneCardHeld(photos: photos, notes: notes)
            guard replyFits else { return }
            let snapshot = try await host.submissionReading()
            let reading = snapshot.value
            var payload: [String: PhoneJSON] = ["text": .string(text), "answers": .array(sendable(reading["answers"].list))]
            // INF-3296's phone piece: every queued note goes with the words and photos as one reply.
            held.add(to: &payload)
            // INF-2553: the words join the thread at once, marked sending, and the draft clears; a refusal puts the
            // words and photos back. INF-1919: a send from either side shows its line on the back, the first included.
            if reply == text { reply = "" }
            held.take(from: $photos, $notes)
            pointAt = false
            turned = true; replyFocus = nil
            let before = PhoneIntentLedger.captainMessages(session.threads[card.id])
            let delivered = await self.send(.reply(card: card.id, text: PhoneCardNotes.sendingText(text, held.notes), before: before), .reply,
                [.string(card.id), .object(payload), card.submission(reading: reading, fresh: snapshot.fresh), .bool(replyLeaves)],
                restore: held.restoring(words: text, $reply, $photos, $notes))
            if delivered { onSent() }
        }
    }

    static let noteDoneID = "note-done"

    /// A live note's own button (INF-2794): the computer decides whether it closes the task (Done) or reads the note (Got it).
    func pressNote() {
        perform {
            pending = Self.noteDoneID
            defer { pending = nil }
            // INF-924: the field's words go with Done or Got it as their anything-else answer, as with any other
            // choice; an empty field sends the press as before.
            let words = replyWords
            // INF-5608 piece 2: the field's photos and queued notes go with it too, as the reply under the note.
            let held = carry.holds ? PhoneCardHeld() : PhoneCardHeld(photos: photos, notes: notes)
            var args: [PhoneJSON] = [.string(card.id), card.submission()]
            if !words.isEmpty || !held.isEmpty {
                args.append(.object(held.value(answers: words.isEmpty ? [] : [PhoneCardHeld.written(words)])))
            }
            if replyWords == words { reply = "" }
            held.take(from: $photos, $notes)
            let sent = await send(.close(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID), .noteDone, args,
                restore: held.restoring(words: words, $reply, $photos, $notes))
            if sent { host.chosen = true; onSent() }
        }
    }

    /// The shared minus only puts away (INF-2794); a computer from before that still reads a note it marks "read".
    /// The session shows it at the tap and restores its place if the computer refuses it.
    func putAside() {
        if card.isPast { onHide(); return }
        // An ended card's minus is Close, like its button: words in the field go with it rather than be lost.
        // INF-5608 piece 2: so do the photos and notes in it, to a computer that takes them.
        if card.value["ended"] != .null && (!replyWords.isEmpty || carry != .nothing && !carry.holds) { pressNote(); return }
        perform {
            let sent: Bool
            if card.value["corner"] == .null {
                sent = await send(.putAside(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID), .minimize,
                                  [.string(card.id), .bool(true)])
            } else {
                let kind: PhoneIntent.Kind = card.value["corner"]["operation"] == .string("read")
                    ? .close(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID)
                    : .putAside(card: card.id, lifecycle: card.lifecycleID, offer: card.offerID)
                sent = await send(kind, .close, [.string(card.id), card.submission()])
            }
            if sent { host.chosen = true }
        }
    }

    /// Sends one change through the session's intent layer, which shows it now and says why when it is taken back,
    /// so the pane itself says nothing more; true once the computer accepted it.
    func send(_ kind: PhoneIntent.Kind, _ channel: PhoneCardRequest, _ args: [PhoneJSON],
                      restore: (@MainActor () -> Void)? = nil) async -> Bool {
        do { if channel != .reply { CharacterCues.pressed(card.id) }; try await session.change(kind, channel, args, restore: restore); return true } catch { return false }
    }

    func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        let activeHost = host
        guard activeHost.beginChange() else { return }
        problem = nil
        side.refused = nil
        Task {
            defer { activeHost.busy = false }
            do { try await operation() } catch { problem = error.localizedDescription }
        }
    }
    func connectHost() {
        host.onDrawn = { markSeen(); syncNotes() }
        host.annotates = takesNotes && shown
        host.onAnnotate = { note, box in
            guard takesNotes, shown, !host.changing else { syncNotes(); return }
            // A comment being written keeps its editor; the frame's pick goes back to it.
            if let pick, !pick.comment.isEmpty { syncNotes(); return }
            if showsBack { turnOver(back: false) }
            replyFocus = nil
            // Point at turns off once it has picked, as on the Mac; pointing at another part takes it again.
            pointAt = false
            pick = PhoneNotePick(note: note, box: box, queued: notes)
        }
        host.onAnnotationIdle = { syncNotes() }
        host.onPointExit = { pointAt = false }
        host.onLink = { url in openURL(url) }
        host.onDraft = onDraft
        host.onTask = onTask
        // A clip plays in this card's strip only while it is the shown card (docs/card-authoring.md "Sound clips").
        host.onSound = { payload in if shown && !card.isPast { CardSound.shared.play(card: card.id, payload: payload, session: session) } }
        host.onQuestioned = { step in if shown { followQuestion(step) } }
        // INF-3110: a card beside the shown one keeps its body out of accessibility, which a hidden view above it cannot do.
        host.aside = !shown; factsHost?.aside = !shown
        // INF-4353: a body the row kept loaded beside the shown card drew with no pane listening, so its drawing never
        // came to tell it how the notes stand, and its frame took no Annotate. The pane tells it now; a body still
        // loading hears it when it draws.
        syncNotes()
    }
    /// INF-3296's phone piece: tells the body how the notes stand, which it lights: Point at, every queued note and the
    /// one being written. The body never hears a comment.
    func syncNotes() {
        guard takesNotes else { if host.drawn { host.annotate(mode: false, queued: [], current: nil) }; return }
        host.annotate(mode: pointAt && pick == nil && shown, queued: notes, current: pick?.note)
    }
    /// The editor's Queue: the note joins the queue, or takes its own place there again; with Command-Return the reply
    /// goes too, with every queued note. A text note leaves no selection behind in the body (INF-3746).
    func queueNote(send: Bool) {
        guard let picked = pick, !host.changing else { return }
        let queue = PhoneCardNotes.queuing(picked.written, in: notes)
        notes = queue
        noteFailures[PhoneQueuedNotes.id(picked.note)] = nil
        pick = nil
        if picked.note["span"] != .null { host.annotate(mode: pointAt && shown, queued: queue, current: nil, clearsSelection: true) }
        if send { sendReply() }
    }
    /// A queued note's Edit: the body shows its part again and its editor opens under it, with its comment.
    func editNote(_ note: PhoneJSON) {
        Task {
            let result = await revealNote(note)
            switch result {
            case .revealed(let top, let height):
                noteFailures[PhoneQueuedNotes.id(note)] = nil
                pick = PhoneNotePick(note: note, box: CGRect(x: 0, y: top, width: host.width, height: max(1, height)), queued: notes)
            case .missing: noteFailures[PhoneQueuedNotes.id(note)] = PhoneCardWords.staleNote
            case .unavailable: noteFailures[PhoneQueuedNotes.id(note)] = PhoneCardWords.unavailableNote
            }
        }
    }
    /// Shows a note's part, or its words, in the body: the card turns to its face and its scroller brings them into view.
    func revealNote(_ note: PhoneJSON) async -> CardWebHost.NoteReveal {
        if showsBack { turnOver(back: false) }
        let result = await host.reveal(note)
        if case .revealed(let top, let height) = result {
            revealedNote = (top, height, (revealedNote?.seq ?? 0) + 1)
        }
        return result
    }
    /// The fact strip the body split off, drawn by a host of its own that holds only it and takes no answers.
    func showFacts(_ facts: String) {
        guard factsHost == nil else { return }
        // INF-3460: a strip the row kept loaded beside the shown card arrives drawn with its body.
        guard let factsHost = bodies?.strip(card, facts: facts, session: session)
            ?? card.factsStrip(facts).map({ CardWebHost(card: $0, session: session, fill: .array([]), part: .facts) }) else { return }
        factsHost.onLink = { url in openURL(url) }
        factsHost.aside = !shown
        self.factsHost = factsHost
    }
    func markSeen() {
        guard !card.isPast, host.drawn, reachable, visible, phase == .active else { return }
        onSeen()
    }
    /// A read the connection's end fails says nothing on the card: the card asks again once back in reach, and the
    /// computer button already says whether it is (the captain: "everywhere else in the ios app said it's in reach").
    func readThread() {
        guard !card.isPast, reachable else { return }
        Task {
            do { try await session.readThread(card.id) }
            catch PhoneError.unavailable {}
            catch { problem = error.localizedDescription }
        }
    }
    func loadPhotos() async {
        guard !photoSelection.isEmpty else { return }
        defer { photoSelection = [] }
        for item in photoSelection {
            do {
                guard photos.count < PhoneLimits.images, let bytes = try await item.loadTransferable(type: Data.self) else {
                    throw PhoneError.refused(PhoneMessages.phoneCardsPhotoNotAdded())
                }
                photos.append(try PhonePhoto(bytes: bytes))
            } catch is CancellationError { return }
            catch { problem = error.localizedDescription }
        }
    }
}
