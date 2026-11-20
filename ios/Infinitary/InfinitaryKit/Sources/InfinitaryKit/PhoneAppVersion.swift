import Foundation

/// The version a person reads back from this app: its marketing version and its build, as Settings shows it and as
/// its hello tells its computer, whose Devices lists it (docs/devices.md, "Each copy's version").
public enum PhoneAppVersion {
    /// The longest version a computer's hello reads; a longer one is left unsaid rather than refused there.
    static let longest = 64

    /// From an app's Info dictionary: nil when it names no marketing version.
    public static func readBack(_ info: [String: Any]?) -> String? {
        guard let short = info?["CFBundleShortVersionString"] as? String, !short.isEmpty else { return nil }
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    /// What a hello says of this app's version: nil when it has none, or one too long for its computer to read.
    public static func forHello(_ info: [String: Any]?) -> String? {
        guard let version = readBack(info), version.count <= longest else { return nil }
        return version
    }

    /// This app's own.
    public static var current: String? { readBack(Bundle.main.infoDictionary) }
}
