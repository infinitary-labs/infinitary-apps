import Foundation
import Observation

public struct ActivityLine: Decodable, Sendable {
    public let kind: String
    public let taskKey: String?
    public let text: String
    public let at: Double
}

/// One card's arrival: a new card, or its author's answer to the captain's reply.
public struct PhoneNotice: Equatable, Sendable {
    public let cardID: String
    public let title: String
    public let reply: Bool
}

/// All product content is in memory. Only the joined computer's public routing facts persist.
@MainActor @Observable public final class ReadOnlySession {
    public private(set) var mac: JoinedMac
    public private(set) var cards: [PhoneCard] = []
    public private(set) var activity: [ActivityLine] = []
    public private(set) var threads: [String: PhoneJSON] = [:]
    public private(set) var pastCards: [PhoneCard] = []
    public var showCardID: String?
    @ObservationIgnored private var threadRevisions: [String: Int] = [:]
    public private(set) var board: PhoneBoard?
    public private(set) var lastTurn: PhoneLastTurn?
    /// Only the Mac's firstmate_state event establishes an active conversational turn.
    /// The contract has no initial busy snapshot and no phone dictation/listening signal.
    public private(set) var firstmateBusy = false
    public private(set) var workRevision = 0
    public private(set) var access = "read"
    public var notice: PhoneNotice?
    /// Offers the stage has drawn while the person could see it, kept for this computer's session only.
    public private(set) var seenCards = Set<String>()
    public var unreadCards: Int { cards.filter { !seenCards.contains($0.offerID ?? $0.id) }.count }
    public var canChange: Bool { contact == "in-reach" && access == "full" }
    public var changeRefusal: String? {
        if contact != "in-reach" { return "Your computer is out of reach. Nothing will be sent later." }
        if access != "full" { return "Update Infinitary on this phone and your computer to make changes." }
        return nil
    }
    public private(set) var contact = "reaching"
    public private(set) var heardAt: Date?
    public private(set) var removed = false
    public var onMacChanged: ((JoinedMac) -> Void)?
    public var onRemoved: (() -> Void)?
    /// The Mac's first mate reacted (a firstmate_emote), heard live; a replay on reconnect is not a reaction now.
    public var onEmote: ((String) -> Void)?
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
    @ObservationIgnored private var calls: [Int: (Bool, CheckedContinuation<Data, Error>)] = [:]
    @ObservationIgnored private var notified: [String: Bool] = [:]
    @ObservationIgnored private var awaited = Set<String>()
    @ObservationIgnored private var primed = false
    private let initialReads = [PhoneContract.cards, PhoneContract.feed, PhoneRequest.board.rawValue, PhoneRequest.lastTurn.rawValue]

    /// No write is queued or retried. A lost reply is explicitly an unknown outcome.
    public func request<T: Decodable & Sendable>(_ channel: PhoneRequest, args: [Any] = [], as: T.Type = T.self) async throws -> T {
        let answer = try await invoke(channel.rawValue, changes: channel.changes, args: args)
        try Task.checkCancellation()
        do { return try JSONDecoder().decode(T.self, from: answer) }
        catch {
            if channel.changes { throw PhoneError.refused("Could not confirm the change. Check your computer before sending it again.") }
            throw PhoneError.invalidReply
        }
    }

    private func invoke(_ channel: String, changes: Bool, args: [Any]) async throws -> Data {
        guard !Task.isCancelled, contact == "in-reach", let socket, !removed else { throw PhoneError.unavailable }
        if changes, let reason = changeRefusal { throw PhoneError.refused(reason) }
        nextID += 1
        let id = nextID
        let data = try JSONSerialization.data(withJSONObject: ["t": "invoke", "id": id, "channel": channel, "args": args])
        guard data.count <= PhoneContract.maxFrameBytes, let text = String(data: data, encoding: .utf8) else { throw PhoneError.invalidReply }
        let answer: Data = try await withCheckedThrowingContinuation { continuation in
            calls[id] = (changes, continuation); waitingSince[id] = Date()
            Task {
                do { try await socket.send(.string(text)) }
                catch { self.failCall(id) }
            }
        }
        return answer
    }

    public func ask(_ channel: PhoneCardRequest, _ args: [PhoneJSON]) async throws -> PhoneJSON {
        let answer = try await invoke(channel.rawValue, changes: channel.changes, args: args.map { try $0.foundation })
        try Task.checkCancellation()
        do { return try JSONDecoder().decode(PhoneJSON.self, from: answer) }
        catch {
            if channel.changes { throw PhoneError.refused("Could not confirm the change. Check your computer before sending it again.") }
            throw PhoneError.invalidReply
        }
    }

