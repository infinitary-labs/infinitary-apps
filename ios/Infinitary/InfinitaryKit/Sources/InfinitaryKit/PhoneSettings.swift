import Foundation
import Observation

/// The phone's Settings pages over the computer's own Settings (docs/ios.md, "Settings pages in the computer's
/// words"): Intelligence, Automation, Usage, Projects and Runbooks. Each page reads what the computer's page reads,
/// hands it to the computer's own row rules (`PhoneSettingsWords`) and keeps the rows they answer. A page the
/// computer does not answer stays nil and its row stays off Settings; out of reach, the last reading stays. What a
/// page changes goes through the computer's existing actions, and signing in stays on the computer.
@MainActor @Observable public final class PhoneSettings {
    public enum Section: String, CaseIterable, Sendable { case intelligence, automation, usage, projects, runbooks }

    public private(set) var intelligence: PhoneIntelligencePage?
    public private(set) var automation: PhoneAutomationPage?
    public private(set) var usage: PhoneUsagePage?
    public private(set) var projects: PhoneProjectsPage?
    public private(set) var runbooks: PhoneRunbooksPage?
    /// The automation whose page is open.
    public private(set) var rule: PhoneRulePage?
    /// Whether every page has been asked for once, so Settings can show its rows together.
    public private(set) var read = false
    /// What is changing now, by its row's id: that row's control waits for the computer's answer.
    public private(set) var changing: Set<String> = []
    /// Why the last change did not go through, in the computer's words.
    public var problem: String?

    @ObservationIgnored private let session: ReadOnlySession
    @ObservationIgnored private let words: PhoneSettingsWords?
    /// The computer's answers as they came, by what was asked: the script reads them, never this phone.
    @ObservationIgnored private var answers: [Reading: PhoneJSON] = [:]
    @ObservationIgnored private var usagePeriod: String
    @ObservationIgnored private var usageUnit: String
    @ObservationIgnored private var ruleID: String?
    @ObservationIgnored private var ruleAnswers: (id: String, dates: PhoneJSON, runs: PhoneJSON)?
    /// Whether the last `keep` stopped because the computer was out of reach, which keeps the page as last read.
    @ObservationIgnored private var away = false

    private enum Reading: Hashable {
        case accounts, quota, providers, flagship, devices, automations, names, summary, repos, folder, books, integrations
    }
    private enum Answer { case value(PhoneJSON), away, refused }

    /// The period and unit Usage opens on are the computer's own defaults, which the script names on its first page.
    public init(session: ReadOnlySession, script: String?, period: String = "30d", unit: String = "tokens") {
        self.session = session
        words = script.flatMap { PhoneSettingsWords(script: $0) }
        usagePeriod = period
        usageUnit = unit
    }

    public var canChange: Bool { session.canChange }

    /// Every page again, for the Settings list's one-line summaries.
    public func refresh() async {
        async let first: Void = refresh(.intelligence)
        async let second: Void = refresh(.automation)
        async let third: Void = refresh(.usage)
        async let fourth: Void = refresh(.projects)
        async let fifth: Void = refresh(.runbooks)
        _ = await (first, second, third, fourth, fifth)
        read = true
    }

    public func refresh(_ section: Section) async {
        switch section {
        case .intelligence: await readIntelligence()
        case .automation: await readAutomation()
        case .usage: await readUsage()
        case .projects: await readProjects()
        case .runbooks: await readRunbooks()
        }
    }

    // MARK: - Intelligence

    private func readIntelligence() async {
        async let accounts = ask(.accounts), quota = ask(.quota), providers = ask(.providers), flagship = ask(.firstmateAccount)
        let devices = await readDevices()
        let own = [(Reading.accounts, await accounts), (.quota, await quota), (.providers, await providers)]
        let first = await flagship
        guard keep(own) else {
            if !away { intelligence = nil }
            return
        }
        take(.flagship, first, otherwise: .null)
        take(.devices, devices, otherwise: .null)
        buildIntelligence()
    }

    private func buildIntelligence() {
        guard let accounts = answers[.accounts], let quota = answers[.quota], let providers = answers[.providers] else { return }
        intelligence = page("intelligence", [
            "accounts": accounts, "snapshot": quota, "providers": providers,
            "devices": .array(answers[.devices]?.list ?? []), "firstmateAccount": answers[.flagship] ?? .null,
            "home": .string(session.mac.name), "now": .number(Date().timeIntervalSince1970 * 1000),
        ], keeping: intelligence)
    }

