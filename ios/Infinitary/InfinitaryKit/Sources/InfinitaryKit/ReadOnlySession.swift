import Foundation
import Observation

public struct PhoneCard: Decodable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let meta: String?
    public let author: String
}

public struct ActivityLine: Decodable, Sendable {
    public let kind: String
    public let text: String
    public let at: Double
}

/// All product content is in memory. Only the joined computer's public routing facts persist.
@MainActor @Observable public final class ReadOnlySession {
    public private(set) var mac: JoinedMac
    public private(set) var cards: [PhoneCard] = []
    public private(set) var activity: [ActivityLine] = []
    public private(set) var contact = "reaching"
    public private(set) var heardAt: Date?
    public private(set) var removed = false
    public var onMacChanged: ((JoinedMac) -> Void)?
    public var onRemoved: (() -> Void)?
    @ObservationIgnored private let phone: PhoneIdentity
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var transport: PinnedTransport?
    @ObservationIgnored private var epoch: String?
    @ObservationIgnored private var sequence = 0
    @ObservationIgnored private var nextID = 0
    @ObservationIgnored private var pending: [Int: String] = [:]
    @ObservationIgnored private var dirty = Set<String>()
    @ObservationIgnored private var ready = Set<String>()
    @ObservationIgnored private var discoveries: [String] = []
    @ObservationIgnored private var refused = 0
    @ObservationIgnored private var leaving = false
    @ObservationIgnored private var leaveContinuation: CheckedContinuation<Void, Error>?
    @ObservationIgnored private var waitingSince: [Int: Date] = [:]
    @ObservationIgnored private var leaveStarted: Date?
    @ObservationIgnored private var generation = 0

    public init(mac: JoinedMac, phone: PhoneIdentity) { self.mac = mac; self.phone = phone }

    public func start() {
        guard loop == nil, !removed else { return }
        generation += 1
        let current = generation
        loop = Task { [weak self] in await self?.run(generation: current) }
    }

    public func stop() {
        generation += 1
        loop?.cancel(); loop = nil
        finishLeave(PhoneError.unavailable)
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        transport?.close(); transport = nil
        contact = "lost"
    }

    public func found(addresses: [String]) {
        discoveries = Array(Set(addresses)).sorted()
    }

    public func leave() async throws {
        guard contact == "in-reach", let socket, !leaving else { throw PhoneError.unavailable }
        leaving = true; leaveStarted = Date()
        defer { leaving = false; leaveStarted = nil }
        try await withCheckedThrowingContinuation { continuation in
            leaveContinuation = continuation
            Task {
                do { try await send(["t": "leave"], on: socket) }
                catch {
                    if self.socket === socket { finishLeave(error) }
                }
            }
        }
    }

    private func abort(_ socket: URLSessionWebSocketTask) {
        guard self.socket === socket else { return }
        socket.cancel(with: .goingAway, reason: nil)
        // Also cancel a handshake that has not become a WebSocket yet.
        transport?.close()
    }

    private func finishLeave(_ error: Error? = nil) {
        let continuation = leaveContinuation; leaveContinuation = nil
        if let error { continuation?.resume(throwing: error) } else { continuation?.resume() }
    }