    public func readThread(_ id: String) async throws {
        let revision = threadRevisions[id, default: 0]
        let thread = try await ask(.thread, [.string(id)])
        if revision == threadRevisions[id, default: 0] { threads[id] = thread }
    }

    public func readPast(_ id: String) async throws {
        let result = try await ask(.past, [.string(id)])
        guard result != .null else { return }
        let card = try PhoneCard(result)
        pastCards.removeAll { $0.id == id }; pastCards.insert(card, at: 0)
    }

    private func failCall(_ id: Int) {
        waitingSince.removeValue(forKey: id)
        guard let (changes, continuation) = calls.removeValue(forKey: id) else { return }
        continuation.resume(throwing: changes
            ? PhoneError.refused("Could not confirm the change. Check your computer before sending it again.")
            : PhoneError.unavailable)
    }
    private func failCalls() { for id in Array(calls.keys) { failCall(id) } }

    private func clearContent() {
        cards = []; activity = []; board = nil; lastTurn = nil; notice = nil; firstmateBusy = false
        threads = [:]; pastCards = []; showCardID = nil; threadRevisions = [:]; seenCards = []
        notified = [:]; awaited = []; primed = false; workRevision += 1
    }

    /// Reading a card ends the notice about it.
    public func markSeen(_ card: PhoneCard) {
        seenCards.insert(card.offerID ?? card.id)
        if notice?.cardID == card.id { notice = nil }
    }

