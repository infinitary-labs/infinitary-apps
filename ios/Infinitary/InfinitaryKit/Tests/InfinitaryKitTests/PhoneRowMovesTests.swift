import Foundation
import Testing
@testable import InfinitaryKit

/// INF-2928 piece 3 (the captain's "Every move the Mac allows on that row"): a long press on a Tasks row offers the Mac's
/// task board menu for that row with what its Tasks panel row shows at rest, and a swipe on a Backlog row the Mac's row
/// Start. These replay the desktop's own reading of one row in each state they read (`boardMenuOf`, `boardMoveOf`,
/// `rowStartOf`, `rowControlsOf`, `dropAskOf`), which scripts/generate-phone-scene.ts records, so the phone offers, refuses
/// and asks what the Mac does for the same row.
struct PhoneRowMovesTests {
    private struct Fixture: Decodable { let readings: [Reading]; let drops: [Drop] }
    private struct Reading: Decodable {
        let name: String
        let row: PhoneTask
        let lane: String
        let menu: [MenuItem]
        let moves: [String: Move]
        let rowStart: Start?
        /// Where the Mac's Tasks panel lists the row, its state's group for a pinned one, and what its row shows at rest.
        let group: String
        let home: String?
        let controls: Controls
    }
    private struct Controls: Decodable { let start: Start?; let pin: String? }
    private struct MenuItem: Decodable {
        let separator: Bool?
        let id: String?
        let label: String?
        let detail: String?
        let disabled: Bool?
        let danger: Bool?
        let target: String?
    }
    private struct Move: Decodable {
        let kind: String
        let text: String?
        let op: String?
        let done: String?
        let sentence: String?
        let confirm: String?
        let cardId: String?
    }
    private struct Start: Decodable { let label: String; let reason: String? }
    private struct Drop: Decodable {
        let name: String
        let key: String
        let effects: PhoneTask.DropEffects?
        let ask: DropAsk
    }
    private struct DropAsk: Decodable { let kind: String; let text: String?; let sentence: String?; let review: [String: [String]]? }

