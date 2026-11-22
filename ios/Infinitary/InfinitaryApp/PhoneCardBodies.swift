import InfinitaryKit
import Observation
import SwiftUI

/// INF-3460, the captain's "Keep the neighbours' bodies loaded behind their outlines": the bodies of the shown card and
/// the cards beside it in the row, kept loaded while the row is still, so the card a swipe brings in arrives drawn at its
/// own height and nothing in it moves once the row rests. A merge card's fact strip is kept with its body.
/// Each body has one host and one view, which moves from the edge it loads behind into the card that shows it.
@MainActor final class PhoneCardBodies {
    private var bodies: [String: CardWebHost] = [:]
    private var strips: [String: CardWebHost] = [:]

    /// Who a card's body is: a revision draws a new body, so its offer is part of it.
    static func key(_ card: PhoneCard) -> String { "\(card.id):\(card.offerID ?? card.body)" }

    /// The card's body, made with `make` the first time. One whose page stopped while it waited beside the shown card,
    /// such as one the phone reclaimed, is made again, so it loads again without showing an error.
    func body(_ card: PhoneCard, make: () -> CardWebHost) -> CardWebHost {
        let key = Self.key(card)
        if let host = bodies[key], host.failure == nil || !host.aside { return host }
        bodies[key]?.close()
        let host = make()
        host.kept = true; host.aside = true
        bodies[key] = host
        return host
    }

    /// Every body but the shown card's sits beside it, one closed element with no name: a card that leaves the screen
    /// as the row rests is never told it no longer shows.
    func setAside(except shown: PhoneCard?) {
        let key = shown.map(Self.key)
        for (each, host) in bodies where each != key { host.aside = true }
        for (each, host) in strips where each != key { host.aside = true }
    }

    /// The body the card's own Retry made in place of one that failed.
    func replace(_ card: PhoneCard, with host: CardWebHost) {
        let key = Self.key(card)
        if bodies[key] !== host { bodies[key]?.close() }
        host.kept = true
        bodies[key] = host
    }

    /// The card's fact strip, read-only, once its body has split it off.
    func strip(_ card: PhoneCard, facts: String, session: ReadOnlySession) -> CardWebHost? {
        let key = Self.key(card)
        if let host = strips[key], host.failure == nil || !host.aside { return host }
        guard let strip = card.factsStrip(facts) else { return nil }
        strips[key]?.close()
        let host = CardWebHost(card: strip, session: session, fill: .array([]), part: .facts)
        host.kept = true; host.aside = true
        strips[key] = host
        return host
    }

    /// INF-5531 piece 2: every kept body's live reads follow its card, the shown one's and its neighbours' alike, so a
    /// card its author ended stops updating at once wherever its body is loaded (docs/live-prototype-security.md).
    func declare(_ cards: [PhoneCard]) {
        for card in cards { bodies[Self.key(card)]?.declare(card) }
    }

    /// The bodies of these cards, drawn or not, for the row's probe.
    func drawn(_ cards: [PhoneCard]) -> [Bool] { cards.map { bodies[Self.key($0)]?.drawn ?? false } }

    /// Closes every body but those of these cards: the row keeps only the shown card's and its neighbours'.
    func keep(only cards: [PhoneCard]) {
        let keys = Set(cards.map(Self.key))
        for (key, host) in bodies where !keys.contains(key) { bodies[key] = nil; host.close() }
        for (key, host) in strips where !keys.contains(key) { strips[key] = nil; host.close() }
    }

    deinit {
        // The row's own view state let go of the bodies; their views are already off the screen.
        let hosts = Hosts(all: Array(bodies.values) + Array(strips.values))
        Task { @MainActor in for host in hosts.all { host.close() } }
    }

    private struct Hosts: @unchecked Sendable { let all: [CardWebHost] }
}

extension PhoneCard {
    /// INF-1524: the card's fact strip as a card of its own that draws only the facts and takes no answers.
    func factsStrip(_ facts: String) -> PhoneCard? {
        guard case .object(var value) = value else { return nil }
        value["body"] = .string(facts); value["actions"] = .array([]); value["changes"] = .null
        return try? PhoneCard(.object(value))
    }
}

/// A card beside the shown one, loading behind its plain edge at the width its card gives the body, with a merge card's
/// fact strip under it. The edge's surface covers it, it takes no touches, and its page is one closed element with no
/// name, so an accessibility search still finds one body, the shown card's.
struct PhoneCardRowLoading: View {
    let page: CardWebHost
    let strip: CardWebHost?
    let row: PhoneCardRow

    var body: some View {
        let width = max(1, row.width - 2 * PhoneTheme.space4)
        VStack(spacing: 0) {
            CardWebView(host: page).frame(width: width, height: page.height).id(ObjectIdentifier(page))
            if let strip { CardWebView(host: strip).frame(width: width, height: strip.height).id(ObjectIdentifier(strip)) }
        }
        .frame(height: max(row.height, 1), alignment: .top).clipped()
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// INF-3460: the isolated phone gate's reading of the row, for the cards journey. Whether the bodies beside the shown card
/// have drawn; whether the card the last move brought had drawn its body before that move began; and how many times the
/// shown card's body has reported its height since the row came to rest, which a body that was ready never does.
/// Simulator builds with the gate's switch only.
@MainActor @Observable final class PhoneCardRowProbe {
    static let shared: PhoneCardRowProbe? = {
        #if targetEnvironment(simulator)
        let environment = ProcessInfo.processInfo.environment
        guard environment["INFINITARY_ISOLATED_PHONE_TEST"] == "1", environment["INFINITARY_TEST_CARD_ROW_PROBE"] == "1" else { return nil }
        return PhoneCardRowProbe()
        #else
        nil
        #endif
    }()

    private(set) var moves = 0
    private(set) var arrivedDrawn = false
    private(set) var reports = 0
    @ObservationIgnored private var drawnAtStart: Set<String> = []
    @ObservationIgnored private var resting: String?

    /// A swipe or a page turn began; these cards had drawn their bodies.
    func began(drawn: Set<String>) { drawnAtStart = drawn; resting = nil }

    func rested(on card: String) {
        moves += 1; arrivedDrawn = drawnAtStart.contains(card); reports = 0; resting = card
    }

    /// A card's body reported the height it drew at.
    func reported(_ card: String) { if card == resting { reports += 1 } }
}

struct PhoneCardRowProbeReading: View {
    let probe: PhoneCardRowProbe
    /// Whether each body beside the shown card has drawn.
    let beside: [Bool]

    var body: some View {
        Color.clear.frame(width: 1, height: 1)
            .accessibilityElement().accessibilityIdentifier("card-row-probe")
            .accessibilityLabel("beside \(beside.allSatisfy { $0 } ? "drawn" : "loading"), \(probe.moves) moves, " // i18n-exempt: a test probe the UI tests read, not shown
                + "arrived \(probe.arrivedDrawn ? "drawn" : "loading"), \(probe.reports) reports after rest")
            .allowsHitTesting(false)
    }
}
