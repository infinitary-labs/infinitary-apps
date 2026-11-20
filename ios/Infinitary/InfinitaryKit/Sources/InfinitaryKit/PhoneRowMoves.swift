import Foundation

/// INF-2928 piece 3: the Mac's moves on one task, as its task board offers them on a tile's menu and its Tasks panel on a
/// row at rest - `boardMenuOf`, `boardMoveOf`, `dropAskOf` (src/panels/now/boardMoves.ts), `rowStartOf` and
/// `rowControlsOf` (src/panels/now/rows.ts) - and the long press that offers both. Every move is one the record's own
/// rule allows (the row's `moves`), the host checks it again when it runs, and an entry that cannot run keeps the Mac's
/// reason. PhoneRowMovesTests replays the Mac's own readings, recorded by scripts/generate-phone-scene.ts.
public enum PhoneRowMoves {
    /// The board's lane a task's tile sits in: its Tasks group, Dropped for dropped work, or an earlier search match.
    public enum Lane: String, Sendable { case waiting, working, queued, backlog, landed, dropped, earlier }
    /// Where a move sends the task: a lane, or the Drop task tray.
    public enum Target: String, Sendable { case waiting, working, queued, backlog, landed, drop }

    /// What a move does: nothing, a refusal with its reason, a move written at once, a move that asks once, or the
    /// completion card brought forward.
    public enum Move: Equatable, Sendable {
        case none(String)
        case refused(String)
        case now(op: String, text: String, done: String)
        case ask(op: String, sentence: String, confirm: String)
        case card(cardID: String, text: String)
    }

    /// One entry of the menu: its name, what it does or why it cannot, and the move it makes. `rowStart` is the Tasks
    /// panel row's own Start, which the long press offers in the board's Start now's place.
    public struct Entry: Equatable, Sendable {
        public enum ID: String, Sendable { case open, card, pin, `continue`, queue, unqueue, start, drop, rowStart }
        public let id: ID
        public let label: String
        public let detail: String?
        public let disabled: Bool
        public let danger: Bool
        public let target: Target?
    }
    public enum Item: Equatable, Sendable {
        case entry(Entry), separator
        /// The entry's id; none for the line before Drop task.
        public var id: Entry.ID? { if case .entry(let entry) = self { entry.id } else { nil } }
    }

    /// The lane a task's own state puts it in (`boardLaneOf`); nil for a closed task that is not work.
    public static func lane(_ task: PhoneTask) -> Lane? {
        if task.status == "dropped" { return task.kind == "work" ? .dropped : nil }
        return task.group.flatMap { Lane(rawValue: $0.rawValue) }
    }

    /// Done and Dropped tiles never move.
    public static func movable(_ lane: Lane) -> Bool { lane != .landed && lane != .dropped }

    public static var openLabel: String { PhoneMessages.phoneRowMoveOpenRecord() }
    static var cardLabel: String { PhoneMessages.phoneRowMoveShowCard() }

    /// A row with no task behind it, only a card put aside (`isCardOnly`): nothing to open, move or pin.
    private static func cardOnly(_ task: PhoneTask) -> Bool { task.key.isEmpty && task.minimizedCardId != nil }
    private static var openEntry: Entry { Entry(id: .open, label: openLabel, detail: nil, disabled: false, danger: false, target: nil) }
    /// INF-3127: Pin keeps the task at the top of Tasks, whatever its state; Unpin lists it under its state again.
    private static func pinEntry(pinned: Bool) -> Entry {
        pinned ? Entry(id: .pin, label: PhoneRowMoveWords.unpin, detail: PhoneRowMoveWords.unpinDetail, disabled: false, danger: false, target: nil)
            : Entry(id: .pin, label: PhoneRowMoveWords.pin, detail: PhoneRowMoveWords.pinDetail, disabled: false, danger: false, target: nil)
    }

    /// "INF-3", "INF-3 and INF-4", "INF-3, INF-4 and INF-5".
    static func keyList(_ keys: [String]) -> String {
        guard keys.count > 1, let last = keys.last else { return keys.first ?? PhoneMessages.phoneRowMoveAnotherTask() }
        return PhoneMessages.phoneRowMoveKeyList(last: last, rest: keys.dropLast().joined(separator: ", "))
    }

    private static func blocked(_ task: PhoneTask) -> Bool { task.flags?.blocked == true || !task.blockedBy.isEmpty }
    private static func hasParts(_ task: PhoneTask) -> Bool { (task.children?.total ?? 0) > 0 }
    /// The task's completion card while it is up: its waiting card settles with a merge (`moveContextOf`).
    private static func completionCard(_ task: PhoneTask) -> String? {
        task.waitingCardMerges == true ? task.waitingCardId : nil
    }

    /// What moving `task`, in `from`, to `target` does (`boardMoveOf`).
    public static func move(_ task: PhoneTask, from: Lane, to target: Target) -> Move {
        let key = task.key
        if !movable(from) { return .refused(PhoneMessages.phoneRowMoveClosedStays()) }
        if target.rawValue == from.rawValue {
            return .none(PhoneMessages.phoneRowMoveAlreadyHere())
        }
        if target == .waiting { return .refused(PhoneMessages.phoneRowMoveWaitingNeedsDecision()) }
        if target == .drop { return dropMove(task) }
        if target == .landed {
            if let card = completionCard(task) {
                return .card(cardID: card, text: PhoneMessages.phoneRowMoveBringsMergeCard())
            }
            return .refused(PhoneMessages.phoneRowMoveNoMergeCard())
        }
        if from == .waiting {
            return .refused(task.waitingCardId != nil ? PhoneMessages.phoneRowMoveAnswerCardFirst()
                : PhoneMessages.phoneRowMoveWaitsForYou())
        }
        if from == .queued && PhoneTaskFacts.status(task).mark == "starting" { return .refused(PhoneMessages.phoneRowMoveIsStarting()) }
        if task.status == "active" { return startedMove(task, from: from, to: target) }
        if from == .working || !PhoneRecord.unstartedWork(task) { return .refused(PhoneMessages.phoneRowMoveAlreadyStarted()) }
        let waitsOn = keyList(task.blockedBy)
        if target == .backlog {
            return hasParts(task) ? .refused(PhoneMessages.phoneRowMovePartsMove())
                : .now(op: "unqueue-task", text: PhoneMessages.phoneRowMoveBacklogText(),
                       done: PhoneMessages.phoneRowMoveBacklogDone(key: key))
        }
        if target == .queued {
            if hasParts(task) { return .refused(PhoneMessages.phoneRowMovePartsQueue()) }
            if blocked(task) {
                return .now(op: "queue-task", text: PhoneMessages.phoneRowMoveQueuedBlockedText(waitsOn: waitsOn),
                            done: PhoneMessages.phoneRowMoveQueuedBlockedDone(key: key, waitsOn: waitsOn))
            }
            if task.flags?.held == true {
                return .now(op: "queue-task", text: PhoneMessages.phoneRowMoveQueuedHeldText(),
                            done: PhoneMessages.phoneRowMoveQueuedHeldDone(key: key))
            }
            return .ask(op: "queue-task", sentence: PhoneMessages.phoneRowMoveQueueAsk(key: key),
                        confirm: PhoneRowMoveWords.queue)
        }
        // Working: the record's Start.
        if blocked(task) {
            return .refused(PhoneMessages.phoneRowMoveMustFinishFirst(count: max(1, task.blockedBy.count), waitsOn: waitsOn))
        }
        if task.flags?.held == true { return .refused(PhoneMessages.phoneRowMoveHeldNoDrag()) }
        if hasParts(task) { return .refused(PhoneMessages.phoneRowMovePartsStart()) }
        if task.startPolicy == "when-ready" { return .refused(PhoneMessages.phoneRowMoveAlreadyQueued()) }
        return .ask(op: "start-task", sentence: PhoneMessages.phoneRowMoveStartAsk(key: key),
                    confirm: PhoneRowMoveWords.start)
    }

    /// Started work: Backlog stops its turn and keeps its work, at once; from the backlog, Working is Start, which asks
    /// once. Queued never takes started work.
    private static func startedMove(_ task: PhoneTask, from: Lane, to target: Target) -> Move {
        let key = task.key
        if target == .backlog {
            if let unqueue = task.moves?["unqueue-task"], !unqueue.ok { return .refused(unqueue.text ?? "") }
            return .now(op: "unqueue-task", text: PhoneRowMoveWords.startedBacklog,
                        done: PhoneMessages.phoneRowMoveStartedBacklogDone(key: key))
        }
        if target == .working && from == .backlog {
            return .ask(op: "start-task",
                        sentence: PhoneMessages.phoneRowMoveStartAgainAsk(key: key),
                        confirm: PhoneRowMoveWords.start)
        }
        return .refused(from == .backlog ? PhoneMessages.phoneRowMoveAlreadyStartedBacklog() : PhoneMessages.phoneRowMoveAlreadyStarted())
    }

