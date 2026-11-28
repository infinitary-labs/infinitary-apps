import InfinitaryKit
import SwiftUI

/// Infinitary's own bring card on the phone (docs/secrets.md, "Bringing secrets from another tool"; docs/ios.md,
/// "Bringing secrets from another tool"): one tick row per secret the Bring into Secrets button offers, as the Mac's
/// SecretBringPicks draws them, on the card's face between its body and its buttons. No value is ever here: Bring sends
/// the button's pass and the ticked rows' ids, and Infinitary runs or reads the source on the computer the card names.
/// Split from PhoneCards.swift; the pane's state stays there.
extension PhoneCardPane {
    /// The rows ticked now: the offer's own until the captain ticks one. A card raised again, after a read or a press the
    /// home could not finish, carries new passes, so it starts from its own offer; a refused press keeps its pass and ticks.
    func bringTicks(_ bring: PhoneSecretBring) -> Set<String> { bringTicked[bring.pass] ?? bring.ticked }

    func tickBring(_ row: PhoneSecretBring.Row, of bring: PhoneSecretBring) {
        guard row.cannot == nil else { return }
        var ticks = bringTicks(bring)
        if !ticks.insert(row.id).inserted { ticks.remove(row.id) }
        bringTicked = [bring.pass: ticks]
    }

    /// Whether the keyboard reaches the rows: the shown card's face, while no field holds the keyboard, a panel's
    /// included, and while the phone may change things, as the rows' touch does. Tab reaches the rows, the arrows move
    /// between them, Space ticks and Return brings, as the Mac's rows do (docs/keyboard.md).
    var bringTakesKeys: Bool {
        shown && visible && !card.isPast && !showsBack && pick == nil && replyFocus == nil
            && !messageContext.composerFocused && !messageContext.keyboardUp
            && !messageContext.panelFieldFocused && !messageContext.panelCardTyping
            && !host.changing && session.canChange
    }

    func bringRows(_ bring: PhoneSecretBring) -> some View {
        let ticks = bringTicks(bring)
        let open = bring.rows.filter { $0.cannot == nil }.map(\.id)
        return VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            PhoneSectionLabel(PhoneMessages.secretsBringPicks())
            ForEach(bring.rows) { row in
                let on = ticks.contains(row.id)
                // A touch draws no ring; once the keyboard has drawn one, it follows the touched row.
                Button { if bringRing != nil { bringRing = row.id }; tickBring(row, of: bring) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: PhoneTheme.space2) {
                        Image(systemName: on ? "checkmark.square.fill" : "square")
                            .font(PhoneFont.body).foregroundStyle(on ? PhoneTheme.accent : PhoneTheme.secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline, spacing: 0) {
                                Text(row.name).font(PhoneFont.mono).foregroundStyle(row.cannot == nil ? PhoneTheme.text : PhoneTheme.secondary)
                                if let place = row.place {
                                    Text(" · " + place).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary) // i18n-exempt: a separator between a name and its place
                                }
                            }
                            if let note = row.note {
                                Text(note).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(row.cannot != nil || host.changing || !session.canChange)
                .overlay {
                    if bringTakesKeys && bringRing == row.id {
                        RoundedRectangle(cornerRadius: PhoneTheme.controlRadius)
                            .strokeBorder(PhoneTheme.accent, lineWidth: 1.5).padding(-4).allowsHitTesting(false)
                            .accessibilityIdentifier("secret-bring-ring-\(row.id)")
                    }
                }
                .accessibilityLabel(([row.name] + [row.place, row.note].compactMap { $0 }).joined(separator: ", "))
                .accessibilityAddTraits(on ? [.isToggle, .isSelected] : .isToggle)
                .accessibilityIdentifier("secret-bring-\(row.id)")
            }
            Text(PhoneMessages.secretsBringNote()).font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .background {
            PhoneBrowsingKeys(active: bringTakesKeys && !open.isEmpty, keys: [.up, .down, .next, .open, .stop],
                              yieldsToPresentations: true, onReturn: { if bringRing != nil { bringSecrets(bring) } }) { key in
                switch key {
                case .up: bringRing = bringStep(open, from: bringRing, by: -1)
                case .down: bringRing = bringStep(open, from: bringRing, by: 1)
                // Tab enters the rows, then walks them and goes round past the last.
                case .next: bringRing = bringRing.flatMap { open.firstIndex(of: $0) }.map { open[($0 + 1) % open.count] } ?? open.first
                case .open: if let at = bringRing, let row = bring.rows.first(where: { $0.id == at }) { tickBring(row, of: bring) }
                case .stop: bringRing = nil
                case .left, .right: break
                }
            }.frame(width: 0, height: 0).accessibilityHidden(true)
        }
        // Only the pane whose rows take or give up the keys writes, so a card behind the shown one never clears it.
        .onChange(of: bringTakesKeys && !open.isEmpty, initial: true) { was, takes in
            if takes || was { messageContext.bringRowsTakeKeys = takes }
        }
        .onDisappear { if bringTakesKeys { messageContext.bringRowsTakeKeys = false } }
    }

    private func bringStep(_ rows: [String], from row: String?, by offset: Int) -> String? {
        guard let row, let index = rows.firstIndex(of: row) else { return rows.first }
        return rows[min(max(index + offset, 0), rows.count - 1)]
    }

    /// Whether this button is Bring into Secrets on a bring with nothing ticked, which waits for a tick.
    func bringsNothing(_ action: PhoneJSON) -> Bool {
        guard PhoneSecretBring.isBring(action), let bring = PhoneSecretBring.of(card) else { return false }
        return bringTicks(bring).isEmpty
    }

    /// Sends the pass and the ticked rows in their own request, never as a card choice. The home withdraws the card once
    /// the bring ends; otherwise the card stays and says why, with the same pass, or with new passes when the home raises
    /// it again.
    func bringSecrets(_ bring: PhoneSecretBring) {
        let picked = bringTicks(bring)
        guard !picked.isEmpty else { return }
        CharacterCues.pressed(card.id)
        perform {
            pending = bring.pass
            defer { pending = nil }
            switch try await bring.bring(picked, home: session) {
            case .brought:
                bringRing = nil
                host.chosen = true
                onSent()
            case .refused(let words): side.refused = words
            }
        }
    }
}
