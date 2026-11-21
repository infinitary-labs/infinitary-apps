import Foundation
import InfinitaryKit
import Network
import Observation
import UIKit

/// INF-1183: joining a home by its address, one step at a time on its sheet.
struct AddressJoin: Equatable {
    enum Step: Equatable {
        /// Signing in and asking the home for a link.
        case working
        /// First sight of the home's key: the person says yes, or Not this one.
        case trust(SSHHostKey)
        /// The home did not let the phone's key in; `password` says whether it takes one.
        case keyRefused(password: Bool)
        /// The join stopped; `problem` says why, and the person may try again.
        case stopped
    }
    let address: SSHAddress
    var step: Step
    var problem: String?
    /// INF-3307 row 13: this attempt, apart from a later one at the same or another address. A sign-in's answer
    /// lands only on the attempt that asked, so a cancelled one can never put its key on the next sheet.
    let attempt = UUID()
}

@MainActor @Observable final class PhoneModel {
    var connection: ReadOnlySession?
    /// This phone's Secrets approvals with the joined computer.
    var secrets: PhoneSecrets?
    /// INF-3454's phone part: Google's row in Settings → Integrations, for the computer this phone controls.
    var google: PhoneGoogle?
    /// INF-3563: the computer's own Settings pages, for the computer this phone controls.
    var settings: PhoneSettings?
    /// INF-4794: card pushes, or nil in an isolated phone check that did not ask for them (`PhonePushes.live`).
    var pushes: PhonePushes? { didSet { keptPushes() } }
    /// The computer's row rules and words for those pages, built from its own code and carried in the app.
    private static let settingsScript = Bundle.main.url(forResource: "SettingsWords.generated", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    var proposal: JoinLink?
    var problem: String?
    var busy = false
    var removed = false
    let nearby = NearbyMacs()
    var addressJoin: AddressJoin?
    /// INF-5265, the captain's approved plan on INF-5264 (docs/ios.md, "Several computers"): every computer this phone
    /// joined, the shown one first. One shows at a time.
    private(set) var kept = PhoneKeptMacs()
    /// Whether each other kept computer answered the phone's last look, by pin; none while a look is under way. The
    /// captain's pick, Stay: the list marks a computer that answers, and the phone never switches by itself.
    private(set) var answering: [String: Bool] = [:]
    @ObservationIgnored private var looking: Task<Void, Never>?
    @ObservationIgnored private weak var leavingSession: ReadOnlySession?
    /// Whether the kept computers were read since launch: until then the push record is not told the list, so a wake
    /// before the first unlock or before the read drops no computer's key.
    @ObservationIgnored private var restored = false
    /// A notification's tap waiting for its computer to show: a join under way, or a list not read yet.
    @ObservationIgnored private var tapped: (card: String, computer: String?)?
    private var identity: PhoneIdentity?
    private var sshKey: PhoneSSHKey?
    private var signingIn: Task<Void, Never>?
    private var joining: Task<Void, Never>?
    private var foreground = false
    private var backgroundTime = UIBackgroundTaskIdentifier.invalid
    /// INF-2157: a change of network looks again, as a reopen does, rather than waiting on a quiet connection.
    @ObservationIgnored private let network = NWPathMonitor()
    @ObservationIgnored private var networkSeen: String?
    /// INF-2668: a path changes several times as Wi-Fi and cellular trade places, so it looks again once the path
    /// has kept still for `networkSettle`.
    @ObservationIgnored private var networkSettling: Task<Void, Never>?
    static let networkSettle: Duration = .seconds(1)
    /// INF-2631: the app's start is noted once a run, on the first time it comes to the front.
    @ObservationIgnored private var launched = false
    /// What this phone's usage events say of it: its kind and its own version (docs/sharing.md, "A phone's events").
    private static var usage: PhoneUsage? {
        guard let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else { return nil }
        return PhoneUsage(device: UIDevice.current.userInterfaceIdiom == .pad ? .ipad : .iphone, version: version)
    }
    private let files: PhoneKeptMacsFiles
    private let trustedURL: URL
    private let loadIdentity: () throws -> PhoneIdentity
    private let readKept: () throws -> PhoneKeptMacs
    private let protectedDataAvailable: @MainActor () -> Bool
    /// Signs in to a typed address and asks its home for a link (`SSHJoin.link`); a test stands in for the home.
    private let askLink: @MainActor (SSHAddress, SSHHostKey?, PhoneSSHKey) async throws -> JoinLink

    init(loadIdentity: @escaping () throws -> PhoneIdentity = PhoneIdentity.loadOrCreate,
         readMac: (() throws -> JoinedMac?)? = nil,
         protectedDataAvailable: @escaping @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable },
         askLink: @escaping @MainActor (SSHAddress, SSHHostKey?, PhoneSSHKey) async throws -> JoinLink = {
             try await SSHJoin.link($0, trusted: $1, key: $2)
         }) {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let files = PhoneKeptMacsFiles(folder: folder)
        self.files = files
        trustedURL = folder.appendingPathComponent("TrustedHomes.json")
        self.loadIdentity = loadIdentity
        self.protectedDataAvailable = protectedDataAvailable
        self.askLink = askLink
        // A test names the one record it stands in for, shown, as a build before saved it.
        self.readKept = readMac.map { read in { PhoneKeptMacs(shown: try read()) } } ?? files.read
        // Prewarm can construct the model before first unlock. Read protected data on activation.
        nearby.changed = { [weak self] addresses in self?.connection?.found(addresses: addresses) }
        network.pathUpdateHandler = { [weak self] path in
            let seen = "\(path.status)|" + path.availableInterfaces.map(\.name).joined(separator: ",")
            let usable = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(seen, usable: usable) }
        }
        network.start(queue: .main)
        standInNetwork()
    }

    /// INF-5265's homes part: a test cannot change the simulator's own network, so in an isolated phone check the
    /// part's simulator posts a system notification for the phone's path going and coming back
    /// (`INFINITARY_TEST_NETWORK`, `phone-path`), which reaches `networkChanged` as the path monitor's would. A build
    /// for a device has none.
    private func standInNetwork() {
        #if targetEnvironment(simulator)
        let environment = ProcessInfo.processInfo.environment
        guard environment["INFINITARY_ISOLATED_PHONE_TEST"] == "1", environment["INFINITARY_TEST_NETWORK"] == "1" else { return }
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        // The app keeps its one model for its whole run, so the observer is never left pointing at a model that went.
        for name in [Self.standInPathLost, Self.standInPathBack] {
            CFNotificationCenterAddObserver(center, observer, { _, observer, name, _, _ in
                guard let observer, let name else { return }
                let usable = name.rawValue as String == PhoneModel.standInPathBack
                let model = Unmanaged<PhoneModel>.fromOpaque(observer).takeUnretainedValue()
                Task { @MainActor in model.networkChanged("stand-in|\(usable)", usable: usable) }
            }, name as CFString, nil, .deliverImmediately)
        }
        #endif
    }

    // i18n-exempt: system notification names, never shown
    nonisolated static let standInPathLost = "com.getinfinitary.infinitary.test.path-lost"
    nonisolated static let standInPathBack = "com.getinfinitary.infinitary.test.path-back"

    private func networkChanged(_ seen: String, usable: Bool) {
        // The monitor's first answer is the network the app started on, not a change.
        defer { networkSeen = seen }
        guard let before = networkSeen, before != seen else { return }
        networkSettling?.cancel(); networkSettling = nil
        // A path lost, such as a VPN turned off, leaves no mark from before it: the next look after it settles says.
        if !usable {
            looking?.cancel(); looking = nil
            answering = Dictionary(uniqueKeysWithValues: kept.others.map { ($0.pin, false) })
        }
        guard usable, foreground else { return }
        networkSettling = Task { [weak self] in
            try? await Task.sleep(for: Self.networkSettle)
            guard !Task.isCancelled, let self, self.foreground else { return }
            self.networkSettling = nil
            self.connection?.start()
            self.lookAtOthers()
        }
    }

    @discardableResult func restore() -> Bool {
        guard connection == nil, !busy else { return true }
        do {
            identity = try identity ?? loadIdentity()
            let read = try readKept()
            kept = PhoneKeptMacs(shown: read.shown, others: read.others.filter(Self.usable))
            // A list saved with none shown shows the one shown most recently.
            if kept.shown == nil, !kept.others.isEmpty { kept.forgetShown(); try? files.save(kept) }
            restored = true
            keptPushes()
            if let mac = kept.shown {
                guard Self.usable(mac) else { return discardDamagedMac() }
                connect(mac)
            }
            problem = nil
            lookAtOthers()
            openTapped()
            return true
        } catch {
            if identity == nil { problem = error.localizedDescription }
            else if needsUnlock(error) { problem = PhoneMessages.phoneModelReadSavedUnlock() }
            else if error is DecodingError || (error as? CocoaError)?.code == .fileReadCorruptFile {
                kept = PhoneKeptMacs()
                restored = true
                return discardDamagedMac()
            } else { problem = PhoneMessages.phoneModelReadSavedRetry() }
            return false
        }
    }

    /// Hands the push record the kept computers, so each has its own sealing key before it is reached.
    private func keptPushes() {
        guard restored, protectedDataAvailable() else { return }
        pushes?.kept(kept.all.map { ($0.pin, $0.name) })
    }

    private static func usable(_ mac: JoinedMac) -> Bool {
        JoinLink.validKey(mac.pin) && !mac.addresses.isEmpty && mac.addresses.count <= 25 && !mac.deviceID.isEmpty
            && !mac.name.isEmpty && mac.addresses.allSatisfy({ (try? JoinLink.url($0, path: "/")) != nil })
    }

    private func needsUnlock(_ error: Error) -> Bool {
        !protectedDataAvailable() || (error as? CocoaError)?.code == .fileReadNoPermission
    }

    private func discardDamagedMac() -> Bool {
        guard protectedDataAvailable() else {
            problem = PhoneMessages.phoneModelReadSavedUnlock()
            return false
        }
        do {
            try forget()
            keptPushes()
            problem = PhoneMessages.phoneModelForgotDamaged()
            if let next = kept.shown, Self.usable(next) { connect(next) }
            openTapped()
            return true
        } catch {
            problem = needsUnlock(error) ? PhoneMessages.phoneModelForgetUnlock()
                : PhoneMessages.phoneModelForgetRetry()
            return false
        }
    }

    /// INF-5265: a link proposes another computer while one is shown too; joining it keeps the one shown.
    func propose(_ text: String) {
        guard !busy else { return }
        do { proposal = try JoinLink(text); problem = nil }
        catch { problem = error.localizedDescription }
    }

    func join() {
        guard let link = proposal else { return }
        join(link)
    }

    private func join(_ link: JoinLink) {
        guard !busy else { return }
        guard restore(), let identity else { proposal = nil; return }
        busy = true; proposal = nil; problem = nil
        joining = Task {
            defer { busy = false; joining = nil; openTapped() }
            // A pinned non-mutating preflight selects a reachable route before joining.
            // A lost reply never retries; a fresh confirmed link can recover the same phone key.
            let transport = PinnedTransport(pin: link.pin, phone: identity, purpose: .pairing)
            defer { transport.close() }
            do {
                let name = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
                let mac = try await transport.pair(link, name: name)
                var next = kept; next.joined(mac)
                try files.save(next)
                kept = next
                keptPushes()
                proposal = nil; removed = false; CharacterCues.greetOnNextSight(); showKept()
                connection?.noteUsage(.ftueJoined)
            } catch { problem = error.localizedDescription }
        }
    }

    /// The phone's own key line, as the home's `authorized_keys` holds it.
    var sshKeyLine: String? { (try? phoneSSHKey())?.line }

    private func phoneSSHKey() throws -> PhoneSSHKey {
        if let sshKey { return sshKey }
        let key = try PhoneSSHKey.loadOrCreate()
        sshKey = key
        return key
    }

    /// Signs in to the typed address with the phone's key and joins with the link its home answers.
    func joinByAddress(_ text: String, port: String) {
        guard !busy, signingIn == nil else { return }
        do {
            addressJoin = AddressJoin(address: try SSHAddress(text, port: port), step: .working)
            askForLink()
        } catch { addressJoin = nil; problem = error.localizedDescription }
    }

    /// The person said this is their computer: keep the yes, then sign in.
    func trustHome() {
        guard let join = addressJoin, case .trust(let key) = join.step else { return }
        var homes = trustedHomes()
        homes.trust(key, for: join.address)
        do { try keep(homes) } catch {
            addressJoin?.problem = PhoneMessages.phoneModelKeepFingerprintFailed()
            return
        }
        askForLink()
    }

    /// Lets the phone's key in with the password, typed once, then signs in with the key.
    func sendPassword(_ password: String) {
        guard let join = addressJoin, case .keyRefused(true) = join.step, signingIn == nil, !password.isEmpty else { return }
        addressJoin?.step = .working; addressJoin?.problem = nil
        signingIn = Task {
            do {
                try await SSHJoin.placeKey(join.address, trusted: trustedHomes().key(for: join.address),
                                           key: try phoneSSHKey(), password: password)
            } catch {
                guard asking(join) else { return }
                addressJoin?.step = .keyRefused(password: true)
                addressJoin?.problem = error.localizedDescription
                return
            }
            guard asking(join) else { return }
            askForLink()
        }
    }

    func tryAddressAgain() { if addressJoin != nil { askForLink() } }

    func cancelAddressJoin() { signingIn?.cancel(); signingIn = nil; addressJoin = nil }

    private func askForLink() {
        guard let join = addressJoin, signingIn == nil else { return }
        addressJoin?.step = .working; addressJoin?.problem = nil
        signingIn = Task {
            do {
                let link = try await askLink(join.address, trustedHomes().key(for: join.address), try phoneSSHKey())
                guard asking(join) else { return }
                // The link is never shown: the phone joins with it at once, typed address first.
                addressJoin = nil; problem = nil
                self.join(link)
            } catch {
                guard asking(join) else { return }
                switch error {
                case SSHJoinError.unknownHost(let key): addressJoin?.step = .trust(key)
                case SSHJoinError.keyRefused(_, let password): addressJoin?.step = .keyRefused(password: password)
                default:
                    addressJoin?.step = .stopped
                    addressJoin?.problem = error.localizedDescription
                }
            }
        }
    }

    /// Whether `join` is still the attempt on the sheet. Its sign-in has answered, so the attempt asks no more.
    /// A cancelled or replaced attempt's answer changes nothing, and leaves the next attempt's sign-in running.
    private func asking(_ join: AddressJoin) -> Bool {
        guard addressJoin?.attempt == join.attempt else { return false }
        signingIn = nil
        return true
    }

    private func trustedHomes() -> TrustedHomes {
        (try? JSONDecoder().decode(TrustedHomes.self, from: Data(contentsOf: trustedURL))) ?? TrustedHomes()
    }

    private func keep(_ homes: TrustedHomes) throws {
        try FileManager.default.createDirectory(at: trustedURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(homes).write(to: trustedURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Leaves the computer the sheet named. INF-5265: when another computer shows by the time the leave is answered,
    /// such as after a notification's tap, the one left is still forgotten, and the one shown stays.
    func leave(_ session: ReadOnlySession) async {
        guard connection === session else { return }
        // The computer's removal answers this leave: Leave forgets it once, here, not again as a removal.
        leavingSession = session
        defer { leavingSession = nil }
        do {
            try await session.leave()
            forgetMac(session.mac.pin)
        } catch { problem = error.localizedDescription }
    }

    /// A local choice: no request to a Mac that may no longer exist, and no key rotation. INF-5265: it forgets the
    /// computer named, the shown one when none is named; forgetting the shown one shows the kept computer shown most
    /// recently next.
    func forgetMac(_ pin: String? = nil) {
        if let pin, pin != kept.shown?.pin {
            guard kept.others.contains(where: { $0.pin == pin }) else { return }
            var next = kept; next.forget(other: pin)
            do { try files.save(next) } catch {
                problem = needsUnlock(error) ? PhoneMessages.phoneModelForgetUnlock() : PhoneMessages.phoneModelForgetRetry()
                return
            }
            kept = next
            forgotPushes(pin)
            lookAtOthers()
            return
        }
        let pin = kept.shown?.pin
        do {
            try forget()
            close()
            forgotPushes(pin)
            removed = false; proposal = nil; problem = nil
            showKept()
        } catch {
            problem = needsUnlock(error) ? PhoneMessages.phoneModelForgetUnlock()
                : PhoneMessages.phoneModelForgetRetry()
        }
    }

    /// INF-5265: shows another kept computer, as the computer sheet's tap asks. The one shown before stays kept. True
    /// once that computer shows.
    @discardableResult func show(_ pin: String) -> Bool {
        if kept.shown?.pin == pin { return true }
        guard !busy else { return false }
        var next = kept
        guard next.show(pin) else { return false }
        do { try files.save(next) } catch { problem = PhoneMessages.phoneModelShowFailed(); return false }
        kept = next; removed = false; problem = nil
        showKept()
        return true
    }

    /// Ends the shown computer's connection and what was read through it.
    private func close() {
        connection?.stop(); connection = nil; secrets = nil; google = nil; settings = nil
        pushes?.left()
    }

    /// Connects to the computer the list shows now, or to none, and opens a tap that waited for it.
    private func showKept() {
        close()
        if let mac = kept.shown { connect(mac) }
        lookAtOthers()
        openTapped()
    }

    /// Lets go of a forgotten computer's pushes: its key and notifications, and the push address too once it was the
    /// last computer kept.
    private func forgotPushes(_ pin: String?) {
        guard let pushes else { return }
        Task {
            await pushes.forgot(computer: pin)
            // The list as it stands after the wait, not as it stood before it.
            keptPushes()
        }
    }

    /// INF-5265: looks at each other kept computer with the pinned check a join sends first, which opens no session,
    /// and marks the ones that answer. The phone looks when it opens, when the network settles, and when the computer
    /// sheet opens.
    func lookAtOthers() {
        looking?.cancel()
        let others = kept.others
        answering = answering.filter { pin, _ in others.contains { $0.pin == pin } }
        guard let identity, foreground || connection == nil, !others.isEmpty else { looking = nil; return }
        for mac in others { answering[mac.pin] = nil }
        looking = Task { [weak self] in
            await withTaskGroup(of: (String, Bool).self) { group in
                for mac in others { group.addTask { (mac.pin, await Self.answers(mac, phone: identity)) } }
                for await (pin, answers) in group {
                    guard !Task.isCancelled else { return }
                    self?.answering[pin] = answers
                }
            }
        }
    }

    nonisolated private static func answers(_ mac: JoinedMac, phone: PhoneIdentity) async -> Bool {
        let transport = PinnedTransport(pin: mac.pin, phone: phone, purpose: .pairing)
        defer { transport.close() }
        return await transport.answers(at: PhoneAddresses.preferred(mac.addresses))
    }

    func active(_ active: Bool) {
        foreground = active
        if active {
            // The list is handed to the push record on each open, connected or not, so a refused write is tried again.
            endBackgroundTime(); _ = restore(); keptPushes(); nearby.start(); connection?.start(); lookAtOthers()
            // INF-2631: the app's start and each time it comes to the front, handed to the computer.
            if !launched { launched = true; connection?.noteUsage(.launch) }
            connection?.noteUsage(.opened)
            if let pushes { Task { await pushes.opened() } }
        }
        else { nearby.stop(); keepThroughBackgroundTime() }
    }

    /// INF-1528: a short trip away keeps the connection, so the app comes back in reach. It stays open for the
    /// background time iOS gives the app and closes when iOS ends that time, before the app is suspended.
    private func keepThroughBackgroundTime() {
        guard connection != nil, backgroundTime == .invalid else { return }
        // i18n-exempt: a background task's name for the system, not shown
        backgroundTime = UIApplication.shared.beginBackgroundTask(withName: "Stay in reach") { [weak self] in
            MainActor.assumeIsolated { self?.backgroundTimeEnded() }
        }
        if backgroundTime == .invalid { connection?.stop(); return }
        // The simulator never ends a background task, so the journey stands in for iOS with its own end.
        if let seconds = ProcessInfo.processInfo.environment["INFINITARY_TEST_BACKGROUND_TIME"].flatMap(Double.init) {
            let task = backgroundTime
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(seconds))
                if self?.backgroundTime == task { self?.backgroundTimeEnded() }
            }
        }
    }

    private func backgroundTimeEnded() {
        if !foreground { connection?.stop() }
        endBackgroundTime()
    }

    private func endBackgroundTime() {
        guard backgroundTime != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTime)
        backgroundTime = .invalid
    }

    private func connect(_ mac: JoinedMac) {
        guard let identity else { return }
        let session = ReadOnlySession(mac: mac, phone: identity)
        session.usage = Self.usage
        session.onMacChanged = { [weak self] mac in
            guard let self, kept.shown?.pin == mac.pin else { return }
            var next = kept; next.update(mac)
            do { try files.save(next); kept = next } catch { problem = PhoneMessages.phoneModelKeepAddressFailed() }
            keptPushes()
        }
        session.onRemoved = { [weak self, weak session] in
            guard let self, let session, connection === session, leavingSession !== session else { return }
            let pin = session.mac.pin
            do { try forget() } catch {
                // Not forgotten: the removed screen stays on this computer, and its Forget tries again.
                problem = PhoneMessages.phoneModelForgetTryLeave(); removed = true; return
            }
            // INF-5265: while another computer is kept, it shows, and a line says this one removed the phone. The last
            // one lets go of its pushes now too, not only once the Removed screen's Forget is pressed.
            guard kept.shown != nil else { removed = true; forgotPushes(pin); return }
            Task { @MainActor in
                self.forgotPushes(pin)
                guard self.connection === session else { return }
                self.showKept()
                self.problem = PhoneMessages.phoneModelRemovedShowingNext(computer: session.mac.name)
            }
        }
        session.onEmote = { emote in CharacterCues.reacted(emote) }
        session.onSceneSignal = { signal in CharacterCues.signal(signal) }
        // INF-4794: each welcome hands the computer this phone's push registration, or null while notifications are off.
        session.onReached = { [weak self, weak session] in
            guard let self, let session, self.connection === session, let pushes = self.pushes else { return }
            // The list again first, so a key a failed write left unkept is made before it is handed.
            self.keptPushes()
            Task {
                // INF-5265: a switch while this waited hands nothing to, and clears nothing for, the computer left.
                guard self.connection === session else { return }
                await pushes.reached(computer: session.mac.pin, takesPushes: session.homeTakesPushes,
                                     takesWithdrawals: session.homeTakesWithdrawals) { registration in
                    try await session.request(.devicesPush, args: [registration?.argument ?? NSNull()], as: PhonePushAnswer.self).kept
                }
                guard self.connection === session else { return }
                await pushes.clear(stage: session.cards, seen: session.hasSeen, computer: session.mac.pin)
            }
        }
        connection = session
        secrets = PhoneSecrets(session: session, label: UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone")
        google = PhoneGoogle(session: session)
        settings = PhoneSettings(session: session, script: Self.settingsScript)
        session.found(addresses: nearby.macs.map(\.address))
        if foreground { session.start() }
    }

    func dismissRemoved() { forgetMac() }

    /// A notification's tap: the card opens on Home once the joined computer's cards are read. INF-5265: a card from
    /// another kept computer shows that computer first, and opens only on that computer's own connection: a tap waits
    /// while a join is under way, the list is not read yet or the connection is still the one before, and a card from
    /// a computer no longer kept, or from no known computer, opens nowhere.
    func openCard(_ id: String, computer: String? = nil) {
        tapped = (id, computer)
        _ = restore()
        openTapped()
    }

    private func openTapped() {
        guard let (card, named) = tapped, restored, !busy else { return }
        tapped = nil
        guard let computer = keptOwner(named) else { return }
        guard show(computer), let session = connection, session.mac.pin == computer else { tapped = (card, named); return }
        session.openCard(card)
    }

    /// INF-5265: the kept computer a notification came from, read from the push record the list was handed to: the one
    /// it names, or the one kept before the phone kept a key per computer; nil when that computer is not kept, the list
    /// is not read yet or no computer is known. A tap and a notification shown in front both go by it.
    func keptOwner(_ named: String?) -> String? {
        guard restored, let computer = pushes?.owner(named: named) ?? named,
              kept.all.contains(where: { $0.pin == computer }) else { return nil }
        return computer
    }

    /// Forgets the shown computer's record; the kept computer shown most recently becomes the shown one.
    private func forget() throws {
        var next = kept; next.forgetShown()
        try files.save(next)
        kept = next
    }
}