    /// The Drop task tray: the record's own end, as the row says it - Drop task before the work starts, its stop once it
    /// has.
    private static func dropMove(_ task: PhoneTask) -> Move {
        if task.moves?["drop-task"]?.ok == true {
            return .ask(op: "drop-task", sentence: PhoneRecord.dropLead(task.key, started: false), confirm: PhoneRecordWords.dropTask)
        }
        if task.moves?["stop-task"]?.ok == true {
            return .ask(op: "stop-task", sentence: PhoneRecord.dropLead(task.key, started: true), confirm: PhoneRecordWords.dropTask)
        }
        return .refused(PhoneMessages.phoneRowMoveCannotDrop())
    }

    /// The record's own question for never-started work, from the effects its record lists (`dropAskOf`): the sentence,
    /// saying its open parts stay planned, and the review the host checks again, or that the record changed.
    public enum DropAsk: Equatable, Sendable {
        case ask(sentence: String, review: [String: [String]])
        case refused(String)
    }

    public static func dropAsk(_ key: String, effects: PhoneTask.DropEffects?) -> DropAsk {
        guard let effects else { return .refused(PhoneMessages.phoneRowMoveDropChanged(key: key)) }
        let sentence = [PhoneRecord.dropLead(key, started: false), PhoneRecord.dropParts(effects.parts),
                        PhoneRecord.dropWaiting(effects.waiting.map(\.key)),
                        PhoneRecord.dropUnderway(effects.underway.map(\.key))].compactMap(\.self).joined(separator: " ")
        return .ask(sentence: sentence, review: ["parts": effects.parts.map(\.key).sorted(),
                                                 "waiting": effects.waiting.map(\.key).sorted(),
                                                 "underway": effects.underway.map(\.key).sorted()])
    }

    /// The menu (`boardMenuOf`): Open record; Show the card while a decision waits; Continue on interrupted work; Queue it
    /// or Back to backlog and Start now on open work; Back to backlog on started work, and Start now on started work in the
    /// backlog; Pin or Unpin; then Drop task, last, in danger. An entry that cannot run stays, dim, with its reason. Done
    /// and Dropped rows have none.
    public static func menu(_ task: PhoneTask, lane: Lane) -> [Item] {
        if cardOnly(task) {
            return [.entry(Entry(id: .card, label: cardLabel, detail: nil, disabled: false, danger: false, target: nil))]
        }
        guard movable(lane) else { return [] }
        var items: [Item] = [.entry(openEntry)]
        if lane == .waiting && (task.waitingCardId != nil || task.minimizedCardId != nil) {
            items.append(.entry(Entry(id: .card, label: cardLabel, detail: nil, disabled: false, danger: false, target: nil)))
        }
        if lane == .working && PhoneTaskFacts.status(task).mark == "interrupted" {
            items.append(.entry(Entry(id: .continue, label: PhoneMessages.phoneCommonContinue(), detail: PhoneMessages.phoneRowMoveContinueDetail(),
                                      disabled: false, danger: false, target: nil)))
        }
        if lane == .working && task.status == "active" {
            let back = self.move(task, from: lane, to: .backlog)
            items.append(.entry(Entry(id: .unqueue, label: PhoneRowMoveWords.unqueue,
                                      detail: refusal(back) ?? PhoneMessages.phoneRowMoveStopDetail(),
                                      disabled: refusal(back) != nil, danger: false, target: .backlog)))
        }
        if lane == .backlog || lane == .queued {
            let target: Target = lane == .backlog ? .queued : .backlog
            let shift = self.move(task, from: lane, to: target)
            let detail: String = if let why = refusal(shift) { why }
                else if lane == .queued { PhoneMessages.phoneRowMoveUnqueueDetail() }
                else if case .ask = shift { PhoneMessages.phoneRowMoveQueueAskDetail() }
                else if blocked(task) { PhoneMessages.phoneRowMoveQueueBlockedDetail(waitsOn: keyList(task.blockedBy)) }
                else { PhoneMessages.phoneRowMoveQueueHeldDetail() }
            items.append(.entry(Entry(id: lane == .backlog ? .queue : .unqueue,
                                      label: lane == .backlog ? PhoneRowMoveWords.queue : PhoneRowMoveWords.unqueue,
                                      detail: detail, disabled: refusal(shift) != nil, danger: false, target: target)))
            let start = self.move(task, from: lane, to: .working)
            items.append(.entry(Entry(id: .start, label: PhoneRowMoveWords.startNow, detail: refusal(start) ?? PhoneMessages.phoneRowMoveStartDetail(),
                                      disabled: refusal(start) != nil, danger: false, target: .working)))
        }
        // INF-3127: after the moves, as on the Mac, so a move stays where it was in the menu.
        items.append(.entry(pinEntry(pinned: task.pinnedAt != nil)))
        let drop = self.move(task, from: lane, to: .drop)
        items.append(.separator)
        items.append(.entry(Entry(id: .drop, label: PhoneRecordWords.dropTask, detail: refusal(drop) ?? PhoneMessages.phoneRowMoveDropDetail(),
                                  disabled: refusal(drop) != nil, danger: true, target: .drop)))
        return items
    }

