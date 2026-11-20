import Foundation

/// INF-4207 piece 9, the phone's side of taking over (docs/devices.md, "Taking over from a phone";
/// `src/shared/standbyPhone.ts`): each welcome names the computers that keep a copy of the record, with the pin of
/// each one's own key and where it listens, and the phone keeps them with its paired record. While the home is out
/// of reach the phone reaches each one there, shows what Take over rests on, and asks one to take over once the
/// person confirmed it with Face ID or the passcode. The computer that took over answers at the home's own key with
/// the next home number, which the phone already follows.
public struct PhoneStandby: Codable, Equatable, Sendable, Identifiable {
    public let deviceID: String
    public let name: String
    public let pin: String
    public let listens: [String]
    public var id: String { deviceID }

    public init(deviceID: String, name: String, pin: String, listens: [String]) {
        self.deviceID = deviceID; self.name = name; self.pin = pin; self.listens = listens
    }

    /// The list a welcome or `inf:home:routes` carries; nil when it carries none, as a home from before. An entry
    /// that is not whole is left out, never guessed.
    public static func list(_ value: Any?) -> [PhoneStandby]? {
        guard let entries = value as? [[String: Any]] else { return nil }
        return entries.prefix(64).compactMap { entry in
            guard let id = entry["deviceId"] as? String, !id.isEmpty, id.count <= 64,
                  let name = entry["name"] as? String, !name.isEmpty,
                  let pin = entry["pin"] as? String, JoinLink.validKey(pin),
                  let listens = entry["listens"] as? [String]
            else { return nil }
            return PhoneStandby(deviceID: id, name: name, pin: pin,
                                listens: Array(PhoneAddresses.preferred(listens).prefix(9)))
        }
    }
}

/// What one computer that keeps a copy says Take over rests on there (`inf:standby:offer`), as its own window shows it.
public struct PhoneTakeOverOffer: Equatable, Sendable {
    public enum Contact: String, Sendable { case reaching, inReach = "in-reach", lost, closed }
    public struct Copy: Equatable, Sendable {
        public let name: String
        public let copyAt: Date?
        public let newer: Bool
    }
    public enum Asked: String, Sendable { case running, started, refused }
    /// That computer's answer to an ask, in its own words.
    public struct Answer: Equatable, Sendable {
        public let state: Asked
        public let text: String
    }

    /// When its copy is from; nil while it holds no whole copy.
    public let copyAt: Date?
    public let homeName: String?
    /// Where the home stands as that computer hears it.
    public let contact: Contact
    /// When that computer last heard the home.
    public let heardAt: Date?
    /// The home said it went to sleep before that computer lost it.
    public let slept: Bool
    public let homeNumber: Int
    /// Every other copy, as the home last said it, with whether it may be newer than this one.
    public let copies: [Copy]
    /// The home told that computer what taking over needs.
    public let ready: Bool
    /// That computer's answer to the last ask, in its own words.
    public let asked: Answer?

    /// Take over is offered there only while that computer has a whole copy, knows what it needs, and has lost the
    /// home too: a home it still hears refuses the takeover there anyway.
    public var canTakeOver: Bool { copyAt != nil && ready && contact != .inReach && asked?.state != .running }