    /// The other computers that run work and their sign-ins, or null where the computer offers no Devices.
    private func readDevices() async -> Answer {
        switch await ask(.devicesShown) {
        case .value(let shown): shown["shown"].flag ? await ask(.deviceSignIns) : .value(.null)
        case .away: .away
        case .refused: .refused
        }
    }

    // MARK: - Automation

    private func readAutomation() async {
        // The projects a rule names come with the list, so a rule's page names its project as it opens.
        async let list = ask(.automations), names = ask(.automationProjects)
        let read = (await list, await names)
        guard keep([(.automations, read.0)]) else {
            if !away { automation = nil; rule = nil }
            return
        }
        take(.names, read.1, otherwise: .array([]))
        buildAutomation()
        if let ruleID { await readRule(ruleID) }
    }

    private func buildAutomation() {
        guard let list = answers[.automations] else { return }
        automation = page("automation", ["list": list, "home": .string(session.mac.name)], keeping: automation)
        buildRule()
    }

    /// Opens one automation's page with what the list already says; reading Automation again adds what needs its
    /// next dates and its runs, so the page fills in and never says something it then takes back.
    public func openRule(_ id: String) {
        ruleID = id
        rule = nil
        ruleAnswers = nil
        buildRule()
    }

    public func closeRule() { ruleID = nil; rule = nil; ruleAnswers = nil }

    private func readRule(_ id: String) async {
        guard let saved = savedRule(id) else { return }
        async let dates = ask(.automationPreview, [(try? saved["spec"].foundation) ?? [:]])
        async let runs = ask(.automationHistory, [id])
        // Only a rule that listens to an integration names one.
        let integrations: Answer = saved["spec"]["kind"].text == "event" ? await ask(.integrations) : .value(.null)
        let read = (await dates, await runs)
        guard ruleID == id else { return }
        var held = ruleAnswers?.id == id ? ruleAnswers! : (id: id, dates: PhoneJSON.null, runs: PhoneJSON.null)
        if case .value(let value) = read.0 { held.dates = value["dates"] }
        if case .value(let value) = read.1 { held.runs = value }
        ruleAnswers = held
        take(.integrations, integrations, otherwise: .null)
        buildRule()
    }

    private func savedRule(_ id: String) -> PhoneJSON? {
        answers[.automations]?["rules"].list.first { $0["id"].text == id }
    }

    private func buildRule() {
        guard let ruleID else { return }
        // A rule deleted on the computer leaves its page.
        guard let saved = savedRule(ruleID) else { rule = nil; return }
        let held = ruleAnswers?.id == ruleID ? ruleAnswers : nil
        rule = page("automationRule", [
            "rule": saved, "dates": held?.dates ?? .null, "runs": held?.runs ?? .null,
            "projects": answers[.names] ?? .array([]), "integrations": answers[.integrations] ?? .null,
            "home": .string(session.mac.name), "now": .number(Date().timeIntervalSince1970 * 1000),
        ], keeping: rule?.id == ruleID ? rule : nil)
    }

    /// Pause or Resume, as the computer's own button does.
    public func setRule(_ id: String, _ action: String) async {
        await change(id) {
            _ = try await self.session.request(.automationState, args: [id, action], as: PhoneJSON.self)
            await self.readAutomation()
        }
    }

    /// Pause all, as the computer's own button does.
    public func pauseAll() async {
        await change("pause-all") {
            _ = try await self.session.request(.automationPauseAll, as: PhoneJSON.self)
            await self.readAutomation()
        }
    }

    /// Turns the open draft on with the save its review showed.
    public func turnOn() async -> Bool {
        guard let rule, let save = rule.review?.save, let body = try? save.foundation else { return false }
        return await change(rule.id) {
            _ = try await self.session.request(.automationSave, args: [body], as: PhoneJSON.self)
            await self.readAutomation()
        }
    }

    // MARK: - Usage

    private func readUsage() async {
        let period = usagePeriod
        let answer = await ask(.usageSummary, [["period": period, "scope": "all"]])
        guard period == usagePeriod else { return }
        guard keep([(.summary, answer)]) else {
            if !away { usage = nil }
            return
        }
        buildUsage()
    }