    private static func refusal(_ move: Move) -> String? { if case .refused(let why) = move { why } else { nil } }

    /// A backlog row's Start (`rowStartOf`): the record's own Start, Try again after a start that failed, and why it
    /// cannot start now; nil on a row with no moves.
    public struct Start: Equatable, Sendable {
        public let label: String
        public let reason: String?
    }

    public static func rowStart(_ task: PhoneTask) -> Start? {
        guard let allowance = task.moves?["start-task"] else { return nil }
        return Start(label: task.startNotice != nil ? PhoneTaskRowWords.tryAgain : PhoneTaskRowWords.start,
                     reason: allowance.ok ? nil : allowance.text)
    }

    /// What the Mac's Tasks panel shows on a row while the pointer rests on it (`rowControlsOf`): a backlog row's Start, a
    /// pinned task's too when it would list in the backlog, then Pin, or Unpin on a pinned task, on every row with a task
    /// behind it, whatever its state.
    public struct Controls: Equatable, Sendable {
        public enum Pin: String, Sendable { case pin, unpin }
        public let start: Start?
        public let pin: Pin?
    }

    /// `home` is the group the row lists under, or would list under when it is pinned (`PhoneTaskList.Part.home(of:)`).
    public static func rowControls(_ task: PhoneTask, home: PhoneTaskGroup?) -> Controls {
        Controls(start: home == .backlog ? rowStart(task) : nil,
                 pin: cardOnly(task) ? nil : task.pinnedAt == nil ? .pin : .unpin)
    }

    /// The long press, which stands in for resting the pointer on the Mac's row: the task board's menu for the row
    /// (`menu`), or Open record where the board has none, Done and Dropped among them, with every control the Tasks panel
    /// shows on that row (`rowControls`). The row's Start takes the board's Start now's place and runs as the row's does,
    /// at once and with no ask, and says so as the board's moves do; Pin or Unpin joins a menu that lacks it, before Drop task.
    public static func longPress(_ task: PhoneTask, lane: Lane?, controls: Controls) -> [Item] {
        var items = lane.map { menu(task, lane: $0) } ?? []
        if items.isEmpty { items = [.entry(openEntry)] }
        // The board keeps its moves before the line above Drop task.
        let moves = { items.firstIndex(of: .separator) ?? items.count }
        if let start = controls.start {
            let entry = Item.entry(Entry(id: .rowStart, label: start.label, detail: start.reason ?? PhoneMessages.phoneRowMoveRowStartDetail(),
                                         disabled: start.reason != nil, danger: false, target: nil))
            if let at = items.firstIndex(where: { $0.id == .start }) { items[at] = entry }
            else { items.insert(entry, at: items.firstIndex(where: { $0.id == .pin }) ?? moves()) }
        }
        if let pin = controls.pin, !items.contains(where: { $0.id == .pin }) {
            items.insert(.entry(pinEntry(pinned: pin == .unpin)), at: moves())
        }
        return items
    }
}