    private func fixtureData() throws -> Data {
        let url = try #require(Bundle.module.url(forResource: "PhoneRowMoves.generated", withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    private func fixture() throws -> Fixture { try JSONDecoder().decode(Fixture.self, from: fixtureData()) }

    /// A phone move in the Mac's shape, so the two compare field by field.
    private func shape(_ move: PhoneRowMoves.Move) -> [String: String] {
        switch move {
        case .none(let text): ["kind": "none", "text": text]
        case .refused(let text): ["kind": "refused", "text": text]
        case .now(let op, let text, let done): ["kind": "now", "op": op, "text": text, "done": done]
        case .ask(let op, let sentence, let confirm): ["kind": "ask", "op": op, "sentence": sentence, "confirm": confirm]
        case .card(let card, let text): ["kind": "card", "cardId": card, "text": text]
        }
    }

    private func shape(_ move: Move) -> [String: String] {
        let fields: [String: String?] = ["kind": move.kind, "text": move.text, "op": move.op, "done": move.done,
                                         "sentence": move.sentence, "confirm": move.confirm, "cardId": move.cardId]
        return fields.compactMapValues(\.self)
    }

    @Test func eachRowOffersTheMacsMoves() throws {
        let recorded = try fixture()
        #expect(recorded.readings.count > 20)
        for reading in recorded.readings {
            let name = reading.name
            let lane = try #require(reading.lane == "earlier" ? .earlier : PhoneRowMoves.lane(reading.row), "\(name): its lane")
            #expect(lane.rawValue == reading.lane, "\(name): the lane")
            let menu = PhoneRowMoves.menu(reading.row, lane: lane)
            #expect(menu.count == reading.menu.count, "\(name): the menu's entries")
            for (item, want) in zip(menu, reading.menu) {
                switch item {
                case .separator: #expect(want.separator == true, "\(name): a line before Drop task")
                case .entry(let entry):
                    #expect(entry.id.rawValue == want.id, "\(name): the entry")
                    #expect(entry.label == want.label, "\(name): \(entry.id) is named")
                    #expect(entry.detail == want.detail, "\(name): what \(entry.label) does, or why it cannot")
                    #expect(entry.disabled == (want.disabled ?? false), "\(name): whether \(entry.label) can run")
                    #expect(entry.danger == (want.danger ?? false), "\(name): \(entry.label)'s tone")
                    #expect(entry.target?.rawValue == want.target, "\(name): where \(entry.label) moves it")
                }
            }
            for (target, want) in reading.moves {
                let move = PhoneRowMoves.move(reading.row, from: lane, to: try #require(PhoneRowMoves.Target(rawValue: target)))
                #expect(shape(move) == shape(want), "\(name): moving it to \(target)")
            }
            let start = PhoneRowMoves.rowStart(reading.row)
            #expect(start?.label == reading.rowStart?.label, "\(name): the row's Start")
            #expect(start?.reason == reading.rowStart?.reason, "\(name): why the row's Start cannot start")
        }
    }

    /// The captain's "long press on a task row in the ios app should at least give all the actions i can take when hovering
    /// the same task row in desktop app tasks panel": in every state, the phone reads what the Mac's Tasks panel row shows at
    /// rest where it lists (`rowControlsOf`), and the long press offers each of it as that row does, keeps Open record on
    /// every row with a task, and keeps every other move the board's menu offers.
    @Test func theLongPressOffersWhatTheMacsRowShowsAtRest() throws {
        let recorded = try fixture()
        // A control the Mac's row gains must reach the long press too, so the phone knows every kind the Mac records.
        let raw = try #require(try JSONSerialization.jsonObject(with: fixtureData()) as? [String: Any])
        for reading in try #require(raw["readings"] as? [[String: Any]]) {
            let kinds = Set(try #require(reading["controls"] as? [String: Any]).keys)
            #expect(kinds == ["start", "pin"], "\(reading["name"] ?? ""): the Mac's row shows only what the long press offers")
        }
        #expect(recorded.readings.contains { $0.menu.isEmpty && $0.controls.pin == "unpin" }, "A pinned Done or Dropped row is read")
        for reading in recorded.readings {
            let name = reading.name
            // Where the row lists on the phone: its group, or its state's group under Pinned (`Part.home(of:)`).
            let home = PhoneTaskGroup(rawValue: reading.group == "pinned" ? reading.home ?? "" : reading.group)
            let controls = PhoneRowMoves.rowControls(reading.row, home: home)
            #expect(controls.start?.label == reading.controls.start?.label, "\(name): the row's Start")
            #expect(controls.start?.reason == reading.controls.start?.reason, "\(name): why the row's Start cannot start")
            #expect(controls.pin?.rawValue == reading.controls.pin, "\(name): the row's pin")
            let lane = reading.lane == "earlier" ? .earlier : PhoneRowMoves.lane(reading.row)
            let press = PhoneRowMoves.longPress(reading.row, lane: lane, controls: controls)
            let entries = press.compactMap { item -> PhoneRowMoves.Entry? in if case .entry(let entry) = item { entry } else { nil } }
            #expect(entries.first?.id == .open && entries.first?.label == PhoneRowMoves.openLabel, "\(name): Open record comes first")
            if let start = reading.controls.start {
                let entry = try #require(entries.first { $0.id == .rowStart }, "\(name): the row's Start")
                #expect(entry.label == start.label, "\(name): Start, or Try again after a start that failed")
                #expect(entry.disabled == (start.reason != nil), "\(name): dim exactly when the Mac's row says it cannot start")
                #expect(entry.detail == (start.reason ?? PhoneMessages.phoneRowMoveRowStartDetail()),
                        "\(name): the Mac's reason, or that it starts at once as the board's moves say")
                #expect(!entries.contains { $0.id == .start }, "\(name): one Start, the row's, in Start now's place")
            } else {
                #expect(!entries.contains { $0.id == .rowStart }, "\(name): the Mac's row shows no Start")
            }
            let pins = entries.filter { $0.id == .pin }
            switch reading.controls.pin {
            case "pin": #expect(pins.map(\.label) == [PhoneRowMoveWords.pin], "\(name): Pin, once")
            case "unpin": #expect(pins.map(\.label) == [PhoneRowMoveWords.unpin], "\(name): Unpin, once")
            default: #expect(pins.isEmpty, "\(name): nothing to pin")
            }
            // Every other move of the board's menu stays as it was, in its order, and nothing else joins.
            let board = reading.menu.compactMap { $0.id == "start" && reading.controls.start != nil ? nil : $0.id }
            let added: Set<PhoneRowMoves.Entry.ID> = [.open, .rowStart, .pin]
            #expect(entries.map(\.id.rawValue).filter { board.contains($0) } == board, "\(name): the board's moves, in order")
            #expect(entries.allSatisfy { board.contains($0.id.rawValue) || added.contains($0.id) }, "\(name): nothing else")
            #expect(press.filter { $0 == .separator }.count == reading.menu.filter { $0.separator == true }.count,
                    "\(name): the line before Drop task")
        }
    }

    @Test func dropTaskAsksInTheRecordsWords() throws {
        let recorded = try fixture()
        #expect(recorded.drops.count > 4)
        for drop in recorded.drops {
            switch PhoneRowMoves.dropAsk(drop.key, effects: drop.effects) {
            case .ask(let sentence, let review):
                #expect(drop.ask.kind == "ask", "\(drop.name): it asks")
                #expect(sentence == drop.ask.sentence, "\(drop.name): the question")
                #expect(review == drop.ask.review, "\(drop.name): the review the host checks again")
            case .refused(let text):
                #expect(drop.ask.kind == "refused", "\(drop.name): it refuses")
                #expect(text == drop.ask.text, "\(drop.name): why it cannot be dropped")
            }
        }
    }
}
