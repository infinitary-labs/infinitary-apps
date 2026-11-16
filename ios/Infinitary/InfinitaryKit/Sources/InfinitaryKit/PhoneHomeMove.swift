import Foundation

/// The phone's side of moving the first mate to another computer (docs/devices.md, "Moving the first mate";
/// `src/shared/homeMove.ts`): the home's number rides each welcome, a move sends `inf:home:moved` with the new
/// home's addresses, and a home with a lower number than one already heard is one a move left behind.
public enum PhoneHomeMove {
    /// The live frame a home sends every device as its move finishes.
    public static let movedChannel = "inf:home:moved"
    /// A home that never moved.
    public static let firstHomeNumber = 1

    /// The number a welcome names, a home that never moved when it names none.
    public static func number(inWelcome frame: [String: Any]) -> Int {
        (frame["homeNumber"] as? Int) ?? firstHomeNumber
    }

    /// Whether a welcome comes from a home this phone may follow: never one lower than the highest it heard.
    public static func accepts(welcome number: Int, known: Int?) -> Bool {
        number >= (known ?? firstHomeNumber)
    }

    /// The paired record after a welcome: the higher number kept, nothing else changed.
    public static func kept(_ mac: JoinedMac, welcome number: Int) -> JoinedMac? {
        guard number > (mac.homeNumber ?? firstHomeNumber) else { return nil }
        var next = mac; next.homeNumber = number
        return next
    }

    /// The paired record after a move's live frame: its number and the new home's addresses first, the old ones
    /// kept behind them. Nil when the frame is not a move to a higher number than this phone heard.
    public static func followed(_ mac: JoinedMac, payload: Any?) -> JoinedMac? {
        guard let moved = payload as? [String: Any],
              let number = moved["homeNumber"] as? Int, number > (mac.homeNumber ?? firstHomeNumber),
              let addresses = moved["addresses"] as? [String], !addresses.isEmpty
        else { return nil }
        let routes = PhoneAddresses.preferred(addresses)
        guard !routes.isEmpty else { return nil }
        var next = mac
        next.homeNumber = number
        next.addresses = Array((routes + mac.addresses.filter { !routes.contains($0) }).prefix(25))
        if let name = moved["name"] as? String, !name.isEmpty { next.name = name }
        return next
    }
}
