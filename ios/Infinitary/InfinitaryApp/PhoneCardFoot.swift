import InfinitaryKit
import PhotosUI
import SwiftUI

/// The card pane's pinned footer: the Mac's footer order, the choice row, the question stepper, the reply field and the
/// approval foot. Split from PhoneCards.swift; the pane's state stays there.

extension PhoneCardPane {
    /// INF-944 item 5 with the captain's INF-945 pick: the Mac's row, pinned under a hairline while the body runs on beneath.
    /// The Mac's footer order (footerGroups.ts): quiet actions such as the app's Decline first, then the other choices,
    /// and the default last, at the trailing edge.
    var footerOrder: [PhoneJSON] {
        let quiet = card.actions.filter { $0["variant"].text == "ghost" }
        let choices = card.actions.filter { $0["variant"].text != "ghost" }
        return quiet + choices.filter { !$0["default"].flag } + choices.filter { $0["default"].flag }
    }

    /// The Mac's footerVariant: the action's own variant, else primary for the default. The default waits muted while a
    /// required question has no answer.
    func footerKind(_ action: PhoneJSON) -> PhoneChoiceStyle.Kind {
        if unanswered && action["default"].flag { return .muted }
        switch action["variant"].text {
        case "primary": return .primary
        case "danger": return .danger
        case "secondary", "ghost": return action["danger"].flag ? .danger : .secondary
        default: return action["danger"].flag ? .danger : action["default"].flag ? .primary : .secondary
        }
    }

    var chosenID: PhoneJSON? { card.isPast && card.value["ending"]["how"].text != "closed" ? card.value["ending"]["actionId"] : nil }

