import Foundation
import InfinitaryKit
import Observation
import UIKit

@MainActor @Observable final class PhoneModel {
    var connection: ReadOnlySession?
    var proposal: JoinLink?
    var problem: String?
    var busy = false
    var removed = false
    let nearby = NearbyMacs()
    private var identity: PhoneIdentity?
    private var joining: Task<Void, Never>?
    private var foreground = false
    private let savedURL: URL
    private let loadIdentity: () throws -> PhoneIdentity
    private let readMac: () throws -> JoinedMac?
    private let protectedDataAvailable: @MainActor () -> Bool

    init(loadIdentity: @escaping () throws -> PhoneIdentity = PhoneIdentity.loadOrCreate,
         readMac: (() throws -> JoinedMac?)? = nil,
         protectedDataAvailable: @escaping @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable }) {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("JoinedMac.json")
        savedURL = url
        self.loadIdentity = loadIdentity
        self.protectedDataAvailable = protectedDataAvailable
        self.readMac = readMac ?? {
            guard FileManager.default.fileExists(atPath: url.path) else { return nil }
            return try JSONDecoder().decode(JoinedMac.self, from: Data(contentsOf: url))
        }
        // Prewarm can construct the model before first unlock. Read protected data on activation.
        nearby.changed = { [weak self] addresses in self?.connection?.found(addresses: addresses) }
    }

    @discardableResult func restore() -> Bool {
        guard connection == nil, !busy else { return true }
        do {
            identity = try identity ?? loadIdentity()
            if let mac = try readMac() {
                guard JoinLink.validKey(mac.pin), !mac.addresses.isEmpty, mac.addresses.count <= 25,
                      !mac.deviceID.isEmpty, !mac.name.isEmpty,
                      mac.addresses.allSatisfy({ (try? JoinLink.url($0, path: "/")) != nil })
                else { return discardDamagedMac() }
                connect(mac)
            }
            problem = nil
            return true
        } catch {
            if identity == nil { problem = error.localizedDescription }
            else if needsUnlock(error) { problem = "Could not read this phone’s saved computer. Unlock your phone and try again." }
            else if error is DecodingError || (error as? CocoaError)?.code == .fileReadCorruptFile {
                return discardDamagedMac()
            } else { problem = "Could not read this phone’s saved computer. Try again." }
            return false
        }
    }

    private func needsUnlock(_ error: Error) -> Bool {
        !protectedDataAvailable() || (error as? CocoaError)?.code == .fileReadNoPermission
    }

    private func discardDamagedMac() -> Bool {
        guard protectedDataAvailable() else {
            problem = "Could not read this phone’s saved computer. Unlock your phone and try again."
            return false
        }
        do {
            try forget()
            problem = "Infinitary forgot a damaged connection. Use a new link to join your computer again."
            return true
        } catch {
            problem = needsUnlock(error) ? "Could not forget this computer. Unlock your phone and try again."
                : "Could not forget this computer. Try again."
            return false
        }
    }

    func propose(_ text: String) {
        guard connection == nil, !busy else { return }
        do { proposal = try JoinLink(text); problem = nil }
        catch { problem = error.localizedDescription }
    }

    func join() {
        guard let link = proposal, !busy else { return }
        guard restore(), let identity else { proposal = nil; return }
        guard connection == nil else {
            proposal = nil; problem = "Leave or forget your saved computer before joining another."
            return
        }
        busy = true; proposal = nil; problem = nil
        joining = Task {
            defer { busy = false; joining = nil }
            // Only proven pre-connection failures try another advertised address.
            // A lost reply never retries; a fresh confirmed link can recover the same phone key.
            let transport = PinnedTransport(pin: link.pin, phone: identity, purpose: .pairing)
            defer { transport.close() }
            do {
                let name = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
                let mac = try await transport.pair(link, name: name)
                try save(mac)
                proposal = nil; removed = false; CharacterCues.greetOnNextSight(); connect(mac)
            } catch { problem = error.localizedDescription }
        }
    }

    func leave() async {
        do {
            try await connection?.leave()
            forgetMac()
        } catch { problem = error.localizedDescription }
    }

    /// A local choice: no request to a Mac that may no longer exist, and no key rotation.
    func forgetMac() {
        do {
            try forget()
            connection?.stop(); connection = nil
            removed = false; proposal = nil; problem = nil
        } catch {
            problem = needsUnlock(error) ? "Could not forget this computer. Unlock your phone and try again."
                : "Could not forget this computer. Try again."
        }
    }

    func active(_ active: Bool) {
        foreground = active
        if active { _ = restore(); nearby.start(); connection?.start() }
        else { nearby.stop(); connection?.stop() }
    }

    private func connect(_ mac: JoinedMac) {
        guard let identity else { return }
        let session = ReadOnlySession(mac: mac, phone: identity)
        session.onMacChanged = { [weak self] mac in
            do { try self?.save(mac) } catch { self?.problem = "Could not keep this computer’s new address." }
        }
        session.onRemoved = { [weak self] in
            guard let self else { return }
            do { try forget() } catch { problem = "Could not forget this computer. Try Leave again." }
            removed = true
        }
        session.onEmote = { emote in CharacterCues.reacted(emote) }
        connection = session
        session.found(addresses: nearby.macs.map(\.address))
        if foreground { session.start() }
    }

    func dismissRemoved() { forgetMac() }

    private func save(_ mac: JoinedMac) throws {
        try FileManager.default.createDirectory(at: savedURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(mac).write(to: savedURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var url = savedURL
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    private func forget() throws {
        if FileManager.default.fileExists(atPath: savedURL.path) { try FileManager.default.removeItem(at: savedURL) }
    }
}
