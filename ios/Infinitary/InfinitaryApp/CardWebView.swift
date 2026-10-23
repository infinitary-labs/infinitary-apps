import CryptoKit
import InfinitaryKit
import Observation
import SwiftUI
@preconcurrency import WebKit

/// A separate, nonpersistent web process holds only the shown card. No account or Mac URL enters it.
@MainActor @Observable final class CardWebHost: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    var height: CGFloat = 48
    var drawn = false
    var busy = false
    var chosen = false
    var changing: Bool { busy || chosen }
    var failure: String?
    var reading: PhoneJSON = .object(["answers": .array([])])
    var presentation: PhoneJSON?
    var notice: String?
    private(set) var card: PhoneCard
    private let session: ReadOnlySession
    private var view: WKWebView?
    private var assets: CardAssets?
    private var watchdog: Task<Void, Never>?
    private var collection: (id: UUID, continuation: CheckedContinuation<PhoneJSON, Error>)?
    private var collectionTimeout: Task<Void, Never>?
    private var sent = 0
    private var heard = 0
    private var missed = 0
    private var theme = "light"
    private let fill: PhoneJSON
    var onReading: ((PhoneJSON) -> Void)?
    var onDrawn: (() -> Void)?

    init(card: PhoneCard, session: ReadOnlySession, fill: PhoneJSON) {
        self.card = card; self.session = session; self.fill = fill
    }

    func makeView(theme: String) -> WKWebView {
        self.theme = theme
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.allowsInlineMediaPlayback = true
        let assets = CardAssets(session: session)
        self.assets = assets
        configuration.setURLSchemeHandler(assets, forURLScheme: "app-frame")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "cardHost")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsLinkPreview = false
        view.navigationDelegate = self; view.uiDelegate = self
        view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.backgroundColor = .clear
        // INF-944 items 1 and 2: the card's native scroller is the only one. The web view is always as tall as its
        // body, takes no safe-area insets of its own and cannot be zoomed, so it never scrolls inside the card.
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.minimumZoomScale = 1; view.scrollView.maximumZoomScale = 1
        view.scrollView.pinchGestureRecognizer?.isEnabled = false
        view.accessibilityIdentifier = "card-body"
        self.view = view
        // Agent HTML is assigned to an opaque iframe's srcdoc, never interpolated into this parent.
        // Its own hash policy narrows this parent's inline permission. Neither realm can use the network.
        view.loadHTMLString("""
        <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' app-frame://runtime; style-src 'unsafe-inline'; frame-src about:; img-src data: app-frame:; font-src app-frame:; base-uri 'none'; form-action 'none'">
        <style>html,body{margin:0;padding:0;background:transparent}iframe{width:100%;border:0}</style>
        <script src="app-frame://runtime/CardHost.generated.js"></script></head><body></body></html>
        """, baseURL: nil)
        watchdog = Task { [weak self] in
            var answered = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                // INF-804: only a shown card can stall. WebKit pauses a card behind another tab or in the background,
                // and a page still loading is WebKit starting the card's own process, which a busy device can take a while to do.
                guard UIApplication.shared.applicationState == .active, let page = self.view, page.window != nil, !page.isLoading
                else { self.missed = 0; continue }
                // A stall is a card that answered nothing since the last look; a slow answer is still an answer.
                if (self.drawn && self.heard >= self.sent) || self.heard > answered { self.missed = 0 } else { self.missed += 1 }
                answered = self.heard
                if self.missed >= 3 { self.fail(); return }
                self.sent += 1
                page.evaluateJavaScript("window.phoneCard?.ping(\(self.sent))", completionHandler: nil)
            }
        }
        return view
    }

    func close() {
        watchdog?.cancel(); watchdog = nil
        if let id = collection?.id { finishCollection(id, .failure(PhoneRequestError("This card did not answer. Your choice was not sent."))) }
        onReading = nil; onDrawn = nil
        view?.configuration.userContentController.removeScriptMessageHandler(forName: "cardHost", contentWorld: .page)
        assets?.cancel(); assets = nil
        view?.stopLoading(); view?.navigationDelegate = nil; view?.uiDelegate = nil; view = nil
    }
    private func fail() { failure = "This card stopped responding."; close() }

    func updateTheme(_ theme: String) {
        guard theme != self.theme else { return }
        self.theme = theme
        view?.evaluateJavaScript("window.phoneCard?.theme('\(theme == "dark" ? "dark" : "light")')", completionHandler: nil)
    }

    func beginChange() -> Bool {
        guard !changing, session.canChange else { return false }
        busy = true
        return true
    }

    /// A failed body may use its last observed draft, never label it as a fresh reading.
    /// A timeout during this press still refuses it; only a later deliberate press takes this fallback.
    func submissionReading() async throws -> (value: PhoneJSON, fresh: Bool) {
        if failure != nil, reading["of"].numeric != nil { return (reading, false) }
        return (try await collect(), true)
    }

    func collect() async throws -> PhoneJSON {
        guard drawn, let view, failure == nil, collection == nil else { throw PhoneRequestError("This card is not ready. Your choice was not sent.") }
        return try await withCheckedThrowingContinuation { continuation in
            let id = UUID()
            collection = (id, continuation)
            // The JavaScript timeout cannot run if the web process is stalled. Native chrome must still recover.
            collectionTimeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { return }
                self?.finishCollection(id, .failure(PhoneRequestError("This card did not answer. Your choice was not sent.")))
            }
            view.callAsyncJavaScript("return await window.phoneCard.collect()", arguments: [:], in: nil, in: .page) { [weak self] result in
                do { self?.finishCollection(id, .success(try PhoneJSON.read(result.get()))) }
                catch { self?.finishCollection(id, .failure(PhoneRequestError("This card did not answer. Your choice was not sent."))) }
            }
        }
    }
    private func finishCollection(_ id: UUID, _ result: Result<PhoneJSON, Error>) {
        guard let pending = collection, pending.id == id else { return }
        collection = nil; collectionTimeout?.cancel(); collectionTimeout = nil
        pending.continuation.resume(with: result)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let effectIDs = Set(card.actions.filter { $0["effect"] != .null }.compactMap { $0["id"].text })
        let actions = card.actions.compactMap { action -> PhoneJSON? in
            guard let id = action["id"].text, !effectIDs.contains(id) else { return nil }; return .string(id)
        }
        let input: PhoneJSON = .object(["body": .string(card.body), "theme": .string(theme), "readOnly": .bool(card.isPast),
            "fill": fill, "actions": .array(actions), "width": card.value["width"] == .null ? .string("wide") : card.value["width"]])
        do {
            webView.callAsyncJavaScript("await window.phoneCard.mount(input)", arguments: ["input": try input.foundation], in: nil, in: .page) { [weak self] result in
                if case .failure = result { self?.fail() }
            }
        } catch { fail() }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        // The opaque child can see WebKit's handler too. It may NEVER call the native host directly.
        guard message.frameInfo.isMainFrame, message.webView === view,
              let payload = try? PhoneJSON.read(message.body), let type = payload["type"].text else {
            replyHandler(nil, "This frame has no native access."); return
        }
        switch type {
        case "hash":
            let scripts = payload["scripts"].list.compactMap(\.text)
            guard scripts.reduce(0, { $0 + $1.utf8.count }) <= 262_144 else { replyHandler(nil, "The card is too large."); return }
            replyHandler(scripts.map { "sha256-" + Data(SHA256.hash(data: Data($0.utf8))).base64EncodedString() }, nil)
        case "answers":
            reading = payload["reading"]; onReading?(reading); replyHandler(true, nil)
        case "drawn":
            height = max(48, min(100_000, payload["height"].numeric ?? 48))
            if !drawn { drawn = true; onDrawn?() }
            replyHandler(true, nil)
        case "pong": heard = Int(payload["seq"].numeric ?? 0); replyHandler(true, nil)
        case "mac-only": notice = "Do this on \(session.mac.name)."; replyHandler(true, nil)
        case "image", "demo": presentation = payload; replyHandler(true, nil)
        case "action":
            guard !card.isPast, let id = payload["id"].text,
                  card.actions.contains(where: { $0["id"].text == id }),
                  !card.actions.contains(where: { $0["id"].text == id && $0["effect"] != .null }) else {
                replyHandler(nil, "Only the card’s own footer can do that."); return
            }
            guard beginChange() else {
                let words = session.changeRefusal ?? "This card already has a choice in progress."
                notice = words; replyHandler(nil, words); return
            }
            Task {
                defer { busy = false }
                do {
                    let result = try await session.ask(.act, [.string(card.id), .string(id), .string("frame"), payload["value"], card.submission()])
                    if let refusal = result["refusal"].text { throw PhoneRequestError(refusal) }
                    chosen = true
                    replyHandler(try result.foundation, nil)
                } catch { notice = error.localizedDescription; replyHandler(nil, error.localizedDescription) }
            }
        default: replyHandler(nil, "This card cannot do that.")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url?.absoluteString ?? ""
        // Only the initial parent and its one srcdoc child. Even a meta refresh cannot leave the page.
        decisionHandler((url == "about:blank" || url == "about:srcdoc") && navigationAction.navigationType == .other ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
}

struct CardWebView: UIViewRepresentable {
    let host: CardWebHost
    @Environment(\.colorScheme) private var scheme
    func makeUIView(context: Context) -> WKWebView { host.makeView(theme: scheme == .dark ? "dark" : "light") }
    func updateUIView(_ view: WKWebView, context: Context) { host.updateTheme(scheme == .dark ? "dark" : "light") }
    static func dismantleUIView(_ view: WKWebView, coordinator: ()) {
        (view.navigationDelegate as? CardWebHost)?.close()
    }
}

/// A closed file-name namespace, served from the bundle or pinned connection, never a path or URL fetch.
@MainActor final class CardAssets: NSObject, WKURLSchemeHandler {
    private let session: ReadOnlySession
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var cache: [String: (Data, String)] = [:]
    init(session: ReadOnlySession) { self.session = session }
    func cancel() { for task in tasks.values { task.cancel() }; tasks.removeAll(); cache.removeAll() }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        tasks[key] = Task {
            do {
                guard let url = urlSchemeTask.request.url, urlSchemeTask.request.httpMethod == "GET" else { throw PhoneError.invalidReply }
                let (data, type) = try await load(url)
                guard !Task.isCancelled, tasks[key] != nil else { return }
                let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                    "Content-Type": type, "Content-Length": String(data.count), "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff",
                ])!
                urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
            } catch {
                if !Task.isCancelled, tasks[key] != nil { urlSchemeTask.didFailWithError(error) }
            }
            tasks.removeValue(forKey: key)
        }
    }
    func load(_ url: URL) async throws -> (Data, String) {
        if let cached = cache[url.absoluteString] { return cached }
        guard url.scheme == "app-frame", url.user == nil, url.password == nil, url.port == nil,
              url.query == nil, url.fragment == nil, url.pathComponents.count == 2 else { throw PhoneError.invalidReply }
        let name = url.lastPathComponent
        let result: (Data, String)
        if url.host == "runtime", name == "CardHost.generated.js" {
            guard let file = Bundle.main.url(forResource: "CardHost.generated", withExtension: "js") else { throw PhoneError.invalidReply }
            result = (try Data(contentsOf: file), "text/javascript")
        } else if url.host == "fonts", name.range(of: "^[a-z0-9-]+\\.woff2$", options: .regularExpression) != nil {
            guard let file = Bundle.main.url(forResource: String(name.dropLast(6)), withExtension: "woff2") else { throw PhoneError.invalidReply }
            result = (try Data(contentsOf: file), "font/woff2")
        } else {
            let kind: PhoneCardRequest
            let extensions: String
            switch url.host {
            case "images": kind = .picture; extensions = "png|jpg|webp"
            case "typefaces": kind = .typeface; extensions = "woff2|woff|ttf|otf"
            case "media": kind = .media; extensions = "mp4|gif"
            default: throw PhoneError.invalidReply
            }
            guard name.range(of: "^[A-Za-z0-9_-]{1,64}-[0-9a-f]{32}\\.(\(extensions))$", options: .regularExpression) != nil else { throw PhoneError.invalidReply }
            var bytes = Data()
            var contentType = ""
            if kind == .media {
                var size = 1
                while bytes.count < size {
                    try Task.checkCancellation()
                    let part = try await session.read(.media, [.string(name), .number(Double(bytes.count)), .number(1_048_576)])
                    guard let total = part["size"].numeric, total > 0, total <= 16 * 1024 * 1024,
                          let data = Data(base64Encoded: part["data"].text ?? ""), !data.isEmpty else { throw PhoneError.invalidReply }
                    if bytes.count > 0 && size != Int(total) { throw PhoneError.invalidReply }
                    size = Int(total); bytes.append(data); contentType = part["contentType"].text ?? ""
                    guard bytes.count <= size else { throw PhoneError.invalidReply }
                }
            } else {
                let file = try await session.read(kind, [.string(name)])
                guard let data = Data(base64Encoded: file["data"].text ?? ""), data.count <= 8 * 1024 * 1024 else { throw PhoneError.invalidReply }
                bytes = data; contentType = file["contentType"].text ?? ""
            }
            result = (bytes, contentType)
        }
        if cache.values.reduce(0, { $0 + $1.0.count }) + result.0.count <= 32 * 1024 * 1024 { cache[url.absoluteString] = result }
        return result
    }
}
