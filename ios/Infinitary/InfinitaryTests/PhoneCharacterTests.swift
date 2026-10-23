import XCTest
@testable import Infinitary

/// INF-589 item 18, approved by the captain: the phone's character greets when the app opens or joins,
/// and nods when a reply is sent, with the Mac character's own rules (src/renderer/src/character/machine.ts).
/// Question 6's answer carries only those two emotes. Inputs replay what the phone hears in a real turn:
/// firstmate_state busy, the first mate's firstmate_emote nod during the turn, then busy ending.
@MainActor final class PhoneCharacterTests: XCTestCase {
    func testGreetsOnceOnFirstSightAndAgainAfterAJoin() {
        CharacterCues.greetingPending = true
        let opened = CharacterMotion()
        XCTAssertEqual(opened.advance(to: 100, state: .idle).mode, .greet, "The first character seen after opening greets")
        XCTAssertEqual(opened.advance(to: 101, state: .idle).mode, .greet)
        XCTAssertEqual(opened.advance(to: 102.2, state: .idle).mode, .idle, "The greeting lasts the Mac's 2.1 seconds")
        XCTAssertEqual(CharacterMotion().advance(to: 103, state: .idle).mode, .idle, "Another screen's character does not greet again")
        CharacterCues.greetOnNextSight()
        XCTAssertEqual(CharacterMotion().advance(to: 104, state: .idle).mode, .greet, "Joining a computer greets once more")
    }

    func testACharacterLeavingMidGreetingHandsTheGreetingOn() {
        CharacterCues.greetOnNextSight()
        let flashed = CharacterMotion()
        CharacterCues.shown.add(flashed)
        XCTAssertEqual(flashed.advance(to: 0, state: .idle).mode, .greet)
        CharacterCues.left(flashed)
        XCTAssertEqual(CharacterMotion().advance(to: 0.5, state: .idle).mode, .greet,
                       "The empty stage a join flashes before its cards arrive does not use up the greeting")
        CharacterCues.greetOnNextSight()
        let greeted = CharacterMotion()
        XCTAssertEqual(greeted.advance(to: 1, state: .idle).mode, .greet)
        XCTAssertEqual(greeted.advance(to: 3.2, state: .idle).mode, .idle)
        CharacterCues.left(greeted)
        XCTAssertFalse(CharacterCues.greetingPending, "A finished greeting is not played again")
    }

    func testReplyNodWaitsForTheTurnToEnd() {
        var machine = CharacterMachine(now: 0)
        machine.setInputs(listening: false, busy: true, now: 1)
        XCTAssertEqual(machine.update(now: 1).mode, .working)
        XCTAssertTrue(machine.request(.nod, now: 2))
        XCTAssertEqual(machine.update(now: 2).mode, .working, "A nod during the turn is held, not played over the work")
        machine.setInputs(listening: false, busy: false, now: 5)
        XCTAssertEqual(machine.update(now: 5).mode, .nod, "The held nod plays as the turn ends")
        XCTAssertEqual(machine.update(now: 6.5).mode, .idle, "The nod lasts the Mac's 1.4 seconds, then rests")
        machine.setInputs(listening: false, busy: true, now: 7)
        machine.setInputs(listening: false, busy: false, now: 8)
        XCTAssertEqual(machine.update(now: 8).mode, .idle, "A turn with no reply ends without a nod")
    }

    /// INF-790: a starting turn keeps the emote playing and the ember shows the turn, as on the Mac.
    func testATurnHeatsAnEmoteAndListeningInterruptsIt() {
        var machine = CharacterMachine(now: 0)
        machine.request(.greet, now: 0)
        machine.setInputs(listening: false, busy: true, now: 0.5)
        XCTAssertEqual(machine.update(now: 0.5).mode, .greet, "A starting turn lets the greeting play on")
        XCTAssertEqual(machine.update(now: 2.2).mode, .working, "The greeting ends into work")
        machine.setInputs(listening: false, busy: false, now: 3)
        machine.request(.nod, now: 3)
        machine.setInputs(listening: true, busy: false, now: 3.2)
        XCTAssertEqual(machine.update(now: 3.2).mode, .listening, "Attention interrupts the nod")
        XCTAssertFalse(machine.request(.nod, now: 3.3), "No emote plays over listening")
    }

    func testOnlyTheNodReachesCharactersOnScreen() {
        CharacterCues.greetingPending = false
        let shown = CharacterMotion(), hidden = CharacterMotion()
        _ = shown.advance(to: 0, state: .idle); _ = hidden.advance(to: 0, state: .idle)
        CharacterCues.shown.add(shown)
        defer { CharacterCues.shown.remove(shown) }
        CharacterCues.reacted("salute")
        XCTAssertEqual(shown.advance(to: 0.1, state: .idle).mode, .idle, "The phone carries no emote but the nod")
        CharacterCues.reacted("nod")
        XCTAssertEqual(shown.advance(to: 0.2, state: .idle).mode, .nod)
        XCTAssertEqual(hidden.advance(to: 0.2, state: .idle).mode, .idle, "A character off screen does not save the nod for later")
    }
}
