import Foundation
import JavaScriptCore

/// The computer's own Settings rules and words, run on the phone (docs/ios.md, "Settings pages in the computer's
/// words"). The script is the code the computer's Settings runs, bundled by `scripts/generate-phone-settings.ts`:
/// the phone hands it what the computer answered and draws the rows it hands back, so no rule or sentence is written
/// a second time in Swift. JavaScriptCore runs it with no page, no network and no timers.
@MainActor public final class PhoneSettingsWords {
    private let context: JSContext
    private let function: JSValue

    /// Nil when the script does not load: every page then stays unread, and its row stays off Settings.
    public init?(script: String) {
        guard let context = JSContext() else { return nil }
        context.evaluateScript(script)
        guard context.exception == nil,
              let function = context.objectForKeyedSubscript("PhoneSettingsWords")?.objectForKeyedSubscript("page"),
              !function.isUndefined else { return nil }
        // Every page speaks the phone's language, as the rest of the phone does (docs/i18n.md, "On the phone").
        context.objectForKeyedSubscript("PhoneSettingsWords")?.objectForKeyedSubscript("language")?.call(withArguments: [PhoneWords.language])
        self.context = context
        self.function = function
    }

    /// One page from the computer's raw answers. A page the script cannot build throws, and the caller keeps the
    /// page it last drew.
    public func page<Page: Decodable>(_ name: String, _ input: [String: PhoneJSON], as: Page.Type = Page.self) throws -> Page {
        guard let json = String(data: try JSONEncoder().encode(input), encoding: .utf8) else { throw PhoneError.invalidReply }
        context.exception = nil
        guard let answer = function.call(withArguments: [name, json]), context.exception == nil, answer.isString,
              let text = answer.toString() else {
            context.exception = nil
            throw PhoneError.invalidReply
        }
        return try JSONDecoder().decode(Page.self, from: Data(text.utf8))
    }
}

/// A status dot's tone, as the computer names it (the design skill's StatusDot).
public enum PhoneDotTone: String, Decodable, Sendable {
    case ok, ring, warn, danger, idle, busy, captain
    public init(from decoder: Decoder) throws {
        self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .idle
    }
}

/// Settings → Intelligence as the script answers it: every account, grouped by the computer it is on.
public struct PhoneIntelligencePage: Decodable, Sendable, Equatable {
    public struct Meter: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String
        /// "74%", or "–" for a window that was not read.
        public let text: String
        /// The bar's fill, 0-100.
        public let fill: Double
        /// The design tokens the bar and the number take their colors from.
        public let bar: String
        public let figure: String
        /// Where the reset clock's marker sits, 0-100.
        public let clock: Double?
        public let stale: Bool
        public let reset: String?
    }
    public struct Verdict: Decodable, Sendable, Equatable {
        public let text: String
        public let tone: String
    }
    public struct StateLine: Decodable, Sendable, Equatable {
        public let text: String
        public let danger: Bool
    }
    public struct Row: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let provider: String
        public let name: String
        public let sub: String
        public let dot: PhoneDotTone
        public let dotLabel: String
        /// The marks beside its name, as the computer writes them.
        public let marks: [String]
        public let meters: [Meter]
        public let verdict: Verdict?
        public let state: StateLine?
        /// Where to sign in, on a row that waits for one.
        public let signIn: String?
    }
    public struct Group: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String?
        public let line: String?
        public let note: String?
        public let empty: String?
        public let rows: [Row]
    }
    public struct Mark: Decodable, Sendable, Equatable {
        public let mark: String
        public let words: String
    }
    public let summary: String
    public let asOf: String?
    public let groups: [Group]
    public let marks: [Mark]
    public let foot: String
}

/// What a rule's one button does: pause or resume it, or open a draft's review.
public struct PhoneRuleAction: Decodable, Sendable, Equatable {
    public let id: String
    public let label: String
}

/// Settings → Automation as the script answers it.
public struct PhoneAutomationPage: Decodable, Sendable, Equatable {
    public struct Rule: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let title: String
        public let tone: PhoneDotTone
        /// The schedule in a few words.
        public let when: String
        /// Its next run under its term, or its state alone when it has none.
        public let next: Next
        public let action: PhoneRuleAction?
    }
    public struct Next: Decodable, Sendable, Equatable {
        public let term: String?
        public let value: String
    }
    public struct PauseAll: Decodable, Sendable, Equatable {
        public let label: String
        public let ask: String
        public let enabled: Bool
    }
    public let summary: String
    public let lead: String
    public let unreadable: String?
    public let rules: [Rule]
    public let empty: String?
    public let pauseAll: PauseAll
    public let foot: String
}

/// One line of a page's facts: a term and its value, the prompt among them marked. `lines` holds a value that is a
/// list, drawn one entry a line.
public struct PhoneFact: Decodable, Sendable, Equatable, Identifiable {
    public let term: String
    public let value: String
    public let lines: [String]?
    public let prompt: Bool?
    public var id: String { term }
}

