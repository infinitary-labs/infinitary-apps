import InfinitaryKit
import SwiftUI
import UIKit
import UserNotifications

/// INF-4794: the app's side of card pushes (docs/ios.md, "Card pushes"). iOS hands the push address, the relay's
/// grant and each notification's tap to this delegate, which passes them to `PhonePushes` on the model it owns.
@MainActor final class PhoneAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = PhoneModel()

    override init() {
        super.init()
        model.pushes = PhonePushes.live()
    }

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Set before launch ends, so a tap that opened Infinitary reaches this delegate.
        if model.pushes != nil { UNUserNotificationCenter.current().delegate = self }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let pushes = model.pushes, standInAddress(ProcessInfo.processInfo.environment) == nil else { return }
        Task { await pushes.tokenArrived(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    /// The relay's grant and a withdrawal arrive as background pushes; any other wakes nothing here. A withdrawal
    /// removes the notifications for the cards it names (docs/phone-push.md, "Withdrawals").
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let pushes = model.pushes else { completionHandler(.noData); return }
        if let grant = PhonePush.grant(inPush: userInfo) {
            Task {
                let kept = await pushes.pushArrived([PhonePush.grantKey: grant])
                completionHandler(kept ? .newData : .noData)
            }
            return
        }
        // Only the sealed text crosses into the task; iOS's dictionary is not sendable.
        guard let sealed = userInfo["sealed"] as? String else { completionHandler(.noData); return }
        Task {
            let removed = await pushes.withdrawArrived(["sealed": sealed])
            completionHandler(removed ? .newData : .noData)
        }
    }

    /// Quiet while Infinitary is in front and in reach, since its own stage shows the card; shown while it is away
    /// from its computer, where the in-app notice cannot show it (`PhonePush.showsInFront`).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let card = notification.request.content.userInfo[PhonePush.cardKey] as? String
        let shows = await MainActor.run { PhonePush.showsInFront(contact: self.model.connection?.contact, cardID: card) }
        return shows ? [.banner, .list, .sound] : []
    }

    /// A tap opens Infinitary on that card, as the in-app pill's tap does.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let card = response.notification.request.content.userInfo[PhonePush.cardKey] as? String
        completionHandler()
        if let card { Task { @MainActor in self.model.openCard(card) } }
    }
}

extension PhonePushes {
    /// The real effects, or nil in an isolated phone check that did not ask for pushes, so no system question
    /// covers its journeys and no check reaches the relay.
    static func live() -> PhonePushes? {
        let environment = ProcessInfo.processInfo.environment
        let isolated = environment["INFINITARY_ISOLATED_PHONE_TEST"] == "1"
        if isolated, environment["INFINITARY_TEST_PUSH"] != "1" { return nil }
        let relay = isolated ? standInRelay(environment) : nil
        let address = isolated ? standInAddress(environment) : nil
        let made = PhonePushesBox()
        let center = UNUserNotificationCenter.current()
        let asked = "phonePushAsked" // i18n-exempt: a saved setting's name, not shown
        let effects = PhonePushEffects(
            permission: {
                switch await center.notificationSettings().authorizationStatus {
                case .notDetermined: .notAsked
                case .denied: .off
                default: .on
                }
            },
            askPermission: { (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false },
            registerForPushes: {
                UIApplication.shared.registerForRemoteNotifications()
                if let address, let pushes = made.pushes { Task { await pushes.tokenArrived(address) } }
            },
            unregisterForPushes: { UIApplication.shared.unregisterForRemoteNotifications() },
            post: { [relay] url, body in
                guard let relay else { return await PhonePushRelay.post(url, body).status }
                // The phone check's stand-in relay answers with the grant, which a simulator cannot take by a
                // background push; it arrives as the relay's push would.
                let (status, answer) = await PhonePushRelay.post(relay, body)
                if let answer, let grant = (try? JSONSerialization.jsonObject(with: answer) as? [String: Any])?[PhonePush.grantKey] as? String {
                    Task { @MainActor in await made.pushes?.pushArrived([PhonePush.grantKey: grant]) }
                }
                return status
            },
            load: { PhonePushStore.load() },
            save: { PhonePushStore.save($0) },
            // iOS forgets its own answer when Infinitary is installed again; the person's Not now is kept here.
            askedPerson: { UserDefaults.standard.bool(forKey: asked) },
            noteAskedPerson: { UserDefaults.standard.set(true, forKey: asked) },
            delivered: {
                await center.deliveredNotifications().map {
                    let shown = PhonePushSeal.shown($0.request.content.userInfo)
                    return ($0.request.identifier, shown.cardID, shown.push)
                }
            },
            remove: { center.removeDeliveredNotifications(withIdentifiers: $0) },
            now: { Date() })
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
        let pushes = PhonePushes(effects: effects, environment: PhonePush.environment(profile: profile))
        made.pushes = pushes
        return pushes
    }
}

/// The pushes the stand-in address goes to, made after their effects.
@MainActor private final class PhonePushesBox { weak var pushes: PhonePushes? }

/// The push part asks its test home's stand-in relay, never Infinitary's own; a build for a device has none.
private func standInRelay(_ environment: [String: String]) -> URL? {
    #if targetEnvironment(simulator)
    environment["INFINITARY_TEST_PUSH_RELAY"].flatMap(URL.init(string:))
        .map { $0.deletingLastPathComponent().appendingPathComponent(PhonePush.register.lastPathComponent) }
    #else
    nil
    #endif
}

/// The push part's own push address: a simulator in the phone check never reaches Apple's push service, so it gets
/// none from iOS; `simctl push` delivers to the app whatever address the relay was told. A build for a device has none.
private func standInAddress(_ environment: [String: String]) -> Data? {
    #if targetEnvironment(simulator)
    guard let hex = environment["INFINITARY_TEST_PUSH_ADDRESS"], hex.count.isMultiple(of: 2) else { return nil }
    var bytes = [UInt8]()
    var at = hex.startIndex
    while at < hex.endIndex {
        let next = hex.index(at, offsetBy: 2)
        guard let byte = UInt8(hex[at..<next], radix: 16) else { return nil }
        bytes.append(byte)
        at = next
    }
    return Data(bytes)
    #else
    nil
    #endif
}

/// The one ask of Infinitary's relay: no cookies, no cache and no redirect followed.
enum PhonePushRelay {
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? { nil }
    }

    static func post(_ url: URL, _ body: Data) async -> (status: Int?, answer: Data?) {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        guard let (answer, response) = try? await session.data(for: request) else { return (nil, nil) }
        return ((response as? HTTPURLResponse)?.statusCode, answer)
    }
}

/// The one-sentence ask before iOS's own question, shown once after joining a computer that pushes.
struct PhonePushAsk: ViewModifier {
    let pushes: PhonePushes?
    let computer: String

    func body(content: Content) -> some View {
        content.alert(PhoneMessages.phonePushAskTitle(), isPresented: Binding(
            get: { pushes?.asking == true },
            set: { if !$0, pushes?.asking == true { Task { await pushes?.answer(false) } } }
        )) {
            Button(PhoneMessages.phonePushTurnOn()) { Task { await pushes?.answer(true) } }.accessibilityIdentifier("push-turn-on")
            Button(PhoneMessages.phonePushNotNow(), role: .cancel) { Task { await pushes?.answer(false) } }
        } message: {
            Text(PhoneMessages.phonePushAskLine(computer: computer, device: phoneDeviceName))
        }
    }
}

/// The name the phone's own words give this device.
@MainActor var phoneDeviceName: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }
