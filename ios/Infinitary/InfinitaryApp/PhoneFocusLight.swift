import Foundation

/// INF-6951, the captain's approved plan: while a crewmate's summary is open, or crew browsing selects one, the scene
/// lights that crewmate's project on every computer and every other crewmate keeps a quarter of its light, as the
/// desktop's project focus does. Nothing moves for it. A port of the desktop's src/renderer/src/character/crew/focusLight.ts
/// (`restedLight`, `lightTarget`, `lightFrame`); the quarter is the desktop's own value, carried in the scene data.
enum PhoneFocusLight {
    static var outOfFocus: Double { CharacterCatalog.shared.focus["outOfFocusLight"]! }

    /// The project in light: the project of the crewmate rested on when the board names one, else `held` (nil lights everyone).
    static func project(held: String?, rested: String?) -> String? {
        guard let rested, !rested.isEmpty else { return held }
        return rested
    }

    /// The light a crewmate is headed for: full in the lit project, with no project lit, or with no project known.
    static func target(lit: String?, project: String?) -> Double {
        guard let lit, let project, !project.isEmpty else { return 1 }
        return project == lit ? 1 : outOfFocus
    }

    /// Each crewmate's light by task id, moved toward its target by `elapsed` of a `duration` move (seconds; zero is a
    /// cut, as under Reduce Motion). A crewmate gone from `crew` lets its light go. Returns whether any light still moves.
    @discardableResult
    static func step(_ crew: [(id: String, project: String?)], lit: String?, state: inout [String: Double],
                     elapsed: Double, duration: Double) -> Bool {
        let span = 1 - outOfFocus
        let move = duration <= 0 ? 1 : min(1, max(0, elapsed) / duration)
        var present = Set<String>(), moving = false
        for member in crew where present.insert(member.id).inserted {
            let target = target(lit: lit, project: member.project)
            let was = state[member.id] ?? target
            let light = abs(target - was) <= move * span ? target : was + (target > was ? 1 : -1) * move * span
            state[member.id] = light
            if light != target { moving = true }
        }
        for id in state.keys where !present.contains(id) { state[id] = nil }
        return moving
    }
}
