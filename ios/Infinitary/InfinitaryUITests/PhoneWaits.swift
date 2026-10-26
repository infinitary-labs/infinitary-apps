import XCTest

/// INF-1083: the launcher writes the shared budget reading into every test target's plan.
private let gradesBudgets = ProcessInfo.processInfo.environment["INFINITARY_PERF_BUDGETS"] == "1"

/// Mirrors tests/helpers/budgets.ts: the load clock samples every 25 ms, counts at most
/// two ticks across a stall, and slows when the one-minute load exceeds the processor count.
/// Each observation still ends at min(20 × budget, 10 minutes) on the monotonic wall clock.
struct PhoneWaitDeadline {
    private let budget: TimeInterval
    private let graded: Bool
    private let started: TimeInterval
    private var last: TimeInterval
    private var counted: TimeInterval = 0
    private var share: Double = 1
    static let tick: TimeInterval = 0.025

    init(_ budget: TimeInterval, graded: Bool = gradesBudgets,
         now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        precondition(budget.isFinite && budget >= 0)
        self.budget = budget
        self.graded = graded
        started = now
        last = now
    }

    mutating func expired(now: TimeInterval = ProcessInfo.processInfo.systemUptime,
                          load: Double = phoneLoad(), processors: Int = ProcessInfo.processInfo.activeProcessorCount) -> Bool {
        counted += min(max(0, now - last), 2 * Self.tick) * share
        last = now
        share = min(1, Double(processors) / max(Double(processors), load))
        let elapsed = now - started
        return graded ? elapsed >= budget : counted >= budget || elapsed >= phoneRequestBudget(budget)
    }
}

private func phoneLoad() -> Double {
    var reading: Double = 0
    return getloadavg(&reading, 1) == 1 ? reading : 0
}

/// The transport is an outer safety boundary only; the request's failure timer uses the clock.
func phoneRequestBudget(_ seconds: TimeInterval) -> TimeInterval {
    min(20 * seconds, 600)
}

/// Test-control requests go only to the disposable home, never the app's transport.
/// Race one request (never a retry) against the same load deadline as native observations.
/// URLSession cancellation joins the request before the caller resumes.
enum phoneTestSession {
    private static let session = URLSession(configuration: .ephemeral)

    static func data(for original: URLRequest) async throws -> (Data, URLResponse) {
        var request = original
        let budget = request.timeoutInterval
        if !gradesBudgets { request.timeoutInterval = phoneRequestBudget(budget) }
        let prepared = request
        return try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
            group.addTask { try await session.data(for: prepared) }
            group.addTask {
                var deadline = PhoneWaitDeadline(budget)
                while !deadline.expired() {
                    try await Task.sleep(for: .seconds(PhoneWaitDeadline.tick))
                }
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }
}

@MainActor extension XCUIElement {
    func waitForPresence(timeout: TimeInterval) -> Bool {
        waitForPhonePredicate(NSPredicate { _, _ in self.exists }, object: self, timeout: timeout) == .completed
    }

    func waitForAbsence(timeout: TimeInterval) -> Bool {
        waitForPhonePredicate(NSPredicate { _, _ in !self.exists }, object: self, timeout: timeout) == .completed
    }
}

/// INF-975: evaluate the predicate directly, not through short XCTest expectation windows,
/// which can time out before XCTest ever evaluates it. The run loop services native reads.
@MainActor func waitForPhonePredicate(_ predicate: NSPredicate, object: Any?, timeout: TimeInterval) -> XCTWaiter.Result {
    var deadline = PhoneWaitDeadline(timeout)
    if predicate.evaluate(with: object) { return .completed }
    repeat {
        if deadline.expired() {
            print("Phone wait failed: predicate remained unsatisfied; budget \(timeout)s, cap \(gradesBudgets ? timeout : phoneRequestBudget(timeout))s")
            return .timedOut
        }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: PhoneWaitDeadline.tick))
        if deadline.expired() { continue }
        if predicate.evaluate(with: object) { return .completed }
    } while true
}

/// INF-1083 / INF-1122: presence is not keyboard focus. Send one tap, then observe
/// UIKit's actual first-responder state before asking XCTest to synthesize typing.
@MainActor func focusForPhoneTyping(_ input: XCUIElement, in app: XCUIApplication) {
    XCTAssertTrue(input.waitForPresence(timeout: 10), app.debugDescription)
    XCTAssertEqual(waitForPhonePredicate(NSPredicate { _, _ in input.isEnabled && input.isHittable },
        object: input, timeout: 10), .completed, app.debugDescription)
    input.tap()
    // INF-1377: the first letter keyboard can show iOS's typing guide. Dismiss that
    // known interruption before observing focus; never retry a tap or send priming text.
    let guide = app.staticTexts["Speed up your typing by sliding your finger across the letters to compose a word."]
    if guide.exists {
        app.buttons["Continue"].tap()
        XCTAssertTrue(guide.waitForAbsence(timeout: 10), app.debugDescription)
    }
    XCTAssertEqual(waitForPhonePredicate(NSPredicate(format: "hasKeyboardFocus == true"),
        object: input, timeout: 10), .completed, app.debugDescription)
}

/// The native count includes every named answer, not only required questions.
/// Match equal, nonzero observed counts rather than inventing a fixture-specific total.
let phoneAnsweredFormPattern = #"([1-9][0-9]*) of \1 answered"#

@MainActor func waitForAnsweredPhoneForm(in app: XCUIApplication) {
    let complete = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", phoneAnsweredFormPattern)).firstMatch
    XCTAssertTrue(complete.waitForPresence(timeout: 10), app.debugDescription)
}
