import Foundation

/// INF-5265, the captain's approved plan on INF-5264 (docs/ios.md, "Several computers"): the phone keeps every computer
/// it joined and shows one at a time. A computer is named by its pin, the key a home keeps through a move, so joining
/// one again replaces its record rather than adding a second.
public struct PhoneKeptMacs: Equatable, Sendable {
    /// The computer the phone shows, or none before the first join.
    public private(set) var shown: JoinedMac?
    /// The other kept computers, the one shown most recently first.
    public private(set) var others: [JoinedMac]

    public init(shown: JoinedMac? = nil, others: [JoinedMac] = []) {
        self.shown = shown
        // A record saved half way through a switch can list the shown computer among the others too: shown wins.
        var seen = Set(shown.map { [$0.pin] } ?? [])
        self.others = others.filter { seen.insert($0.pin).inserted }
    }

    /// Every kept computer, the shown one first.
    public var all: [JoinedMac] { (shown.map { [$0] } ?? []) + others }

    /// A computer the phone joined: it shows, the one shown before stays among the others, and a computer joined
    /// again takes the place of its old record.
    public mutating func joined(_ mac: JoinedMac) {
        let before = shown
        others.removeAll { $0.pin == mac.pin }
        shown = mac
        if let before, before.pin != mac.pin { others.insert(before, at: 0) }
    }

    /// Shows a kept computer; false when the phone keeps none with that pin.
    @discardableResult public mutating func show(_ pin: String) -> Bool {
        if shown?.pin == pin { return true }
        guard let index = others.firstIndex(where: { $0.pin == pin }) else { return false }
        let next = others.remove(at: index)
        if let shown { others.insert(shown, at: 0) }
        shown = next
        return true
    }

    /// The shown computer's newer record, such as its new addresses; any other record is left as it is.
    public mutating func update(_ mac: JoinedMac) {
        guard shown?.pin == mac.pin else { return }
        shown = mac
    }

    /// Forgets the shown computer: the kept computer shown most recently shows next, or none is left.
    public mutating func forgetShown() {
        shown = others.isEmpty ? nil : others.removeFirst()
    }

    /// Forgets one of the others, such as one whose record is damaged.
    public mutating func forget(other pin: String) {
        others.removeAll { $0.pin == pin }
    }
}

/// Where the kept computers live: the shown one in `JoinedMac.json`, as before, so an older build still opens the one
/// it showed, and the others beside it in `KeptMacs.json`. Both are readable after the first unlock and left out of
/// backups, as the one record was.
public struct PhoneKeptMacsFiles: Sendable {
    public let shownURL: URL
    public let othersURL: URL

    public init(folder: URL) {
        shownURL = folder.appendingPathComponent("JoinedMac.json")
        othersURL = folder.appendingPathComponent("KeptMacs.json")
    }

    /// The shown computer's record, or none before the first join.
    public func readShown() throws -> JoinedMac? {
        guard FileManager.default.fileExists(atPath: shownURL.path) else { return nil }
        return try JSONDecoder().decode(JoinedMac.self, from: Data(contentsOf: shownURL))
    }

    /// The other kept computers. A phone that saved one computer before has none, so it moves to the list with no
    /// new join.
    public func readOthers() throws -> [JoinedMac] {
        guard FileManager.default.fileExists(atPath: othersURL.path) else { return [] }
        return try JSONDecoder().decode([JoinedMac].self, from: Data(contentsOf: othersURL))
    }

    /// Writes the others first, then the shown one, so a write cut between them leaves the shown computer listed
    /// twice, which `PhoneKeptMacs` reads as shown, never a computer missing.
    public func save(_ kept: PhoneKeptMacs) throws {
        try FileManager.default.createDirectory(at: shownURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if kept.others.isEmpty { try remove(othersURL) } else { try write(JSONEncoder().encode(kept.others), to: othersURL) }
        if let shown = kept.shown { try write(JSONEncoder().encode(shown), to: shownURL) } else { try remove(shownURL) }
    }

    /// Removes the others' file alone, such as one that cannot be read.
    public func removeOthers() throws { try remove(othersURL) }

    private func write(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var url = url
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    private func remove(_ url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}