    private func run(generation current: Int) async {
        var attempt = 0
        while !Task.isCancelled && !removed && current == generation {
            let addresses = mac.addresses + discoveries.filter { !mac.addresses.contains($0) }
            for address in addresses {
                if Task.isCancelled || removed || current != generation { return }
                let transport = PinnedTransport(pin: mac.pin, phone: phone, purpose: .connection)
                self.transport = transport
                var connection: URLSessionWebSocketTask?
                do {
                    let socket = try transport.socket(at: address)
                    connection = socket; self.socket = socket
                    pending.removeAll(); waitingSince.removeAll(); dirty.removeAll(); ready.removeAll()
                    contact = heardAt == nil ? "reaching" : "lost"
                    var hello: [String: Any] = ["t": "hello", "protocolVersion": PhoneContract.version,
                        "as": "view", "system": "ios", "spellings": ["inf"], "appVersion": "0.1.0"]
                    if let epoch { hello["cursor"] = ["epoch": epoch, "seq": sequence] }
                    let watchdog = Task { [weak self, weak socket] in
                        // Bound the handshake too: send(hello) can wait for a connection to open.
                        // Each successful pong proves liveness; welcome/reads have a separate bounded wait.
                        var welcomed = false
                        while !Task.isCancelled {
                            try? await Task.sleep(for: .seconds(10))
                            guard !Task.isCancelled, let self, let socket, self.socket === socket else { return }
                            let waiting = self.waitingSince.values.contains { Date().timeIntervalSince($0) > 15 }
                            let leaveWait = self.leaveStarted.map { Date().timeIntervalSince($0) > 15 } ?? false
                            if waiting || leaveWait { self.abort(socket); return }
                            if !welcomed && self.contact != "in-reach" {
                                self.abort(socket); return
                            }
                            welcomed = true
                            if let heard = self.heardAt, Date().timeIntervalSince(heard) > 25 {
                                self.abort(socket); return
                            }
                            socket.sendPing { [weak self, weak socket] error in
                                Task { @MainActor in
                                    guard let self, let socket, self.socket === socket else { return }
                                    if error != nil { self.abort(socket) }
                                    else { self.heardAt = Date() }
                                }
                            }
                        }
                    }
                    defer { watchdog.cancel() }
                    try await send(hello, on: socket)
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        guard current == generation, !Task.isCancelled else { break }
                        let data: Data
                        switch message {
                        case .string(let text): data = Data(text.utf8)
                        default: throw PhoneError.invalidReply
                        }
                        try await receive(data, on: socket)
                        guard current == generation, !Task.isCancelled else { break }
                        if contact == "in-reach" {
                            attempt = 0; refused = 0
                            if mac.addresses.first != address {
                                mac.addresses = Array(([address] + mac.addresses.filter { $0 != address }).prefix(25))
                                onMacChanged?(mac)
                            }
                        }
                    }
                } catch {
                    guard current == generation, !Task.isCancelled else { transport.close(); return }
                    let code = connection?.closeCode.rawValue
                    let status = (connection?.response as? HTTPURLResponse)?.statusCode
                    if code == 4401 {
                        removed = true; cards = []; activity = []
                        contact = "removed"; finishLeave(); onRemoved?()
                    } else {
                        if status == 401 { refused += 1 }
                        else if status != nil { refused = 0 }
                        if refused >= 2 {
                            removed = true; cards = []; activity = []; contact = "removed"
                            finishLeave(); onRemoved?()
                        } else {
                            contact = code == 1001 ? "closed" : "lost"
                            finishLeave(PhoneError.unavailable)
                        }
                    }
                }
                transport.close()
                guard current == generation else { return }
                self.socket = nil; self.transport = nil
                if Task.isCancelled || removed || current != generation { return }
            }
            attempt = min(attempt + 1, 5)
            try? await Task.sleep(for: .seconds(attempt))
        }
    }

    private func receive(_ data: Data, on socket: URLSessionWebSocketTask) async throws {
        guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = frame["t"] as? String else { throw PhoneError.invalidReply }
        heardAt = Date()
        switch kind {
        case "welcome":
            guard let epoch = frame["epoch"] as? String, !epoch.isEmpty,
                  let seq = frame["seq"] as? Int, seq >= 0,
                  let catchUp = frame["catchUp"] as? String, ["replay", "reload"].contains(catchUp)
            else { throw PhoneError.invalidReply }
            if catchUp == "reload" { self.sequence = seq }
            self.epoch = epoch
            refused = 0
            if let name = frame["name"] as? String, !name.isEmpty {
                mac.name = name; onMacChanged?(mac)
            }
            contact = "reaching"
            try await refresh(PhoneContract.cards, on: socket)
            guard self.socket === socket, !Task.isCancelled else { return }
            try await refresh(PhoneContract.feed, on: socket)
        case "push":
            guard epoch != nil, let seq = frame["seq"] as? Int else { throw PhoneError.invalidReply }
            if seq <= sequence { return }
            guard seq == sequence + 1 else { epoch = nil; throw PhoneError.invalidReply }
            sequence = seq
            if frame["channel"] as? String == "inf:cards" {
                guard let snapshot = frame["payload"] else { throw PhoneError.invalidReply }
                cards = try JSONDecoder().decode([PhoneCard].self, from: JSONSerialization.data(withJSONObject: snapshot))
                // A later push supersedes the initial read, whose reply may still be in flight.
                if let request = pending.first(where: { $0.value == PhoneContract.cards })?.key {
                    pending.removeValue(forKey: request); waitingSince.removeValue(forKey: request)
                }
                markReady(PhoneContract.cards)
            }
            // The Mac still owns feed wording. Only types that can change it cause a read.
            if frame["channel"] as? String == "inf:event",
               let event = frame["payload"] as? [String: Any], let type = event["type"] as? String,
               FeedChange(rawValue: type) != nil,
               type != "task_event" || event["feed"] as? Bool == true {
                try await refresh(PhoneContract.feed, on: socket)
            }
        case "result":
            guard let id = frame["id"] as? Int, let channel = pending.removeValue(forKey: id)
            else { return }
            waitingSince.removeValue(forKey: id)
            guard frame["ok"] as? Bool == true, let value = frame["value"] else {
                throw PhoneError.invalidReply
            }
            let bytes = try JSONSerialization.data(withJSONObject: value)
            if channel == PhoneContract.cards { cards = try JSONDecoder().decode([PhoneCard].self, from: bytes) }
            else { activity = try JSONDecoder().decode([ActivityLine].self, from: bytes) }
            markReady(channel)
            if dirty.remove(channel) != nil { try await refresh(channel, on: socket) }
        default: break // Later envelope fields and frame kinds do not widen what this client sends.
        }
    }

    private func markReady(_ channel: String) {
        ready.insert(channel)
        if ready.count == 2 { contact = "in-reach" }
    }

    private func refresh(_ channel: String, on socket: URLSessionWebSocketTask) async throws {
        if pending.values.contains(channel) { dirty.insert(channel); return }
        nextID += 1; pending[nextID] = channel; waitingSince[nextID] = Date()
        try await send(["t": "invoke", "id": nextID, "channel": channel, "args": []], on: socket)
    }

    private func send(_ object: [String: Any], on socket: URLSessionWebSocketTask) async throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        guard let text = String(data: data, encoding: .utf8) else { throw PhoneError.invalidReply }
        try await socket.send(.string(text))
    }
}
