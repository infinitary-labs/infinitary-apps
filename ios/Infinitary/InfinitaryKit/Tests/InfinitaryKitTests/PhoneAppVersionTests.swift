import Testing
@testable import InfinitaryKit

/// INF-5373: the phone tells its computer its real version, the one its Settings shows, instead of a fixed one, so
/// the computer's Devices lists what the phone runs.
struct PhoneAppVersionTests {
    /// The keys a TestFlight build's Info.plist carries, as the project's build settings fill them.
    let built: [String: Any] = ["CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "212"]

    @Test func readsTheMarketingVersionAndBuildAsSettingsShowsThem() {
        #expect(PhoneAppVersion.readBack(built) == "0.1.0 (212)")
        #expect(PhoneAppVersion.forHello(built) == "0.1.0 (212)")
    }

    @Test func saysNothingWithoutAMarketingVersion() {
        #expect(PhoneAppVersion.readBack(["CFBundleVersion": "212"]) == nil)
        #expect(PhoneAppVersion.forHello(nil) == nil)
    }

    @Test func leavesUnsaidAVersionTooLongForTheComputerToRead() {
        let long: [String: Any] = ["CFBundleShortVersionString": String(repeating: "9", count: 60), "CFBundleVersion": "212"]
        #expect(PhoneAppVersion.readBack(long) != nil)
        #expect(PhoneAppVersion.forHello(long) == nil)
    }
}
