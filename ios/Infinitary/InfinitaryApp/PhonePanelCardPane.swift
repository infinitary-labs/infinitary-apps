import InfinitaryKit
import SwiftUI

/// INF-3830 piece 3: one of a panel's cards on Home, as the desktop draws one in its stack (`PanelCardView`): the card's
/// title, whose panel it is and a Hide, over the panel's own card view. Only the shown card runs a page; a card beside it
/// in the row is its surface and title until it shows.
struct PhonePanelCardPane: View {
    let entryID: String
    let model: PhonePanelsModel
    let shown: Bool
    let visible: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(PhoneMessageContext.self) private var messageContext
    @State private var room: CGFloat = 0

    private var entry: PhonePanelCardEntry? { model.cards.entry(entryID) }
    private var host: PanelWebHost? { model.cardHosts[entryID] }

    var body: some View {
        VStack(spacing: 0) {
            if let entry {
                VStack(alignment: .leading, spacing: 0) {
                    head(entry)
                    page(entry)
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .phoneCardSurface()
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("panel-card-\(entry.panel)-\(entry.id)")
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { room = $0 }
        .onChange(of: shown, initial: true) { _, shown in if shown { _ = model.cardHost(entryID) } }
        .onChange(of: visible, initial: true) { _, visible in if visible { model.seen(entryID) } }
        // INF-1208's direction C: only the shown card speaks for its page's text box, as a computer's card does.
        .onChange(of: shown && host?.typing == true, initial: shown) { was, typing in
            if shown || was { messageContext.panelCardTyping = typing }
        }
        // Hide and the panel's own close drop the host in the same pass as the card, so the shown pane lets go as it
        // leaves rather than asking a host that may be gone.
        .onDisappear { if shown { messageContext.panelCardTyping = false } }
    }

    private func head(_ entry: PhonePanelCardEntry) -> some View {
        HStack(alignment: .center, spacing: PhoneTheme.space2) {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title).font(.custom("SpaceGrotesk-Light", size: 17, relativeTo: .headline).weight(.medium))
                    .lineLimit(2).accessibilityIdentifier("panel-card-title")
                if let panel = model.panel(of: entryID) {
                    Text(panel.owner).font(PhoneFont.micro).foregroundStyle(PhoneTheme.muted).lineLimit(1)
                }
            }
            Spacer(minLength: PhoneTheme.space2)
            Button { model.hide(entryID) } label: {
                Label(PhoneCardWords.panelLeave, systemImage: "minus")
                    .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .keyboardShortcut(shown ? KeyboardShortcut("m", modifiers: [.command, .shift]) : nil)
            .accessibilityHint(PhoneCardWords.panelLeaveRest)
            .accessibilityIdentifier("panel-card-hide")
        }
        .padding(.leading, PhoneTheme.space4).padding(.trailing, PhoneTheme.space2).padding(.top, PhoneTheme.space2)
    }

    /// The panel's own card view: at its page's height up to the room the stage has, scrolling past it, or the whole
    /// room for a card that fills.
    @ViewBuilder private func page(_ entry: PhonePanelCardEntry) -> some View {
        let headRoom: CGFloat = 64
        let most = max(120, room - headRoom - PhoneTheme.space3)
        Group {
            if let host {
                switch host.stand {
                case .couldNotOpen(let failure):
                    line(PhonePanelWords.couldNotOpen(failure))
                case .unresponsive:
                    VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                        line(PhonePanelWords.unresponsive)
                        Button(PhonePanelWords.retry, action: host.retry).buttonStyle(PhoneChoiceStyle(.secondary))
                    }
                default:
                    let height = entry.height == "fill" ? most : min(most, host.contentHeight)
                    ScrollView {
                        PanelWebView(host: host, theme: scheme == .dark ? "dark" : "light")
                            .id(host.generation)
                            .frame(height: entry.height == "fill" ? most : host.contentHeight)
                            .opacity(host.stand != .drawn ? 0 : 1)
                    }
                    .scrollDisabled(entry.height == "fill" || host.contentHeight <= most)
                    .frame(height: entry.height == "fill" ? most : height)
                }
            } else {
                Color.clear.frame(height: 48)
            }
        }
        .padding(.horizontal, PhoneTheme.space4).padding(.bottom, PhoneTheme.space3)
    }

    private func line(_ words: String) -> some View {
        Text(words).font(PhoneFont.callout).foregroundStyle(PhoneTheme.secondary)
            .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
    }
}
