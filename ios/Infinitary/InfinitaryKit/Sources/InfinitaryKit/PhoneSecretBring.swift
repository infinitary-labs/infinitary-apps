import Foundation

/// Infinitary's own bring card, answered on the phone (docs/secrets.md, "Bringing secrets from another tool"; docs/ios.md,
/// "Bringing secrets from another tool"). A host card's Bring into Secrets button carries the rows it offers as its host
/// effect's argument, as the Mac reads them (`secretBringRows`, src/shared/secretBring.ts); the phone draws one tick box
/// each and sends only the button's one-time pass and the ticked rows' ids in their own request, never as a card choice.
/// No value is ever on the phone: Infinitary runs or reads the source itself on the computer the card names.
public struct PhoneSecretBring: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public let id: String
        /// The name Secrets keeps it under.
        public let name: String
        public let place: String?
        /// The version of the kept secret it would replace: such a row arrives unticked.
        public let replaces: Int?
        /// Whether the offer ticks it at first.
        public let ticked: Bool
        /// Why the source's value cannot be kept: such a row cannot be ticked.
        public let cannot: Cannot?

        public enum Cannot: String, Sendable { case empty, tooLarge = "too-large", notText = "not-text" }

        public init(id: String, name: String, place: String? = nil, replaces: Int? = nil, ticked: Bool, cannot: Cannot? = nil) {
            self.id = id
            self.name = name
            self.place = place
            self.replaces = replaces
            self.ticked = ticked
            self.cannot = cannot
        }

        /// The line under its name, in the Mac's words: why it cannot be kept, else the version it would replace.
        public var note: String? {
            switch cannot {
            case .empty: return PhoneMessages.secretsBringCannotEmpty()
            case .tooLarge: return PhoneMessages.secretsBringCannotTooLarge()
            case .notText: return PhoneMessages.secretsBringCannotNotText()
            case nil: return replaces.map { PhoneMessages.secretsBringReplaces(version: PhoneFormats.whole($0, locale: PhoneFormats.locale)) }
            }
        }
    }

    /// The Bring into Secrets button's id, its one-time pass.
    public let pass: String
    public let rows: [Row]

    /// The rows ticked when the card arrives: the offer's ticks, never one that cannot be kept.
    public var ticked: Set<String> { Set(rows.filter { $0.ticked && $0.cannot == nil }.map(\.id)) }

    /// The bring a card offers, or nil: only an Infinitary card whose Bring button names its rows as the Mac reads them.
    public static func of(_ card: PhoneCard) -> PhoneSecretBring? {
        guard card.author == "host" else { return nil }
        for action in card.actions where isBring(action) {
            guard let pass = action["id"].text, let arg = action["effect"]["arg"].text,
                  let data = arg.data(using: .utf8), let offer = try? JSONDecoder().decode(PhoneJSON.self, from: data)
            else { return nil }
            var rows: [Row] = []
            for row in offer["rows"].list {
                guard let id = row["id"].text, let name = row["name"].text, case .bool(let ticked) = row["ticked"] else { return nil }
                var cannot: Row.Cannot?
                if let named = row["cannot"].text {
                    guard let known = Row.Cannot(rawValue: named) else { return nil }
                    cannot = known
                }
                rows.append(Row(id: id, name: name, place: row["place"].text.flatMap { $0.isEmpty ? nil : $0 },
                                replaces: row["replaces"]["version"].numeric.map { Int($0) }, ticked: ticked, cannot: cannot))
            }
            return rows.isEmpty ? nil : PhoneSecretBring(pass: pass, rows: rows)
        }
        return nil
    }

    /// Whether this button is a bring's Bring into Secrets, whose click sends the ticked rows, never a card choice.
    public static func isBring(_ action: PhoneJSON) -> Bool {
        action["effect"]["kind"].text == "host" && action["effect"]["op"].text == "secrets-bring"
    }

    /// Whether this button is a bring card's Don't bring or Read it: one-time choices (`secrets-decision`) that hand
    /// nothing out, so the phone sends them as any other choice, unlike the confirmations other Secrets cards ask.
    public static func isDecision(_ action: PhoneJSON, on card: PhoneCard) -> Bool {
        card.author == "host" && card.id.hasPrefix(PhoneContract.secretBringCardPrefix)
            && action["effect"]["kind"].text == "host" && action["effect"]["op"].text == "secrets-decision"
    }

    /// The result of one Bring, in the words the phone shows.
    public enum Outcome: Equatable {
        case brought, refused(String)
    }

    /// Sends the pass and the ids of the ticked rows, in the offer's order and only rows that can be kept. The home runs
    /// or reads the source and keeps only those; a Bring it cannot finish leaves the card up and says why.
    @MainActor public func bring(_ picked: Set<String>, home: some SecretsKeeping) async throws -> Outcome {
        let sent = rows.filter { picked.contains($0.id) && $0.cannot == nil }.map(\.id)
        let answer = try await home.request(.secretBring, args: [["pass": pass, "picked": sent]], as: PhoneSecretBrought.self)
        return answer.brought ? .brought : .refused(answer.words ?? PhoneMessages.phoneSecretsRefusedUnknown())
    }
}

/// The home's answer to a Bring (`inf:secrets:bring`): brought, or the words saying why not.
struct PhoneSecretBrought: Decodable, Sendable { let brought: Bool; let words: String? }
