import Foundation

/// Taking back the newest message on the phone (INF-6763's plan, part 3; docs/ios.md, "Talk and tasks";
/// docs/task-capture.md, "Taking back a message"): which strip round the revert icon and Edit may name, and until when.
/// The computer checks again and refuses past the minute.
public enum PhoneTakeBack {
    /// The message's id while the revert icon and Edit stand beside it: a message (never a card round) the computer
    /// named, not taken back, accepted no longer ago than the window (`TAKE_BACK_WINDOW_MS`).
    public static func revertible(_ round: PhoneConversationRound, now: Date = Date()) -> String? {
        guard remaining(round, now: now) != nil else { return nil }
        return round.askId
    }

    /// How long until the round leaves the window; nil once it has or never could.
    public static func remaining(_ round: PhoneConversationRound, now: Date = Date()) -> Duration? {
        guard round.kind == .message, !round.takenBack, round.askId != nil, let sentAt = round.sentAt else { return nil }
        let left = sentAt + PhoneContract.takeBackWindowMs - now.timeIntervalSince1970 * 1000
        return left >= 0 ? .milliseconds(Int64(left.rounded(.up)) + 1) : nil
    }
}

/// The computer's answer to a take back (`takeBackResultSchema`): how far the message had got, or why it refused.
public struct PhoneTakeBackResult: Decodable, Sendable, Equatable {
    public let outcome: String
    public let reason: String?
    /// The message stands taken back: withdrawn, stopping or undoing, or refused because it already was.
    public var holds: Bool { outcome != "refused" || reason == "taken-back" }
}

extension PhoneLastTurn {
    /// The same last turn with the message `ask` marked taken back, wherever it stands.
    func marking(_ ask: String) -> PhoneLastTurn {
        var previous = self.previous
        if previous?.askId == ask { previous?.takenBack = true }
        var turn = PhoneLastTurn(you: you, reply: reply, previous: previous, askId: askId, sentAt: sentAt, takenBack: takenBack)
        if askId == ask { turn.takenBack = true }
        return turn
    }

    /// Whether the last turn holds the message `ask`, and whether taken back: nil when it holds neither round by that id.
    func takenBack(_ ask: String) -> Bool? {
        if askId == ask { return takenBack == true }
        if previous?.askId == ask { return previous?.takenBack == true }
        return nil
    }
}
