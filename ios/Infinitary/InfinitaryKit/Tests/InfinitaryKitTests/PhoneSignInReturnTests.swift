import Darwin
import Foundation
import Testing
@testable import InfinitaryKit

/// INF-3454's phone part, the captain's choice how=catch: "Catch it in the app, with pasting the address as the
/// fallback, like the computers". The listener is the real one on this computer's loopback address; the browser is
/// URLSession; the computer it hands the return to is a stand-in that records what it was given.
@Suite struct PhoneSignInReturnTests {
    @Test func handsTheBrowsersReturnToTheComputerAndAnswersItsPage() async throws {
        let port = try freePort()
        let given = Given()
        let listener = try #require(await PhoneSignInReturnListener.start(port: port) { path in
            await given.add(path)
            return PhoneSignInAnswer(status: 200, page: "<p>Signed in to Google</p>")
        })
        defer { listener.stop() }
        let (body, response) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/?state=s1&code=4%2F0Aan&scope=email")!)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect(String(decoding: body, as: UTF8.self) == "<p>Signed in to Google</p>")
        #expect(await given.paths == ["/?state=s1&code=4%2F0Aan&scope=email"])
    }

    @Test func passesOnTheComputersRefusal() async throws {
        let port = try freePort()
        let listener = try #require(await PhoneSignInReturnListener.start(port: port) { _ in
            PhoneSignInAnswer(status: 404, page: "<p>Not this sign-in's return</p>")
        })
        defer { listener.stop() }
        let (_, response) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/?state=other&code=c")!)
        #expect((response as? HTTPURLResponse)?.statusCode == 404)
    }

    @Test func refusesAnythingButGetAndPassesNothingOn() async throws {
        let port = try freePort()
        let given = Given()
        let listener = try #require(await PhoneSignInReturnListener.start(port: port) { path in
            await given.add(path)
            return PhoneSignInAnswer(status: 200, page: "")
        })
        defer { listener.stop() }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/?state=s&code=c")!)
        request.httpMethod = "POST"
        request.httpBody = Data("code=c".utf8)
        let (_, response) = try await URLSession.shared.data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 405)
        #expect(await given.paths.isEmpty)
    }

    /// A port something else on this device already listens on: no listener, so the row asks for the address.
    @Test func answersNothingWhenThePortIsTaken() async throws {
        let held = try listeningSocket()
        defer { close(held.socket) }
        let listener = await PhoneSignInReturnListener.start(port: held.port) { _ in PhoneSignInAnswer(status: 200, page: "") }
        #expect(listener == nil)
        listener?.stop()
    }
}

private actor Given {
    var paths: [String] = []
    func add(_ path: String) { paths.append(path) }
}

private struct SocketError: Error {}

/// A loopback socket listening on a port the system chose, as another program holding that port would.
private func listeningSocket() throws -> (socket: Int32, port: UInt16) {
    let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard socket >= 0 else { throw SocketError() }
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    address.sin_port = 0
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafeMutablePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
            bind(socket, pointer, length) == 0 && listen(socket, 1) == 0 && getsockname(socket, pointer, &length) == 0
        }
    }
    guard bound else { close(socket); throw SocketError() }
    return (socket, UInt16(bigEndian: address.sin_port))
}

/// A port free now: one the system chose, given back.
private func freePort() throws -> UInt16 {
    let held = try listeningSocket()
    close(held.socket)
    return held.port
}
