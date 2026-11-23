import Foundation

/// The captain's Approve and build on comfortable Apple Pencil input: writing at the iPad's foot leaves the palm off the
/// glass, so with a Pencil in hand the message box moves under the top bar with four lines of room. Move the message box
/// for Apple Pencil, under Settings → Appearance, is this device's own off switch, on by default, saved beside its Theme
/// and never sent to the computer or another device, so a phone joined to the same computer keeps its box at the foot.
/// Whether this device has seen a Pencil is saved too, so the switch shows only on an iPad that has met one.
public enum PhonePencilTop {
    static let key = "phone-pencil-top"
    static let seenKey = "phone-pencil-seen"

    public static func saved(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key) as? Bool ?? true
    }

    public static func save(_ top: Bool, in defaults: UserDefaults = .standard) {
        defaults.set(top, forKey: key)
    }

    public static func pencilSeen(in defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: seenKey)
    }

    public static func savePencilSeen(in defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: seenKey)
    }
}

/// Where the message box stands with a Pencil about, by the plan's move rule. A Pencil touch or hover anywhere wants the
/// top; focus a finger, trackpad or hardware key gives a text field wants the foot at once. Nothing moves while a field
/// holds focus or while the Pencil writes on a field, as Apple asks of Scribble: the wanted place waits until it lets go.
/// It is held only while Infinitary runs, never saved.
public struct PhonePencilPlacement: Equatable, Sendable {
    public enum Input: Sendable { case pencil, other }

    /// Whether the message box stands at the top now.
    public private(set) var top = false
    /// Where the latest signal wants it.
    public private(set) var wanted = false
    /// The text field holding focus now, and what gave it focus.
    public private(set) var focus: Input?
    /// The Pencil came down on a text field, where Scribble writes before the field takes focus.
    public private(set) var writingOnField = false

    public init() {}

    /// A Pencil touched or hovered anywhere in the window; `onField` when it came down on a text field.
    public mutating func pencil(onField: Bool = false) {
        wanted = true
        writingOnField = onField
        settle()
    }

    /// A text field took focus, from the Pencil or from a finger, trackpad or key. Any but the Pencil puts the box back
    /// at the foot, and the box keeps its place while the field holds focus.
    public mutating func focused(by input: Input) {
        focus = input
        writingOnField = false
        if input == .other { wanted = false; top = false }
    }

    /// No text field holds focus any longer, so a waiting move applies.
    public mutating func unfocused() {
        focus = nil
        writingOnField = false
        settle()
    }

    /// iPadOS's own reading of whether Pencil input is expected, at launch and on each return to the foreground.
    public mutating func expected(_ expected: Bool) {
        wanted = expected
        settle()
    }

    private mutating func settle() {
        if focus == nil && !writingOnField { top = wanted }
    }
}