    public init?(_ value: Any?) {
        guard let offer = value as? [String: Any], let home = offer["home"] as? [String: Any],
              let contact = (home["contact"] as? String).flatMap(Contact.init(rawValue:)),
              let number = offer["homeNumber"] as? Int, number >= 1,
              let copies = offer["copies"] as? [[String: Any]], let ready = offer["ready"] as? Bool
        else { return nil }
        func date(_ value: Any?) -> Date? { (value as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } }
        copyAt = date(offer["copyAt"])
        homeName = (home["name"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.contact = contact
        heardAt = date(home["heardAt"])
        slept = home["slept"] as? Bool ?? false
        homeNumber = number
        self.copies = copies.prefix(64).compactMap { copy in
            guard let name = copy["name"] as? String, !name.isEmpty else { return nil }
            return Copy(name: name, copyAt: date(copy["copyAt"]), newer: copy["newer"] as? Bool ?? false)
        }
        self.ready = ready
        if let asked = offer["asked"] as? [String: Any], let state = (asked["state"] as? String).flatMap(Asked.init(rawValue:)),
           let text = asked["text"] as? String, !text.isEmpty {
            self.asked = Answer(state: state, text: text)
        } else { self.asked = nil }
    }
}

public enum PhoneTakeOver {
    /// Whether a welcome is from a second home: the number this phone heard last, said with a takeover other than
    /// the one it heard with that number (docs/devices.md, "Two homes with one number"). A phone that heard no
    /// takeover with that number, as one from before, takes it.
    public static func secondHome(_ frame: [String: Any], mac: JoinedMac) -> Bool {
        guard let heard = mac.takeOver else { return false }
        let number = PhoneHomeMove.number(inWelcome: frame)
        return number == (mac.homeNumber ?? PhoneHomeMove.firstHomeNumber) && (frame["takeOver"] as? String) != heard
    }

    /// The paired record after a welcome it accepted: the takeover that made this home, kept beside its number, and
    /// the computers that keep a copy. Nil when nothing changed.
    /// Read before the welcome's number is kept: a higher number keeps its own takeover, or none when a move made it.
    public static func welcomed(_ mac: JoinedMac, frame: [String: Any]) -> JoinedMac? {
        var next = mac
        let id = (frame["takeOver"] as? String).flatMap { !$0.isEmpty && $0.count <= 64 ? $0 : nil }
        let number = PhoneHomeMove.number(inWelcome: frame)
        let known = mac.homeNumber ?? PhoneHomeMove.firstHomeNumber
        if number > known { next.takeOver = id } else if number == known, let id { next.takeOver = id }
        if let standbys = PhoneStandby.list(frame["standbys"]) { next.standbys = standbys }
        return next == mac ? nil : next
    }

    /// The paired record after `inf:home:routes`: the computers that keep a copy as the home now lists them. Its
    /// addresses are the welcome's own, refreshed the same way.
    public static func routed(_ mac: JoinedMac, payload: Any?) -> JoinedMac? {
        guard let routes = payload as? [String: Any] else { return nil }
        var next = mac
        if let addresses = routes["addresses"] as? [String] {
            let refreshed = Array(PhoneAddresses.preferred(addresses + mac.addresses).prefix(25))
            if !refreshed.isEmpty { next.addresses = refreshed }
        }
        if let standbys = PhoneStandby.list(routes["standbys"]) { next.standbys = standbys }
        return next == mac ? nil : next
    }
}

public enum StandbyLinkError: Error, Equatable, Sendable {
    /// No address of that computer answered.
    case unreachable
    /// That computer answered from before taking over from a phone.
    case needsUpdate
    /// That computer does not list this phone on its copy of the record.
    case notListed
    /// It answered, refusing the ask, in its own words.
    case refused(String)
}

/// One ask on a computer that keeps a copy, over its own link for phones (`/phone`), pinned to that computer's own
/// key and answered only for a phone its copy of the record lists. Each ask opens its own link and closes it.
public enum StandbyLink {
    public static func ask(_ standby: PhoneStandby, phone: PhoneIdentity, channel: String, args: [Any] = [],
                           dialLimit: Duration = .seconds(10)) async throws -> Any? {
        var lastError = StandbyLinkError.unreachable
        for address in PhoneAddresses.preferred(standby.listens) {
            let transport = PinnedTransport(pin: standby.pin, phone: phone, purpose: .connection)
            defer { transport.close() }
            guard let socket = try? transport.socket(at: address, path: PhoneStandbyContract.path,
                                                    maxFrameBytes: PhoneStandbyContract.maxFrameBytes) else { continue }
            let opened = await withTaskGroup(of: Bool.self) { group in
                group.addTask { (try? await transport.opened()) != nil }
                group.addTask { try? await Task.sleep(for: dialLimit); return false }
                let first = await group.next() ?? false
                group.cancelAll()
                return first
            }
            guard opened else {
                switch (socket.response as? HTTPURLResponse)?.statusCode {
                case 404: lastError = .needsUpdate
                case 401, 403: lastError = .notListed
                default: break
                }
                if Task.isCancelled { throw CancellationError() }
                continue
            }
            let frame = try JSONSerialization.data(withJSONObject: ["t": "ask", "id": 1, "channel": channel, "args": args])
            try await socket.send(.string(String(decoding: frame, as: UTF8.self)))
            // A takeover may take as long as its work does, so the wait has no end of its own; a computer that drops
            // off the network meanwhile is found as the session finds a quiet home: by pings it no longer answers.
            let pongs = Pongs()
            let watch = Task {
                while !Task.isCancelled {
                    socket.sendPing { error in if error == nil { pongs.heard() } }
                    try? await Task.sleep(for: ReadOnlySession.pingEvery)
                    if !Task.isCancelled, pongs.quietFor > ReadOnlySession.patience {
                        socket.cancel(with: .goingAway, reason: nil); return
                    }
                }
            }
            defer { watch.cancel() }
            while true {
                let message: URLSessionWebSocketTask.Message
                do { message = try await socket.receive() } catch {
                    if Task.isCancelled { throw CancellationError() }
                    throw StandbyLinkError.unreachable
                }
                guard case .string(let text) = message,
                      let answer = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                      answer["id"] as? Int == 1 else { continue }
                switch answer["t"] as? String {
                case "answer": return answer["value"]
                case "refused": throw StandbyLinkError.refused(answer["error"] as? String ?? "")
                default: continue
                }
            }
        }
        throw lastError
    }

    /// When the computer last answered a ping on one ask's link.
    private final class Pongs: @unchecked Sendable {
        private let lock = NSLock()
        private var at = ContinuousClock.now
        func heard() { lock.withLock { at = .now } }
        var quietFor: Duration { lock.withLock { .now - at } }
    }

    /// What Take over rests on there.
    public static func offer(_ standby: PhoneStandby, phone: PhoneIdentity) async throws -> PhoneTakeOverOffer {
        guard let offer = PhoneTakeOverOffer(try await ask(standby, phone: phone, channel: PhoneStandbyContract.offer))
        else { throw PhoneError.invalidReply }
        return offer
    }

    /// The person's Take over, confirmed on this phone. `id` names the ask, so one asked again after a dropped link is
    /// the same takeover. Answers once the work there started the first mate or refused.
    public static func takeOver(_ standby: PhoneStandby, phone: PhoneIdentity, id: UUID)
        async throws -> PhoneTakeOverOffer.Answer {
        let value = try await ask(standby, phone: phone, channel: PhoneStandbyContract.takeOver,
                                  args: [["id": id.uuidString.lowercased()]])
        guard let answer = value as? [String: Any],
              let state = (answer["state"] as? String).flatMap(PhoneTakeOverOffer.Asked.init(rawValue:)),
              let text = answer["text"] as? String else { throw PhoneError.invalidReply }
        return PhoneTakeOverOffer.Answer(state: state, text: text)
    }
}
