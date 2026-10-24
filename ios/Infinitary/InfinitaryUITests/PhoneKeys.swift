import XCTest

/// INF-82: a live, run-long log subscription can omit registrations after a relaunch.
/// Start a fresh observer before launch, so launch-time and attachment-time records are both covered.
@MainActor func launchPhoneApp(_ app: XCUIApplication) async throws {
    let control = try XCTUnwrap(ProcessInfo.processInfo.environment["PHONE_TEST_HOME"])
    var request = URLRequest(url: try XCTUnwrap(URL(string: control + "/keyboard-before-launch")))
    request.httpMethod = "POST"
    request.timeoutInterval = 40
    let (data, response) = try await phoneTestSession.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw NSError(domain: "PhoneKeyboard", code: 3, userInfo: [NSLocalizedDescriptionKey:
            "The app was not launched: " + (String(data: data, encoding: .utf8) ?? "No keyboard observer")])
    }
    let observer = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let generation = try XCTUnwrap(observer["generation"] as? Int)
    XCTAssertGreaterThan(generation, 0)
    print("Keyboard observer started before launch: \(generation)")
    app.launch()
}

/// INF-355: backboardd's registration of the chord for the current app process is the readiness witness.
/// UIKit publishes an app's key commands only while a hardware keyboard is attached when its deferred update
/// runs after the next Core Animation commit, and XCTest's own keyboard detaches within a millisecond of a key
/// press, so the test home attaches one to the owned simulator for this wait and detaches it afterwards.
/// No priming press, held modifier or delay: the requested chord is the only key event, sent once after the witness.
/// App-side keyCommands, elapsed time and repeated key presses are not readiness witnesses.
@MainActor func pressPhoneKey(_ key: String, modifiers: XCUIElement.KeyModifierFlags, in app: XCUIApplication) async throws {
    let control = try XCTUnwrap(ProcessInfo.processInfo.environment["PHONE_TEST_HOME"])
    var request = URLRequest(url: try XCTUnwrap(URL(string: control + "/keyboard-ready")))
    request.httpMethod = "POST"
    request.timeoutInterval = 40
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let names: [(XCUIElement.KeyModifierFlags, String)] = [(.command, "cmd"), (.shift, "shft"), (.option, "opt"), (.control, "ctrl")]
    let canonicalKey = key == XCUIKeyboardKey.return.rawValue ? "\r" : key
    let modifierNames = names.filter { modifiers.contains($0.0) }.map { $0.1 }
    request.httpBody = try JSONSerialization.data(withJSONObject: [
        "key": canonicalKey, "modifiers": modifierNames
    ])
    let (data, response) = try await phoneTestSession.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw NSError(domain: "PhoneKeyboard", code: 1, userInfo: [NSLocalizedDescriptionKey:
            "The requested chord was not sent: " + (String(data: data, encoding: .utf8) ?? "No keyboard registration witness")])
    }
    let witness = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    guard witness["key"] as? String == canonicalKey,
          witness["modifiers"] as? [String] == modifierNames,
          let pid = witness["pid"] as? Int, pid > 0,
          witness["token"] is String else {
        throw NSError(domain: "PhoneKeyboard", code: 2, userInfo: [NSLocalizedDescriptionKey:
            "The requested chord was not sent: its registration witness did not match"])
    }
    print("Keyboard registration acknowledged: \(witness)")
    // Xcode 26.4's typist generates no HID event for the Return constant (CR).
    // LF generates the actual Return key (usage page 7, code 0x28), routed as CR by backboardd.
    // Keep CR for the registration witness; send that physical key exactly once.
    app.typeKey(canonicalKey == "\r" ? "\n" : key, modifierFlags: modifiers)
}
