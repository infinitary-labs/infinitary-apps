import Foundation
import Network

/// A sign-in page the computer would open for its view (`inf:app:sign-in-page`): the page, the return's id, and the
/// port of the computer's own loopback address the page sends the browser back to (docs/ios.md, "Google in Settings").
public struct PhoneSignInPage: Sendable, Equatable {
    public let url: URL
    public let id: String
    public let port: UInt16

    public init(url: URL, id: String, port: UInt16) { self.url = url; self.id = id; self.port = port }

    init?(_ payload: Any?) {
        guard let fields = payload as? [String: Any], let address = fields["url"] as? String,
              let url = URL(string: address), ["https", "http"].contains(url.scheme ?? ""),
              let id = fields["id"] as? String, !id.isEmpty,
              let port = fields["port"] as? Int, (1...65535).contains(port) else { return nil }
        self.init(url: url, id: id, port: UInt16(port))
    }
}

/// What the waiting sign-in answered the browser: its status and its page.
public struct PhoneSignInAnswer: Decodable, Sendable, Equatable {
    public let status: Int
    public let page: String
    public init(status: Int, page: String) { self.status = status; self.page = page }
}

/// Listens on this device's own loopback address, at the port the sign-in's page sends the browser back to, and
/// passes what the browser asked to the computer, answering the browser with the page the computer said. Only GET is
/// passed on, and only while the sign-in waits; the computer hands it once to its own waiting sign-in.
public final class PhoneSignInReturnListener: @unchecked Sendable {
    public typealias HandBack = @Sendable (String) async -> PhoneSignInAnswer

    private let listener: NWListener
    private let handBack: HandBack
    private let queue = DispatchQueue(label: "infinitary.sign-in-return")

    private init(listener: NWListener, handBack: @escaping HandBack) {
        self.listener = listener; self.handBack = handBack
    }

    /// Listens on `port`, or answers nil when this device cannot: the port is taken, or the system refused.
    public static func start(port: UInt16, host: String = "127.0.0.1", handBack: @escaping HandBack) async -> PhoneSignInReturnListener? {
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else { return nil }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: endpointPort)
        parameters.allowLocalEndpointReuse = false
        guard let listener = try? NWListener(using: parameters) else { return nil }
        let returned = PhoneSignInReturnListener(listener: listener, handBack: handBack)
        let ready: Bool = await withCheckedContinuation { continuation in
            let once = Once()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: once.run { continuation.resume(returning: true) }
                case .failed, .cancelled, .waiting: once.run { continuation.resume(returning: false) }
                default: break
                }
            }
            listener.newConnectionHandler = { [weak returned] connection in returned?.serve(connection) }
            listener.start(queue: returned.queue)
        }
        if !ready { listener.cancel(); return nil }
        return returned
    }

    public func stop() { listener.cancel() }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, Data())
    }

    /// Reads the request's head, at most 16 KB; its body, if any, is never read.
    private func read(_ connection: NWConnection, _ head: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, done, error in
            guard let self else { connection.cancel(); return }
            var head = head
            if let data { head.append(data) }
            if let end = head.range(of: Data("\r\n\r\n".utf8)) { // i18n-exempt: the HTTP head's end, not words
                self.answer(connection, String(decoding: head[..<end.lowerBound], as: UTF8.self))
            } else if error != nil || done || head.count >= 16 * 1024 {
                connection.cancel()
            } else {
                self.read(connection, head)
            }
        }
    }

    private func answer(_ connection: NWConnection, _ head: String) {
        let line = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
        let parts = line.split(separator: " ")
        guard parts.count == 3, parts[0] == "GET", parts[1].hasPrefix("/") else {
            send(connection, PhoneSignInAnswer(status: 405, page: ""))
            return
        }
        let path = String(parts[1])
        let handBack = handBack
        Task { [weak self] in
            let answer = await handBack(path)
            self?.send(connection, answer)
        }
    }

    private func send(_ connection: NWConnection, _ answer: PhoneSignInAnswer) {
        let body = Data(answer.page.utf8)
        // i18n-exempt: HTTP status phrases, not shown
        let reason = answer.status == 200 ? "OK" : answer.status == 405 ? "Method Not Allowed" : "Not OK"
        let head = "HTTP/1.1 \(answer.status) \(reason)\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: \(body.count)\r\nconnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
    }
}

/// Runs its work once, from whichever thread asks first.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func run(_ work: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard !done else { return }
        done = true; work()
    }
}