/// One automation's page as the script answers it.
public struct PhoneRulePage: Decodable, Sendable, Equatable, Identifiable {
    public struct Review: Decodable, Sendable, Equatable {
        public let title: String
        public let facts: [PhoneFact]
        public let turnOn: String
        public let back: String
        public let canTurnOn: Bool
        /// The save that turns the draft on, handed back to the computer as it came.
        public let save: PhoneJSON
    }
    public struct Run: Decodable, Sendable, Equatable, Identifiable {
        public let id: Int
        public let tone: PhoneDotTone
        public let state: String
        public let line: String
        public let note: String?
        public let led: [String]
        public let promptTitle: String
        public let prompt: String
    }
    public struct History: Decodable, Sendable, Equatable {
        public let title: String
        public let empty: String
        public let ledTo: String
        /// Whether the computer has answered this rule's runs: until then the page says nothing about them.
        public let read: Bool
        public let runs: [Run]
    }
    public let id: String
    public let title: String
    public let tone: PhoneDotTone
    public let state: String
    public let notes: [String]
    public let facts: [PhoneFact]
    public let action: PhoneRuleAction?
    public let review: Review?
    public let history: History
    public let foot: String
}

public struct PhoneChoice: Decodable, Sendable, Equatable, Identifiable {
    public let value: String
    public let label: String
    public var id: String { value }
}

/// Settings → Usage as the script answers it.
public struct PhoneUsagePage: Decodable, Sendable, Equatable {
    public struct Empty: Decodable, Sendable, Equatable {
        public let title: String
        public let line: String
    }
    public struct Readout: Decodable, Sendable, Equatable, Identifiable {
        public let label: String
        public let value: String
        public let note: String
        public var id: String { label }
    }
    public struct Bar: Decodable, Sendable, Equatable {
        public let date: String
        /// The day's share of the largest day, 0-1.
        public let share: Double
        public let value: String
    }
    public struct Daily: Decodable, Sendable, Equatable {
        public let title: String
        public let note: String
        public let first: String
        public let last: String
        public let peak: String
        public let bars: [Bar]
    }
    public struct Model: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let line: String
        public let value: String
    }
    public struct Models: Decodable, Sendable, Equatable {
        public let title: String
        public let rows: [Model]
    }
    public struct Place: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let value: String
        public let depth: Int
    }
    public struct Places: Decodable, Sendable, Equatable {
        public let title: String
        public let legend: String
        public let rows: [Place]
    }
    public struct Milestone: Decodable, Sendable, Equatable {
        public let title: String
        public let note: String
    }
    public let summary: String
    public let periods: [PhoneChoice]
    public let units: [PhoneChoice]
    public let period: String
    public let unit: String
    public let label: String
    public let empty: Empty?
    public let readouts: [Readout]
    public let daily: Daily
    public let models: Models
    public let `where`: Places
    public let milestone: Milestone
    public let foot: String
}

/// Settings → Projects as the script answers it.
public struct PhoneProjectsPage: Decodable, Sendable, Equatable {
    public struct Delivery: Decodable, Sendable, Equatable {
        public let title: String
        public let description: String
        public let fixed: String?
        public let value: String
        public let choices: [PhoneChoice]
    }
    public struct Asks: Decodable, Sendable, Equatable {
        public let title: String
        public let label: String
        public let description: String
        public let fixed: Bool
        public let asksFirst: Bool
    }
    public struct Rigor: Decodable, Sendable, Equatable {
        public let title: String
        public let description: String
        public let fixed: String?
        public let value: String
        public let choices: [PhoneChoice]
    }
    public struct Cost: Decodable, Sendable, Equatable {
        public let title: String
        public let description: String
        public let value: String
        public let choices: [PhoneChoice]
        public let usd: Double
        public let amountLabel: String
        public let save: String
    }
    public struct Note: Decodable, Sendable, Equatable {
        public let text: String
        public let warn: Bool
    }
    /// The project of several repositories a row is one of, named once above its rows.
    public struct Group: Decodable, Sendable, Equatable {
        public let id: String
        public let name: String
        public let line: String
    }
    public struct Project: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let group: Group?
        public let line: String
        public let path: String?
        public let personal: Bool
        public let delivery: Delivery
        public let asks: Asks
        public let rigor: Rigor
        public let cost: Cost?
        public let notes: [Note]
    }
    public let summary: String
    public let projects: [Project]
    public let empty: String?
    public let foot: String
}

/// Settings → Runbooks as the script answers it.
public struct PhoneRunbooksPage: Decodable, Sendable, Equatable {
    public struct Book: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let description: String
        public let enabled: Bool
        public let error: String?
    }
    public struct Group: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String
        public let empty: String?
        public let books: [Book]
    }
    public let summary: String
    public let lead: String
    public let groups: [Group]
    public let foot: String
}