    var foot: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            // INF-1524 piece 3: a merge card's facts stay with its choices.
            if let factsHost, factsHost.failure == nil {
                CardWebView(host: factsHost).frame(height: factsHost.height)
            }
            if let line { Text(line).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("card-error") }
            // INF-2565: a pane built again while its back shows starts turned, and its latest line gives way as the field does.
            if !messages.isEmpty { latestLine.modifier(PhoneFaceOnly(angle: turnAngle)) }
            // INF-3746: while a note is open the reply and the choices step aside for it; on an iPhone on its side the
            // editor takes their place in the foot.
            if pick != nil && shown && noteInFoot { noteEditor.modifier(PhoneFaceOnly(angle: turnAngle)) }
            // On an ask to keep a secret no plain field sits beside the masked ones: the reply is on the thread's back,
            // as on the Mac, where Chat opens the thread beside the card.
            if takesReply && pick == nil && PhoneSecretAsk.of(card) == nil {
                replyField(.face).modifier(PhoneFaceOnly(angle: turnAngle))
                    // INF-3468: the field and the margin under it, the place a typing field in a scrolling card rests.
                    .background(alignment: .top) {
                        Color.clear.frame(height: replyHeight + PhoneTyping.margin).allowsHitTesting(false).id(Self.replyRest)
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.paneSpace)) } action: { frame in
                        if pinsFrame { faceReplyFrame = frame }
                    }
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.contentSpace)) } action: { frame in
                        if !pinsFrame { replyInContent = frame }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in replyHeight = height; followCaret() }
            }
            if card.isPast { PhonePastCarried(words: sentWords, carried: card.value["carried"]) }
            if pick == nil, !card.isPast, let ask = PhoneSecretAsk.of(card) {
                secretFields(ask).modifier(PhoneFaceOnly(angle: turnAngle))
            }
            if pick == nil { PhoneCarryLine(carry: carry).modifier(PhoneFaceOnly(angle: turnAngle)) }
            if pick == nil { choiceRow.modifier(PhoneFaceOnly(angle: turnAngle)) }
        }
        .padding(.horizontal, PhoneTheme.space4).padding(.top, PhoneTheme.space2).padding(.bottom, PhoneTheme.space3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { if runsOn && pinsFrame { Rectangle().fill(PhoneTheme.line).frame(height: 1) } }
    }

    @ViewBuilder var choiceRow: some View {
            // INF-2794: every live note's one button, Done or Got it, where a decision's default sits.
            if card.actions.isEmpty, !card.isPast, let label = card.value["noteDone"]["label"].text {
                PhoneChoiceRow {
                    Button { if !endsTypingInstead() { pressNote() } } label: {
                        HStack(spacing: 6) {
                            Text(label)
                            if pending == Self.noteDoneID { ProgressView().controlSize(.mini).accessibilityLabel(PhoneMessages.phoneCommonSending()) }
                        }
                    }
                    .buttonStyle(PhoneChoiceStyle(replyTyping ? .muted : .primary))
                    .disabled(host.changing || !session.canChange || carry.holds)
                    .accessibilityHint(rest(card.value["noteDone"]["restWords"].text ?? ""))
                    .accessibilityIdentifier("note-done")
                }
            }
            if !card.isPast, let secrets, let use = secrets.use(card: card.id) {
                approvalFoot(use, secrets)
            } else if !card.actions.isEmpty {
                PhoneChoiceRow {
                    // The Mac's Chat on a card with a masked field: the reply is typed on the thread's back, never beside it.
                    if takesReply && !showsBack && PhoneSecretAsk.of(card) != nil {
                        Button { chatOnBack() } label: { Text(PhoneCardWords.chat) }
                            .buttonStyle(PhoneChoiceStyle(.secondary))
                            .disabled(!session.canChange)
                            .layoutValue(key: PhoneChoiceRow.Leading.self, value: true)
                            .accessibilityIdentifier("card-chat")
                    }
                    if asking, let count = host.reading["of"].numeric {
                        answersCount(Int(count)).layoutValue(key: PhoneChoiceRow.Leading.self, value: true)
                    }
                    ForEach(Array(footerOrder.enumerated()), id: \.offset) { _, action in
                        Button { if !endsTypingInstead() { choose(action) } } label: {
                            HStack(spacing: 6) {
                                Text(card.label(of: action) ?? PhoneMessages.phoneCardsChooseFallback())
                                if pending != nil && pending == action["id"].text { ProgressView().controlSize(.mini).accessibilityLabel(PhoneMessages.phoneCommonSending()) }
                            }
                        }
                        .buttonStyle(PhoneChoiceStyle(replyTyping ? .muted : footerKind(action), chosen: chosenID == action["id"]))
                        .disabled(card.isPast || host.changing || !session.canChange || !host.revealed || carry.holds)
                        .accessibilityValue(chosenID == action["id"] ? PhoneMessages.phoneCardsChosen() : "")
                        .accessibilityIdentifier("card-action-\(action["id"].text ?? "")")
                    }
                }
            }
    }

    /// The Mac's count of the picks, as a stepper through a decision's questions (docs/keyboard.md, "Moving between a
    /// card's questions"; design skill ResponseCard footer rule): a tap on the count goes to the next question with no
    /// answer, and from two questions on an arrow before it goes to the previous question and one after it to the next.
    /// A step brings the question into view and marks it; ⌘J and ⇧⌘J from a keyboard also give it focus, so the body's own
    /// keys answer it. A playable preview's count reads as its settings and steps nowhere.
    @ViewBuilder func answersCount(_ count: Int) -> some View {
        // As the Mac counts: picks a person made, the required questions still waiting, and those left to their Default (INF-4425).
        let answered = Int(host.reading["answered"].numeric ?? 0)
        let picked = host.reading["answers"].list.filter { !$0["skipped"].flag && (!$0["values"].list.isEmpty || $0["written"].text != nil) }.count
        let words = PhoneCardWords.answersLine(answered: host.preview ? answered : picked, of: count,
                                               changed: Int(host.reading["changed"].numeric ?? 0), toAnswer: max(0, count - answered),
                                               defaults: Int(host.reading["defaults"].numeric ?? 0), preview: host.preview)
        if host.preview {
            Text(words).font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
        } else {
            HStack(spacing: 0) {
                if count > 1 {
                    questionArrow(PhoneMessages.uiCardPreviousQuestion(), symbol: "chevron.backward", id: "card-question-previous") {
                        stepQuestion(-1, unpicked: false, keyboard: false)
                    }
                }
                Button { stepQuestion(1, unpicked: true, keyboard: false) } label: {
                    Text(words).font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
                        .padding(.horizontal, 4).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(PhoneMessages.commandCardsUnansweredQuestion())
                .accessibilityIdentifier("card-answers")
                if count > 1 {
                    questionArrow(PhoneMessages.uiCardNextQuestion(), symbol: "chevron.forward", id: "card-question-next") {
                        stepQuestion(1, unpicked: false, keyboard: false)
                    }
                }
            }
            .disabled(!host.revealed)
            // The keys move focus too, which a tap must not: the reply field keeps its keyboard.
            .background {
                if shown && !showsBack {
                    Button { stepQuestion(1, unpicked: false, keyboard: true) } label: { EmptyView() }
                        .keyboardShortcut("j", modifiers: .command).hidden()
                    Button { stepQuestion(-1, unpicked: false, keyboard: true) } label: { EmptyView() }
                        .keyboardShortcut("j", modifiers: [.command, .shift]).hidden()
                }
            }
        }
    }

    func questionArrow(_ label: String, symbol: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: symbol).labelStyle(.iconOnly).font(.system(size: 12, weight: .semibold))
                .foregroundStyle(PhoneTheme.secondary).frame(minWidth: 36, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }

    func stepQuestion(_ step: Int, unpicked: Bool, keyboard: Bool) {
        if showsBack { turnOver(back: false) }
        Task { followQuestion(await host.question(step: step, unpicked: unpicked, keyboard: keyboard)) }
    }

    func followQuestion(_ step: CardWebHost.QuestionStep) {
        if case .moved(let top, let height) = step { host.showQuestion(top: top, height: height, animated: !reduceMotion) }
    }

    /// INF-1524, the captain's picks: the reply field pinned above the choices, its words also going with a choice, and
    /// photos from the library or the camera. INF-1919: the face and the back each draw it, with one draft and photos.
    func replyField(_ side: CardSide) -> some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if !notes.isEmpty {
                PhoneQueuedNotes(notes: notes, disabled: host.changing, onEdit: editNote,
                                 onRemove: { note in notes.removeAll { PhoneCardNotes.same($0, note) } }, failures: noteFailures)
            }
            if !photos.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(photos) { photo in
                            Button { photos.removeAll { $0.id == photo.id } } label: {
                                Image(uiImage: photo.image).resizable().scaledToFill()
                                    .frame(width: 44, height: 44).clipped()
                                    .overlay(alignment: .topTrailing) { Image(systemName: "xmark.circle.fill").foregroundStyle(PhoneTheme.text, PhoneTheme.surface) }
                            }.accessibilityLabel(PhoneMessages.phoneCommonRemovePhoto()).accessibilityIdentifier("reply-photo-chip")
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 0) {
                // INF-3296's phone piece: Point at, at the field's leading edge as on the Mac; while it is on, a tap on a
                // part of the body opens its note. Words selected in the body offer Annotate in their menu either way.
                // It steps aside while the reply types, so the words keep the field's whole width and the card rises no
                // further than INF-3468 lets it (its press would put the keyboard away in any case).
                if takesNotes && replyFocus == nil {
                    Button {
                        pointAt.toggle()
                        if pointAt { replyFocus = nil; dismissPhoneKeyboard() }
                    } label: {
                        // INF-3746: the Mac's outline pointer, lit in a 32-point circle that sits inside the field's
                        // rounded end, in a 44-point touch area.
                        PhoneSymbol.pointer.image.resizable().frame(width: 18, height: 18)
                            .foregroundStyle(pointAt ? PhoneTheme.accent : PhoneTheme.secondary)
                            .frame(width: 32, height: 32)
                            .background { if pointAt { Circle().fill(PhoneTheme.accentDim) } }
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel(PhoneCardWords.pointAt)
                    .accessibilityAddTraits(pointAt ? .isSelected : [])
                    .accessibilityIdentifier("point-at")
                    .disabled(host.changing || !host.drawn)
                }
                Menu {
                    Button { libraryOpen = true } label: { Label(PhoneMessages.phoneCardsChoosePhotos(), systemImage: "photo.on.rectangle") }.accessibilityIdentifier("choose-photos")
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { cameraOpen = true } label: { Label(PhoneMessages.phoneCardsTakePhoto(), systemImage: "camera") }
                    }
                } label: {
                    Label(PhoneMessages.phoneCardsAddPhotos(), systemImage: "photo").labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .disabled(photos.count >= PhoneLimits.images || host.changing).accessibilityIdentifier("reply-photos")
                TextField(PhoneCardWords.replyHint, text: $reply, axis: .vertical).lineLimit(messageContext.pencilRoom ? 4...5 : 1...5)
                    .padding(.vertical, PhoneTheme.space2).frame(minHeight: 44)
                    .focused($replyFocus, equals: side).accessibilityIdentifier("card-reply")
                    .onAppear { if pendingFocus == side { replyFocus = side; pendingFocus = nil } }
                // INF-3746: the message box's own 32-point send circle, in a 44-point touch area.
                Button(action: sendReply) {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PhoneTheme.onAccent)
                        .frame(width: 32, height: 32)
                        .background(canSendReply ? PhoneTheme.accent : PhoneTheme.muted, in: Circle())
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.accessibilityLabel(PhoneMessages.phoneCardsSendReply()).accessibilityIdentifier("send-reply")
                    .disabled(!canSendReply)
                    .hidesKeyboardBefore(replyFocus == side && messageContext.keyboardUp, diameter: 32)
            }.phoneInput()
                // INF-589 item 11: the line under the composer says why; the reply row only dims.
                .opacity(session.canChange ? 1 : 0.5)
            if reply.utf16.count > PhoneLimits.reply { Text(PhoneMessages.phoneCardsReplyTooLong(count: PhoneLimits.reply)).foregroundStyle(PhoneTheme.warning) }
        }
    }

    /// A Secrets use the home raised: an enrolled phone allows it with its confirmation and signature, any phone may
    /// refuse it, and one it cannot make here says where (docs/secrets.md, "Remote decisions"). INF-1109, the captain:
    /// "right now it's not even clear what secrets are being requested", so each is named as the computer's card names
    /// it (`named`, INF-1690's plan). A title already naming one or two ("the X secret", "the X and Y secrets") keeps the
    /// names, rather than the foot saying them twice beside a three-line title; otherwise the foot names every secret.
    /// A choice only the computer makes is a small link beside the note, so the choices made here keep one row.
    func approvalFoot(_ use: PhoneApprovals.Use, _ secrets: PhoneSecrets) -> some View {
        let names = use.secrets.map(use.named)
        let phrases = names.count == 1 ? ["the \(names[0]) secret to "] // i18n-exempt: matched in the computer's own title, not shown
            : names.count == 2 ? ["the \(names[0]) and \(names[1]) secrets to ", "the \(names[1]) and \(names[0]) secrets to "] // i18n-exempt: matched in the computer's own title, not shown
            : []
        let titleNames = phrases.contains { card.title.contains($0) }
        return VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            ForEach(titleNames ? [] : use.secrets, id: \.ref) { secret in
                let name = Text(secret.label).font(PhoneFont.headline).foregroundStyle(PhoneTheme.text)
                let detail = Text(use.detail(secret).joined(separator: " · ")).font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary)
                Text("\(name)  \(detail)")
                    .accessibilityLabel(use.named(secret)).accessibilityIdentifier("approval-secret-\(secret.ref)")
            }
            let choices = footerOrder.map { ($0, secrets.choice($0["id"].text, for: use)) }, computer = session.mac.name, choose = { (choice: PhoneSecrets.Choice) in
                if let words = choice.notice(computer: computer) { host.notice = words } else { decide { try await secrets.decide(choice, use) } } }
            PhoneCaptionLinks {
                Text(secrets.allows(use) ? PhoneMessages.phoneCardsApprovalAsks(confirmation: ApprovalKey.confirmation) : PhoneMessages.phoneCardsApprovalTurnOn(computer: computer))
                    .font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("approval-note")
            } links: {
                ForEach(Array(choices.enumerated()).filter { $0.element.1 == .onComputer }, id: \.offset) { _, pair in
                    Button(card.label(of: pair.0) ?? PhoneMessages.phoneCardsChooseFallback()) { choose(pair.1) }.font(PhoneFont.caption)
                        .foregroundStyle(PhoneTheme.accent).buttonStyle(.plain).accessibilityIdentifier(pair.1.identifier(pair.0["id"].text))
                }
            }.disabled(host.changing || !session.canChange || !host.revealed)
            PhoneChoiceRow {
                ForEach(Array(choices.enumerated()).filter { $0.element.1 != .onComputer }, id: \.offset) { _, pair in
                    Button(card.label(of: pair.0) ?? PhoneMessages.phoneCardsChooseFallback()) { choose(pair.1) }
                        .buttonStyle(PhoneChoiceStyle(footerKind(pair.0))).accessibilityIdentifier(pair.1.identifier(pair.0["id"].text))
                }
            // As on every card (INF-1083, INF-1574), a press waits for the revealed body, so it cannot land beside a moving choice.
            }.disabled(host.changing || !session.canChange || !host.revealed)
        }
    }
    func decide(_ decision: @escaping @MainActor () async throws -> PhoneSecrets.Outcome) {
        let activeHost = host
        perform {
            switch try await decision() {
            case .accepted: break
            case .stillWaiting:
                throw PhoneRequestError(PhoneMessages.phoneCardsApprovalStillWaiting())
            case .refused(let reason): throw PhoneRequestError(reason)
            }
            activeHost.chosen = true
            onSent()
        }
    }
    var kind: some View {
        let attention = !card.isPast && card.author == "host"
        let ended = !card.isPast && card.value["ended"] != .null
        return Text(card.isPast ? PhoneMessages.cardPastMark() : ended ? PhoneMessages.phoneCardsKindEnded() : attention ? PhoneMessages.uiCardKindAttention()
            : card.actions.isEmpty ? PhoneMessages.uiCardKindNote() : PhoneMessages.uiCardKindDecision())
            .font(.custom("JetBrainsMono-Regular", size: 11, relativeTo: .caption2))
            .foregroundStyle(attention ? PhoneTheme.danger : card.actions.isEmpty || card.isPast ? PhoneTheme.secondary : PhoneTheme.accent)
            .padding(.horizontal, PhoneTheme.space2).padding(.vertical, 4)
            .background(PhoneTheme.background, in: RoundedRectangle(cornerRadius: PhoneTheme.controlRadius))
            .fixedSize().accessibilityIdentifier("card-kind")
    }
    var ending: String {
        let end = card.endingForWords
        let words = PhonePastEnding.words(end)
        guard let at = end["at"].numeric else { return words }
        return "\(words) · \(PhoneFormats.dateTime(Date(timeIntervalSince1970: at / 1000)))"
    }
    /// The words a past card's choice carried from its field (the Mac's anythingElseOf).
    var sentWords: String? {
        let words = card.value["answers"].list.first { $0["name"].text == PhoneCardWords.anythingElse }?["written"].text
        return words?.isEmpty == false ? words : nil
    }
    func onMac(_ action: PhoneJSON) -> Bool {
        let effect = action["effect"]
        return (effect["kind"].text == "open" && !(effect["target"].text == "browser" && effect["savedSignIn"].flag))
            || (effect["kind"].text == "host" && effect["op"].text == "restore-account")
            // Its other Secrets choices need the person's confirmation on the computer itself, an ask's Unlock among
            // them; an ask's Don't keep, its declining choice, allows nothing, so it is answered here.
            || (effect["kind"].text == "host" && effect["op"].text == "secrets-decision"
                && !(PhoneSecretAsk.of(card) != nil && action["declines"].flag))
    }
}
