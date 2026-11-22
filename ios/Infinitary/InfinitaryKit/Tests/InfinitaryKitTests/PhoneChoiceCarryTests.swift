import Testing
@testable import InfinitaryKit

/// INF-5608's approved plan, piece 2: "Against a computer without the change, the choices and the note's button wait while
/// a photo or note waits, with the Mac's words, so nothing is lost." INF-5487: a choice on the phone dropped the photos
/// and notes in its field. These read what a card's buttons do for each field and computer.
struct PhoneChoiceCarryTests {
    @Test func aComputerWithoutTheChangeHoldsTheButtonsWhilePhotosOrNotesWait() {
        #expect(PhoneChoiceCarry.reading(photos: 1, notes: 0, homeTakes: false) == .holds(notesFirst: false))
        // A note waiting says to send the notes first, as the Mac's footer does, photos or not.
        #expect(PhoneChoiceCarry.reading(photos: 0, notes: 2, homeTakes: false) == .holds(notesFirst: true))
        #expect(PhoneChoiceCarry.reading(photos: 2, notes: 1, homeTakes: false) == .holds(notesFirst: true))
    }

    @Test func aComputerWithTheChangeCarriesThemAndNamesWhatGoes() {
        let carry = PhoneChoiceCarry.reading(photos: 1, notes: 1, homeTakes: true)
        #expect(!carry.holds)
        guard case .carries(let line) = carry else { Issue.record("The press does not carry them: \(carry)"); return }
        // The line names each kind that goes with its count, as the Mac's does.
        #expect(line.contains(PhoneMessages.cardCarriedPictures(count: 1)), "\(line)")
        #expect(line.contains(PhoneMessages.cardCarriedNotes(count: 1)), "\(line)")
    }

    @Test func wordsAloneOrAnEmptyFieldChangeNothing() {
        #expect(PhoneChoiceCarry.reading(photos: 0, notes: 0, homeTakes: false) == .nothing)
        #expect(PhoneChoiceCarry.reading(photos: 0, notes: 0, homeTakes: true) == .nothing)
    }
}
