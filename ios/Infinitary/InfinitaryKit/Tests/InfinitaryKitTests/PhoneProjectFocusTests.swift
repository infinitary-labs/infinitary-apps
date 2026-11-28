import Foundation
import Testing
@testable import InfinitaryKit

/// INF-2820 piece 2, the captain's approved plan: the phone's Filter offers the projects, counts and tail a Mac window's
/// focus does. These replay the desktop's own reading of one board (`projectPillsOf`, `pillShown`, `heldFocus`,
/// `waitingElsewhere`, `linesInFocus`, and piece 3's `holdsBack`), which scripts/generate-phone-scene.ts records.
struct PhoneProjectFocusTests {
    private struct Fixture: Decodable {
        let board: PhoneBoard
        let one: PhoneBoard
        let lines: [Line]
        let pills: Pills
        let shown: Bool
        let oneShown: Bool
        let held: [Held]
        let elsewhere: [Elsewhere]
        let kept: [Kept]
        let cards: [PhoneCard]
        let holds: [Holds]
    }
    private struct Line: Decodable { let kind: String; let taskKey: String?; let text: String; let at: Double }
    private struct Pills: Decodable { let projects: [Pill]; let waiting: Int; let working: Int }
    private struct Pill: Decodable { let id: String; let key: String; let name: String; let waiting: Int; let working: Int }
    private struct Held: Decodable { let saved: String?; let held: String?; let oneHeld: String? }
    private struct Elsewhere: Decodable { let focus: String?; let waiting: Int }
    private struct Kept: Decodable { let focus: String?; let lines: [String] }
    private struct Holds: Decodable { let focus: String?; let held: [String]; let beforeBoard: [String] }

    private func fixture() throws -> Fixture {
        let url = try #require(Bundle.module.url(forResource: "PhoneProjectFocus.generated", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    @Test func theFilterOffersTheMacsProjects() throws {
        let mac = try fixture()
        let pills = PhoneProjectFocus.pills(mac.board)
        #expect(pills.projects == mac.pills.projects.map {
            PhoneProjectFocus.Pill(id: $0.id, key: $0.key, name: $0.name, waiting: $0.waiting, working: $0.working)
        })
        #expect(pills.waiting == mac.pills.waiting)
        #expect(pills.working == mac.pills.working)
        #expect(pills.shown == mac.shown)
        #expect(PhoneProjectFocus.pills(mac.one).shown == mac.oneShown)
    }

    @Test func aSavedFocusHoldsAsTheMacsDoes() throws {
        let mac = try fixture()
        for reading in mac.held {
            #expect(PhoneProjectFocus.held(reading.saved, board: mac.board) == reading.held, "\(reading.saved ?? "none")")
            #expect(PhoneProjectFocus.held(reading.saved, board: mac.one) == reading.oneHeld, "\(reading.saved ?? "none") on one project")
        }
        // Before the first board read the saved focus holds, so a relaunch opens on it (the plan's "Saved focus").
        #expect(PhoneProjectFocus.held("p-gone", board: nil) == "p-gone")
    }

    @Test func theTailCountsWaitingElsewhere() throws {
        let mac = try fixture()
        let pills = PhoneProjectFocus.pills(mac.board)
        for reading in mac.elsewhere {
            #expect(PhoneProjectFocus.waitingElsewhere(pills, focus: reading.focus) == reading.waiting, "\(reading.focus ?? "none")")
        }
    }

    @Test func activityKeepsTheMacsLines() throws {
        let mac = try fixture()
        let lines = mac.lines.map { ActivityLine(kind: $0.kind, taskKey: $0.taskKey, text: $0.text, at: $0.at) }
        for reading in mac.kept {
            let key = PhoneProjectFocus.key(reading.focus, board: mac.board)
            #expect(PhoneProjectFocus.lines(lines, key: key).map(\.text) == reading.lines, "\(reading.focus ?? "none")")
        }
    }

    /// INF-2820 piece 3, the captain's "Held back until you pick their project or All projects, as on your Mac".
    @Test func theFocusHoldsBackTheMacsCards() throws {
        let mac = try fixture()
        for reading in mac.holds {
            let held = mac.cards.filter { PhoneProjectFocus.holdsBack($0, focus: reading.focus, board: mac.board) }.map(\.id)
            #expect(held == reading.held, "\(reading.focus ?? "none")")
            let before = mac.cards.filter { PhoneProjectFocus.holdsBack($0, focus: reading.focus, board: nil) }.map(\.id)
            #expect(before == reading.beforeBoard, "\(reading.focus ?? "none") before the board is read")
        }
    }

    /// INF-2820 piece 3: Home keeps the stack's order less the held cards; a card pointed at comes forward under the focus
    /// it was pointed under, and a pick of another focus holds it again.
    @Test func homeLetsAPointedCardThroughUntilTheFocusChanges() throws {
        let mac = try fixture()
        func shown(_ focus: String?, _ through: PhoneProjectFocus.LetThrough) -> [String] {
            PhoneProjectFocus.shown(mac.cards, focus: focus, board: mac.board, letThrough: through).map(\.id)
        }
        var through = PhoneProjectFocus.LetThrough()
        #expect(shown("p-inf", through) == ["card-1", "card-fm", "card-99"])
        #expect(shown(nil, through) == mac.cards.map(\.id), "All projects shows every card")
        through.point(at: "card-5", under: "p-inf")
        #expect(shown("p-inf", through) == ["card-1", "card-5", "card-fm", "card-99"], "The pointed card comes back in its place")
        #expect(shown("p-har", through) == ["card-5", "card-fm", "card-6", "card-99"], "Under another focus it lets nothing through")
        through.point(at: "card-1", under: "p-har")
        through.point(at: "card-6", under: "p-inf")
        #expect(shown("p-inf", through) == ["card-1", "card-fm", "card-6", "card-99"],
                "Back on p-inf, card-5 pointed at before p-har is held again")
        through.point(at: "card-7", under: nil)
        #expect(!through.lets("card-7", under: nil), "At All projects nothing needs letting through")
    }

    @Test func eachComputerKeepsItsOwnFocus() throws {
        let defaults = try #require(UserDefaults(suiteName: "PhoneProjectFocusTests"))
        defaults.removePersistentDomain(forName: "PhoneProjectFocusTests")
        PhoneProjectFocus.save("p-har", computer: "pin-a", in: defaults)
        PhoneProjectFocus.save("p-inf", computer: "pin-b", in: defaults)
        #expect(PhoneProjectFocus.saved(computer: "pin-a", in: defaults) == "p-har")
        #expect(PhoneProjectFocus.saved(computer: "pin-b", in: defaults) == "p-inf")
        PhoneProjectFocus.save(nil, computer: "pin-a", in: defaults)
        #expect(PhoneProjectFocus.saved(computer: "pin-a", in: defaults) == nil)
        #expect(PhoneProjectFocus.saved(computer: "pin-b", in: defaults) == "p-inf")
        defaults.removePersistentDomain(forName: "PhoneProjectFocusTests")
    }
}
