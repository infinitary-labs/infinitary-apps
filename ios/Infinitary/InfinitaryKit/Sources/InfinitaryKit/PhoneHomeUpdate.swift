import Foundation

/// INF-4012's direction 1: the computer's own update as this phone reads and starts it (`inf:home-update:*`, the
/// frozen shape in src/shared/homeUpdate.ts). The requests are answered on every major, past the read-only gate, so
/// a phone and a computer on opposite sides of a release can still bring the computer up to date (docs/ios.md,
/// "Updating the computer").
public struct PhoneHomeUpdate: Decodable, Equatable, Sendable {
    /// The Infinitary version the computer runs.
    public var version: String
    public var channel: String
    /// The newer version Update installs now; nil when the computer offers nothing from afar.
    public var offered: String?
    /// Where the update stands, an open list: a word this phone does not know shows the version alone.
    public var step: String
    public var percent: Double?
    public var waitingFor: [String]
    public var stops: Stops
    /// The computer's own words for why it cannot update from here, or what went wrong.
    public var problem: String?

    public struct Stops: Decodable, Equatable, Sendable {
        public var tasks: [String]
        public var jobs: Int
        public init(tasks: [String], jobs: Int) { self.tasks = tasks; self.jobs = jobs }
    }

    public init(version: String, channel: String = "alpha", offered: String?, step: String, percent: Double? = nil,
                waitingFor: [String] = [], stops: Stops = Stops(tasks: [], jobs: 0), problem: String? = nil) {
        self.version = version; self.channel = channel; self.offered = offered; self.step = step
        self.percent = percent; self.waitingFor = waitingFor; self.stops = stops; self.problem = problem
    }

    /// The steps during which the update moves on by itself, so the phone reads again every few seconds.
    public var underWay: Bool { ["starting", "downloading", "saving", "restarting", "resuming"].contains(step) }

    /// The steps after which the computer quits to replace its copy: a connection that ends now is the restart.
    public var aboutToRestart: Bool { step == "saving" || step == "restarting" }

    /// Update starts the offered version: a newer one is offered, or the last try failed and it still is.
    public var offersUpdate: Bool { offered != nil && (step == "offered" || step == "failed") }

    /// Update later lets the update go while it waits on running work, as the computer's own notice does.
    public var offersLater: Bool { step == "saving" }

    /// The line under the message box, naming the computer; nil when there is nothing to say there.
    public func line(name: String) -> String? {
        switch step {
        case "offered": return offered.map { PhoneMessages.viewHomeUpdateOffered(name: name, version: $0) }
        case "elsewhere": return problem
        case "starting": return PhoneMessages.viewHomeUpdateStarting(name: name)
        case "downloading": return offered.map { PhoneMessages.viewHomeUpdateDownloading(name: name, version: $0) }
        case "saving":
            let saving = PhoneMessages.viewHomeUpdateSaving(name: name)
            guard !waitingFor.isEmpty else { return saving }
            return saving + " " + PhoneMessages.viewHomeUpdateWaitingFor(tasks: PhoneFormats.list(waitingFor))
        case "restarting": return PhoneMessages.viewHomeUpdateRestarting(name: name)
        case "resuming": return PhoneMessages.viewHomeUpdateResuming(name: name)
        case "failed":
            let failed = PhoneMessages.viewHomeUpdateFailed(name: name)
            guard let problem, !problem.isEmpty else { return failed }
            return failed + " " + problem
        default: return nil
        }
    }

    /// The Settings row's second line: the line above, that the computer is up to date, or the version alone for a
    /// step this phone does not know.
    public func status(name: String) -> String {
        if let line = line(name: name) { return line }
        return step == "current" ? PhoneMessages.viewHomeUpdateCurrent(version: version) : version
    }

    /// The confirm sheet's message: the work that finishes first, the jobs that stop, and that nothing undoes it from afar.
    public func confirmLines(name: String) -> [String] {
        var lines = [stops.tasks.isEmpty
            ? PhoneMessages.viewHomeUpdateConfirmNoTasks()
            : PhoneMessages.viewHomeUpdateConfirmTasks(tasks: PhoneFormats.list(stops.tasks))]
        if stops.jobs > 0 { lines.append(PhoneMessages.viewHomeUpdateConfirmJobs(jobs: stops.jobs.formatted())) }
        lines.append(PhoneMessages.viewHomeUpdateConfirmNoUndo(name: name))
        return lines
    }

    /// The computer answers these requests when its welcome names the change, or it speaks the major that folded it in.
    public static func supported(homeVersion: String?, changes: [String]) -> Bool {
        let major = (homeVersion?.split(separator: ".").first).flatMap { Int($0) } ?? 0
        return major >= PhoneContract.homeUpdateFolded || changes.contains(PhoneContract.homeUpdate)
    }
}

/// How long a computer restarting for an update has to come back before the phone says it has not.
public enum PhoneHomeRestart {
    public static let patience: TimeInterval = 180
}
