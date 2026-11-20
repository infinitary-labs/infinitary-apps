import Foundation

/// INF-4239 piece 4: Infinitary's own ask to keep a secret, typed on the phone (docs/secrets.md, "Asking to keep a
/// secret"; docs/ios.md, "Asking to keep a secret"). A host card's Keep in Secrets button carries the secrets it asks
/// for as its host effect's argument, as on the Mac (`secretKeepFields`); the phone draws one masked field each and
/// sends what was typed with that button's one-time pass in its own request, never as a card choice, so a value
/// never reaches a card answer, its thread or the task record.
public struct PhoneSecretAsk: Equatable, Sendable {
    public struct Field: Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let place: String?
    }

    /// The Keep in Secrets button's id, its one-time pass.
    public let pass: String
    public let fields: [Field]

    /// The ask a card carries, or nil: only an Infinitary card whose button names the secrets as the Mac reads them.
    public static func of(_ card: PhoneCard) -> PhoneSecretAsk? {
        guard card.author == "host" else { return nil }
        for action in card.actions where isKeep(action) {
            guard let pass = action["id"].text, let arg = action["effect"]["arg"].text,
                  let data = arg.data(using: .utf8), let offer = try? JSONDecoder().decode(PhoneJSON.self, from: data)
            else { return nil }
            let fields = offer["fields"].list.compactMap { field -> Field? in
                guard let id = field["id"].text, let name = field["name"].text else { return nil }
                return Field(id: id, name: name, place: field["place"].text)
            }
            return fields.isEmpty ? nil : PhoneSecretAsk(pass: pass, fields: fields)
        }
        return nil
    }

    /// Whether this button is an ask's Keep in Secrets, whose click sends the typed values, never a card choice.
    public static func isKeep(_ action: PhoneJSON) -> Bool {
        action["effect"]["kind"].text == "host" && action["effect"]["op"].text == "secrets-keep"
    }

    /// The result of one Keep, in the words the phone shows.
    public enum Outcome: Equatable {
        case kept, refused(String)
    }

    /// Sends one value per field with the pass. The home keeps each value straight in Secrets and zero-fills its copy;
    /// a Keep it cannot finish leaves the card up and says why. Nothing here keeps a value after the call.
    @MainActor public func keep(_ values: [String: String], home: some SecretsKeeping) async throws -> Outcome {
        let sent: [[String: String]] = fields.map { ["field": $0.id, "value": values[$0.id] ?? ""] }
        let answer = try await home.request(.secretKeep, args: [["pass": pass, "values": sent]], as: PhoneSecretKept.self)
        return answer.kept ? .kept : .refused(answer.words ?? PhoneMessages.phoneSecretsRefusedUnknown())
    }
}

/// The home's answer to a Keep (`inf:secrets:keep`): kept, or the words saying why not.
struct PhoneSecretKept: Decodable, Sendable { let kept: Bool; let words: String? }

/// What the phone's Keep asks of the home: the session to the joined computer. Tests give a stand-in home.
@MainActor public protocol SecretsKeeping: AnyObject {
    func request<T: Decodable & Sendable>(_ channel: PhoneRequest, args: [Any], as: T.Type) async throws -> T
}

extension ReadOnlySession: SecretsKeeping {}
