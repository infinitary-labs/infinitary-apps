import { expect, it } from "vitest";
import { isPhoneCheckedFile, phoneRawWordsIn } from "../scripts/phone-raw-words";

// The approved plan for the phone's languages (INF-3675, piece 1): a phone
// raw-words check with a shrink-only ledger and `i18n-exempt`, so the phone's
// words move into the catalog file by file as the window's did.

const VIEW = `
import SwiftUI

struct Strip: View {
    let count: Int
    @State private var mode = "open"
    var body: some View {
        // A comment saying "Words in a comment" is not shown.
        VStack {
            Text("Nothing to show yet")
            Text(count > 1 ? "\\(count) tasks waiting" : "Ready")
            Image(systemName: "chevron.right")
            Button("Close the strip") { mode = "closed" }
                .accessibilityIdentifier("Close strip")
                .accessibilityLabel("Close the strip")
            if mode == "Ready to go" { Text(PhoneMessages.fileAdd()) }
            // i18n-exempt: a product name
            Text("Claude Code")
        }
        .onAppear { print("Strip shown on screen") }
    }
    static let words = ["Waiting room": 1]
    func script() -> String { "window.phoneCard.mount(input); return await window.phoneCard.collect()" }
}
`;

it("finds the words a person reads typed into a Swift view, and nothing that names code", () => {
  expect(phoneRawWordsIn(VIEW).map((words) => words.text)).toEqual([
    "Nothing to show yet",
    "0 tasks waiting",
    "Ready",
    "Close the strip",
    "Close the strip",
  ]);
});

it("reads the phone app's own Swift and its package, never tests or generated files", () => {
  expect(isPhoneCheckedFile("ios/Infinitary/InfinitaryApp/PhoneCards.swift")).toBe(true);
  expect(
    isPhoneCheckedFile("ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneTaskFacts.swift"),
  ).toBe(true);
  expect(isPhoneCheckedFile("ios/Infinitary/InfinitaryApp/PhoneCardWords.generated.swift")).toBe(
    false,
  );
  expect(isPhoneCheckedFile("ios/Infinitary/InfinitaryUITests/PhoneJourney.swift")).toBe(false);
  expect(
    isPhoneCheckedFile(
      "ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/PhoneWordsTests.swift",
    ),
  ).toBe(false);
});
