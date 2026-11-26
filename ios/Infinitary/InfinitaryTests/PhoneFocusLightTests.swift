import XCTest
@testable import Infinitary

/// INF-6951, the captain's approved plan: while a crewmate's summary is open the phone's scene lights that crewmate's
/// project on every computer with the desktop's own light. The readings are the desktop's focusLight.ts for one board of
/// two computers and two projects, as summaries open, move and close (scripts/generate-phone-scene.ts).
final class PhoneFocusLightTests: XCTestCase {
    func testThePhonesLightMatchesTheDesktopsForOneBoard() throws {
        struct Step: Decodable { let held: String?; let rested: String?; let elapsedMs: Double; let light: [String: Double] }
        struct Readings: Decodable { let projects: [String: String]; let durationMs: Double; let steps: [Step] }
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "PhoneFocusLight.generated", withExtension: "json"))
        let readings = try JSONDecoder().decode(Readings.self, from: Data(contentsOf: url))
        let crew = readings.steps[0].light.keys.sorted().map { (id: $0, project: readings.projects[$0]) }
        var state: [String: Double] = [:]
        for (index, step) in readings.steps.enumerated() {
            let lit = PhoneFocusLight.project(held: step.held, rested: step.rested.flatMap { readings.projects[$0] })
            PhoneFocusLight.step(crew, lit: lit, state: &state, elapsed: step.elapsedMs / 1000, duration: readings.durationMs / 1000)
            for (id, light) in step.light {
                XCTAssertEqual(try XCTUnwrap(state[id]), light, accuracy: 0.000001, "step \(index), \(id)")
            }
        }
    }
}