    private func observeCards(_ snapshot: [PhoneCard]) {
        let live = snapshot.filter { $0.awaiting == nil || $0.sentBackAt != nil }
        let news = live.filter { primed && (notified[$0.id] == nil || (notified[$0.id] == true && $0.awaiting == nil)) }
        // A card that waited on its author after the captain's reply returns as a reply: one the stage
        // kept while it waited, or one that left the stage and was awaiting the answer.
        let reply = news.last.map { notified[$0.id] == true || awaited.contains($0.id) } ?? false
        notified = Dictionary(uniqueKeysWithValues: live.map { ($0.id, $0.awaiting != nil) })
        awaited = Set(snapshot.filter { $0.awaiting == "answer" || ($0.awaiting != nil && awaited.contains($0.id)) }.map(\.id))
        primed = true
        guard let newest = news.last, contact == "in-reach" else { return }
        let current = generation
        Task {
            let enabled = try? await request(.notifications, as: Bool.self)
            guard enabled == true, current == generation, contact == "in-reach" else { return }
            // A new card the stage drew while this question was out is already read.
            if !reply && seenCards.contains(newest.offerID ?? newest.id) { return }
            notice = PhoneNotice(cardID: newest.id, title: newest.title, reply: reply)
        }
    }

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
        failCalls(); notice = nil; access = "read"; firstmateBusy = false
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
                    failCalls()
                    pending.removeAll(); waitingSince.removeAll(); dirty.removeAll(); ready.removeAll()
                    access = "read"; firstmateBusy = false
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
                        removed = true; clearContent()
                        contact = "removed"; finishLeave(); onRemoved?()
                    } else {
                        if status == 401 { refused += 1 }
                        else if status != nil { refused = 0 }
                        if refused >= 2 {
                            removed = true; clearContent(); contact = "removed"
                            finishLeave(); onRemoved?()
                        } else {
                            contact = code == 1001 ? "closed" : "lost"
                            finishLeave(PhoneError.unavailable)
                        }
                    }
                }
                failCalls(); firstmateBusy = false
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
            if catchUp == "reload" { self.sequence = seq; primed = false; notified = [:]; awaited = [] }
            access = frame["access"] as? String == "full" ? "full" : "read"
            self.epoch = epoch
            refused = 0
            if let name = frame["name"] as? String, !name.isEmpty {
                mac.name = name; onMacChanged?(mac)
            }
            contact = "reaching"
            for channel in initialReads {
                guard self.socket === socket, !Task.isCancelled else { return }
                try await refresh(channel, on: socket)
            }
        case "push":
            guard epoch != nil, let seq = frame["seq"] as? Int else { throw PhoneError.invalidReply }
            if seq <= sequence { return }
            guard seq == sequence + 1 else { epoch = nil; throw PhoneError.invalidReply }
            sequence = seq
            if frame["channel"] as? String == "inf:cards" {
                guard let snapshot = frame["payload"] else { throw PhoneError.invalidReply }
                let updated = try JSONDecoder().decode([PhoneCard].self, from: JSONSerialization.data(withJSONObject: snapshot))
                let departed = cards.filter { old in !updated.contains { $0.id == old.id } }.map(\.id)
                cards = updated
                for id in departed { Task { try? await self.readPast(id) } }
                observeCards(cards)
                supersede(PhoneContract.cards)
            }
            if frame["channel"] as? String == "inf:tasks", let payload = frame["payload"] {
                board = try JSONDecoder().decode(PhoneBoard.self, from: JSONSerialization.data(withJSONObject: payload))
                supersede(PhoneRequest.board.rawValue); workRevision += 1
            }
            // A full read is also the contract's resync path for a delta we cannot apply.
            if frame["channel"] as? String == "inf:tasks:delta" {
                try await refresh(PhoneRequest.board.rawValue, on: socket)
            }
            if frame["channel"] as? String == "inf:event", let event = frame["payload"] as? [String: Any], let type = event["type"] as? String {
                if type == "firstmate_state", let busy = event["busy"] as? Bool { firstmateBusy = busy }
                if type == "firstmate_emote", contact == "in-reach", let emote = event["emote"] as? String { onEmote?(emote) }
                if type == "user_turn" || type == "firstmate_reply" {
                    try await refresh(PhoneRequest.lastTurn.rawValue, on: socket)
                }
                if ["task_changed", "task_event", "turn_end", "tool_execution_end"].contains(type) { workRevision += 1 }
            }
            if frame["channel"] as? String == "inf:cards:thread", let payload = frame["payload"] {
                let thread = try PhoneJSON.read(payload)
                if let id = thread["cardId"].text {
                    threadRevisions[id, default: 0] += 1
                    threads[id] = thread
                }
            }
            if frame["channel"] as? String == "inf:event", let event = frame["payload"] as? [String: Any],
               let id = event["cardId"] as? String {
                if event["type"] as? String == "past_card_shown" {
                    Task { try? await self.readPast(id); self.showCardID = id }
                } else if event["type"] as? String == "open_card_shown" { showCardID = id }
            }
            // The Mac still owns feed wording. Only types that can change it cause a read.
            if frame["channel"] as? String == "inf:event",
               let event = frame["payload"] as? [String: Any], let type = event["type"] as? String,
               FeedChange(rawValue: type) != nil,
               type != "task_event" || event["feed"] as? Bool == true {
                try await refresh(PhoneContract.feed, on: socket)
            }
        case "result":
            guard let id = frame["id"] as? Int else { throw PhoneError.invalidReply }
            if let (_, continuation) = calls.removeValue(forKey: id) {
                waitingSince.removeValue(forKey: id)
                if frame["ok"] as? Bool == true, let value = frame["value"] {
                    do { continuation.resume(returning: try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)) }
                    catch { continuation.resume(throwing: PhoneError.invalidReply) }
                } else {
                    continuation.resume(throwing: PhoneError.refused((frame["error"] as? [String: Any])?["message"] as? String ?? frame["error"] as? String ?? "Your computer refused this request."))
                }
                return
            }
            guard let channel = pending.removeValue(forKey: id) else { return }
            waitingSince.removeValue(forKey: id)
            guard frame["ok"] as? Bool == true, let value = frame["value"] else {
                throw PhoneError.invalidReply
            }
            let bytes = try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
            switch channel {
            case PhoneContract.cards: cards = try JSONDecoder().decode([PhoneCard].self, from: bytes); observeCards(cards)
            case PhoneContract.feed: activity = try JSONDecoder().decode([ActivityLine].self, from: bytes)
            case PhoneRequest.board.rawValue: board = try JSONDecoder().decode(PhoneBoard.self, from: bytes); workRevision += 1
            case PhoneRequest.lastTurn.rawValue: lastTurn = try JSONDecoder().decode(PhoneLastTurn?.self, from: bytes)
            default: break
            }
            markReady(channel)
            if dirty.remove(channel) != nil { try await refresh(channel, on: socket) }
        default: break // Later envelope fields and frame kinds do not widen what this client sends.
        }
    }

    private func supersede(_ channel: String) {
        if let id = pending.first(where: { $0.value == channel })?.key {
            pending.removeValue(forKey: id); waitingSince.removeValue(forKey: id)
        }
        markReady(channel)
    }

    private func markReady(_ channel: String) {
        ready.insert(channel)
        if initialReads.allSatisfy({ ready.contains($0) }) { contact = "in-reach" }
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