    private func buildUsage() {
        guard let summary = answers[.summary] else { return }
        usage = page("usage", ["summary": summary, "unit": .string(usageUnit), "home": .string(session.mac.name)], keeping: usage)
    }

    public func setUsage(period: String) async {
        guard period != usagePeriod else { return }
        usagePeriod = period
        await readUsage()
    }

    /// The other unit is another reading of the same answer: nothing is asked again.
    public func setUsage(unit: String) {
        guard unit != usageUnit else { return }
        usageUnit = unit
        buildUsage()
    }

    // MARK: - Projects

    private func readProjects() async {
        // The projects the repositories belong to come with them, so a project of several reads as one group.
        async let repos = ask(.projects), folder = ask(.projectsFolder), names = ask(.automationProjects)
        let devices = await readDevices()
        let (own, place, groups) = (await repos, await folder, await names)
        guard keep([(.repos, own)]) else {
            if !away { projects = nil }
            return
        }
        take(.folder, place, otherwise: .null)
        take(.names, groups, otherwise: .array([]))
        take(.devices, devices, otherwise: .null)
        buildProjects()
    }

    private func buildProjects() {
        guard let repos = answers[.repos] else { return }
        projects = page("projects", [
            "repos": repos, "projects": answers[.names] ?? .array([]), "folder": answers[.folder]?["path"] ?? .null,
            "devices": answers[.devices] ?? .null, "home": .string(session.mac.name),
        ], keeping: projects)
    }

    /// One standing choice of a project, saved through the computer's own project settings.
    public func configure(_ id: String, _ patch: [String: Any]) async {
        await change(id) {
            _ = try await self.session.request(.projectConfigure, args: [id, patch], as: PhoneJSON.self)
            await self.readProjects()
        }
    }

    // MARK: - Runbooks

    private func readRunbooks() async {
        guard keep([(.books, await ask(.runbooks))]) else {
            if !away { runbooks = nil }
            return
        }
        buildRunbooks()
    }

    private func buildRunbooks() {
        guard let books = answers[.books] else { return }
        runbooks = page("runbooks", ["books": books, "home": .string(session.mac.name)], keeping: runbooks)
    }

    /// A runbook's switch; the computer answers its whole list.
    public func setRunbook(_ id: String, on: Bool) async {
        await change(id) {
            let books = try await self.session.request(.runbookSet, args: [id, on], as: PhoneJSON.self)
            self.answers[.books] = books
            self.buildRunbooks()
        }
    }

    // MARK: - Reading and changing

    private func ask(_ channel: PhoneRequest, _ args: [Any] = []) async -> Answer {
        do { return .value(try await session.request(channel, args: args, as: PhoneJSON.self)) }
        catch PhoneError.unavailable { return .away }
        catch is CancellationError { return .away }
        catch { return .refused }
    }

    /// Keeps a page's own answers when every one came. One refused leaves the page unread; one out of reach leaves
    /// the last reading as it was.
    private func keep(_ read: [(Reading, Answer)]) -> Bool {
        away = false
        var values: [(Reading, PhoneJSON)] = []
        for (reading, answer) in read {
            switch answer {
            case .value(let value): values.append((reading, value))
            case .away: away = true
            case .refused:
                for (reading, _) in read { answers[reading] = nil }
                return false
            }
        }
        if away { return false }
        for (reading, value) in values { answers[reading] = value }
        return true
    }

    /// An answer a page can do without: refused, it reads as `otherwise`; out of reach, the last one stays.
    private func take(_ reading: Reading, _ answer: Answer, otherwise: PhoneJSON) {
        switch answer {
        case .value(let value): answers[reading] = value
        case .refused: answers[reading] = otherwise
        case .away: if answers[reading] == nil { answers[reading] = otherwise }
        }
    }

    private func page<Page: Decodable>(_ name: String, _ input: [String: PhoneJSON], keeping last: Page?) -> Page? {
        guard let words else { return nil }
        return (try? words.page(name, input, as: Page.self)) ?? last
    }

    @discardableResult
    private func change(_ id: String, _ work: @escaping @MainActor () async throws -> Void) async -> Bool {
        guard session.canChange, !changing.contains(id) else { return false }
        changing.insert(id); problem = nil
        defer { changing.remove(id) }
        do { try await work(); return true }
        catch is CancellationError { return false }
        catch { problem = error.localizedDescription; return false }
    }
}
