import CryptoKit
import InfinitaryKit
import Observation
import SwiftUI
@preconcurrency import WebKit

/// INF-3830 piece 2: one of the captain's panels, drawn on the phone (docs/ios.md, "Panels"). A separate, nonpersistent
/// web process holds a trusted parent page (`PanelHost.generated.js`, built from ios/Infinitary/CardRuntime/panelHost.ts),
/// which frames the panel's own code in a sandboxed frame at its own host. Native code serves that frame only the
/// panel's own files and the library they were built for, each pinned in its import map, and passes the parent page's
/// asks to the computer only on the channels `PhonePanelRequest` lists. Neither realm reaches the network.
/// Piece 3: the same host draws one of the panel's cards on Home (`card`), and both pages' card actions and pointing
/// reach the panels model through `onCards` and `onPoint`, which hold the cards and open the task.
@MainActor @Observable final class PanelWebHost: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    enum Stand: Equatable {
        case loading
        case drawn
        /// Its files could not be used: the sentence after "This panel could not be opened."
        case couldNotOpen(String)
        /// Its page stopped answering, or its process ended.
        case unresponsive
    }

    private(set) var stand: Stand = .loading
    /// The height its content asks for, in points; a fill panel takes the column's room instead. Until it reports one,
    /// the view keeps the card frame's starting height, so WebKit never treats the frame as out of sight before it draws.
    private(set) var contentHeight: CGFloat = 48
    /// A panel whose own code decides whether it shows (`rail.show`) hides until it says so.
    private(set) var decidedShown = false
    /// Counts the panel's pages, so the column makes a new view for a remounted one.
    private(set) var generation = 0
    private(set) var panel: PhonePanel
    /// Set when this page draws one of the panel's cards on Home.
    private(set) var card: PhonePanelCardEntry?
    /// The page's card actions (`cards.emit`, `cards.close`, `cards.open`, `card.keep`), answered by the panels model.
    var onCards: ((PhoneJSON) throws(PhoneRequestError) -> PhoneJSON)?
    /// The page's pointing at a task or a card, answered by the panels model with whether it happened.
    var onPoint: ((PhoneJSON) -> Bool)?
    private let session: ReadOnlySession
    private let library: (String) async throws(PhonePanelFailure) -> PhonePanelLibrary
    /// One of the app's own panels' files by id and version, kept on the device (`PhonePanelsModel.appFiles`).
    private let appFiles: (String, String) async throws(PhonePanelFailure) -> PhonePanelFiles
    private let mount = (0..<16).map { _ in String("0123456789abcdef".randomElement()!) }.joined()
    private var view: WKWebView?
    /// INF-1208's direction C: a field in the page holds the software keyboard, so a foldable's pages bring the panel
    /// above the fold while it types (`phonePanelField`).
    private(set) var typing = false
    private var assets: PanelAssets?
    private var loading: Task<Void, Never>?
    private var input: PhoneJSON?
    private var theme = "light"
    /// The device's Text Size as a factor of the Mac's sizes (`PhoneTextSize`), which the page draws the panel at.
    private var textScale = 1.0
    private var collapsed: Bool
    private var shown = false
    /// The presses of its header buttons that ask the panel, counted per button.
    private var asks: [String: Int] = [:]
    /// This page was mounted again on its own after a stop: a second stop shows Retry (the desktop's FrameMount, INF-936).
    /// It clears on Retry and once the page has answered as many pings in a row as a stop misses (INF-3798).
    private var reloaded = false

    init(panel: PhonePanel, card: PhonePanelCardEntry? = nil, session: ReadOnlySession, collapsed: Bool,
         appFiles: @escaping (String, String) async throws(PhonePanelFailure) -> PhonePanelFiles,
         library: @escaping (String) async throws(PhonePanelFailure) -> PhonePanelLibrary) {
        self.panel = panel; self.card = card; self.session = session; self.collapsed = collapsed
        self.appFiles = appFiles; self.library = library
    }

    /// The panel's one view: made the first time it is asked for, then the same view.
    func makeView(theme: String) -> WKWebView {
        if let view { updateTheme(theme); return view }
        self.theme = theme
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let assets = PanelAssets(mount: mount)
        self.assets = assets
        configuration.setURLSchemeHandler(assets, forURLScheme: "app-frame")
        // Through a weak proxy: WebKit keeps its handler, so the host itself would keep its own page alive after the column lets it go.
        configuration.userContentController.addScriptMessageHandler(PanelHostHandler(self), contentWorld: .page, name: "panelHost")
        let view = PanelPageView(frame: .zero, configuration: configuration)
        view.onTyping = { [weak self] typing in self?.typing = typing }
        view.allowsLinkPreview = false
        view.navigationDelegate = self; view.uiDelegate = self
        view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.backgroundColor = .clear
        // The column's scroller is the only one: a content panel is as tall as it draws, a fill panel scrolls inside itself.
        view.scrollView.isScrollEnabled = false
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.minimumZoomScale = 1; view.scrollView.maximumZoomScale = 1
        view.accessibilityIdentifier = card.map { "panel-card-body-\(panel.id)-\($0.id)" } ?? "panel-body-\(panel.id)"
        // INF-1337: the column's scroller moves this whole view with the finger, which the page cannot tell.
        view.addGestureRecognizer(PressMoveWatch { [weak self] in self?.pressMoved() })
        self.view = view
        load()
        return view
    }

    /// Reads the panel's files and its library, then loads the parent page, which mounts it once loaded.
    private func load() {
        loading?.cancel()
        stand = .loading
        let panel = panel
        let card = card
        loading = Task { [weak self] in
            guard let self else { return }
            do throws(PhonePanelFailure) {
                guard let version = panel.frame?.version else { throw .notServed }
                let files: PhonePanelFiles
                if panel.isApp { files = try await appFiles(panel.id, version) } else {
                    let answer: PhoneJSON
                    do {
                        answer = try await session.panelAsk(.pluginsFiles, [.object([
                            "source": .string(panel.filesSource), "id": .string(panel.id), "version": .string(version),
                        ])])
                    } catch { throw .unreadable }
                    files = try PhonePanelFiles.read(answer)
                }
                let library = try await self.library(files.builtFor)
                guard !Task.isCancelled else { return }
                assets?.serve(library: library.files, files: files.files)
                var fields: [String: PhoneJSON] = [
                    "mount": .string(mount),
                    "panel": .object([
                        "id": .string(panel.id), "source": .string(panel.filesSource), "title": .string(panel.title),
                        "size": .string(panel.size), "reads": .array(panel.reads.map(PhoneJSON.string)),
                        "sql": .array(panel.sql.map(PhoneJSON.string)), "moves": .bool(panel.moves),
                        "server": .bool(panel.server != nil), "decides": .bool(panel.ownPresence),
                    ]),
                    "lib": .object(library.files.mapValues { .string($0.integrity) }),
                    "files": .object(files.files.mapValues { .string($0.integrity) }),
                    "cardViews": .array((panel.cardViews ?? []).map(PhoneJSON.string)),
                ]
                if let card {
                    fields["card"] = .object([
                        "id": .string(card.id), "view": .string(card.view), "title": .string(card.title), "height": .string(card.height),
                        "data": card.data, "kept": card.kept, "revision": .number(Double(card.revision)),
                    ])
                }
                input = .object(fields)
                view?.loadHTMLString(Self.page, baseURL: nil)
            } catch {
                guard !Task.isCancelled else { return }
                stand = .couldNotOpen(error.sentence)
            }
        }
    }

    /// The parent page: it runs only the bundled runtime and frames only the panel's own host.
    private static let page = """
    <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src app-frame://runtime; style-src 'unsafe-inline'; frame-src app-frame:; base-uri 'none'; form-action 'none'">
    <style>html,body{margin:0;padding:0;background:transparent;height:100%}</style>
    <script src="app-frame://runtime/PanelHost.generated.js"></script></head><body></body></html>
    """

    /// The panel's own Try again after its page stopped: a fresh page, from the files read again.
    func retry() {
        reloaded = false
        remount()
    }

    private func remount() {
        close()
        generation += 1
    }

    /// Its page stopped answering or its process ended: the first stop after a start mounts it again on its own, as
    /// the desktop does, since iOS ends a page's process out of sight; a second shows Retry.
    private func stopped() {
        if reloaded { stand = .unresponsive; return }
        reloaded = true
        remount()
    }

    /// The panel changed on the computer (a new version, a stop): a new version draws from its own files.
    func update(_ next: PhonePanel) {
        let reload = next.frame != panel.frame
        panel = next
        if reload { remount() }
    }

    func close() {
        loading?.cancel(); loading = nil
        view?.configuration.userContentController.removeScriptMessageHandler(forName: "panelHost", contentWorld: .page)
        assets?.cancel(); assets = nil
        view?.stopLoading(); view?.navigationDelegate = nil; view?.uiDelegate = nil; view = nil
        // What a self-deciding panel said stays through a remount, as the desktop keeps it until the panel leaves.
        input = nil; stand = .loading
    }

    func updateTheme(_ theme: String) {
        guard theme != self.theme else { return }
        self.theme = theme
        guard stand == .drawn else { return }
        view?.evaluateJavaScript("window.phonePanel?.theme('\(theme == "dark" ? "dark" : "light")')", completionHandler: nil)
    }

    /// The finger on the panel moved on the screen farther than a press may: the page leaves that press to WebKit.
    private func pressMoved() {
        guard stand == .drawn else { return }
        view?.evaluateJavaScript("window.phonePanel?.pressMoved()", completionHandler: nil)
    }

    /// The device's Text Size: a page not yet mounted takes it with its mount, and a shown one redraws at it in place.
    func updateTextScale(_ scale: Double) {
        guard scale != textScale else { return }
        textScale = scale
        view?.callAsyncJavaScript("window.phonePanel?.textScale(value)", arguments: ["value": scale], in: nil, in: .page, completionHandler: nil)
    }

    /// Folded, or on a tab that is not showing: its page keeps running and is never stopped for missed pings.
    func setState(collapsed: Bool, shown: Bool) {
        guard collapsed != self.collapsed || shown != self.shown else { return }
        self.collapsed = collapsed; self.shown = shown
        tellState()
    }

    /// A header button that asks the panel was pressed: its page hears the press as one more on that button.
    func ask(_ button: String) {
        asks[button, default: 0] += 1
        tellState()
    }

    /// The card this page draws was put up again or kept its place: its page hears the new data, revision and place.
    func setCard(_ next: PhonePanelCardEntry) {
        guard let card, card != next else { return }
        self.card = next
        guard stand == .drawn, let value = try? next.state.foundation else { return }
        view?.callAsyncJavaScript("window.phonePanel.card(value)", arguments: ["value": value], in: nil, in: .page, completionHandler: nil)
    }

    private func tellState() {
        guard stand == .drawn, let view else { return }
        view.callAsyncJavaScript("window.phonePanel.state(value)", arguments: ["value": [
            "collapsed": collapsed, "shown": shown, "asks": asks,
        ] as [String: Any]], in: nil, in: .page, completionHandler: nil)
    }

    /// A push from the computer the page may hear.
    func push(_ channel: String, _ payload: PhoneJSON) {
        guard stand == .drawn, let view, let value = try? payload.foundation else { return }
        view.callAsyncJavaScript("window.phonePanel.push(channel, payload)", arguments: ["channel": channel, "payload": value],
                                 in: nil, in: .page, completionHandler: nil)
    }

    /// The phone reloaded what it held: every read the page made runs again.
    func resync() {
        guard stand == .drawn else { return }
        view?.evaluateJavaScript("window.phonePanel?.resync()", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === view, case .object(var fields)? = input else { return }
        fields["theme"] = .string(theme); fields["collapsed"] = .bool(collapsed); fields["textScale"] = .number(textScale)
        do {
            webView.callAsyncJavaScript("await window.phonePanel.mount(input)", arguments: ["input": try PhoneJSON.object(fields).foundation],
                                       in: nil, in: .page) { [weak self] result in
                guard let self, webView === self.view else { return }
                if case .failure = result { self.stand = .couldNotOpen(PhonePanelFailure.unreadable.sentence); return }
                self.stand = .drawn
                self.tellState()
            }
        } catch { stand = .couldNotOpen(PhonePanelFailure.unreadable.sentence) }
    }

    /// The channels the parent page may ask on: what the panel reads and does, never the files or the list, which
    /// native code asks for itself.
    private static let pageAsks = Set(PhonePanelRequest.allCases).subtracting([
        .pluginsFiles, .pluginsLibrary, .pluginsRetry, .pluginsPersonalList, .shellPreferences, .pluginsAppPanels, .pluginsAppPanelFiles,
    ])

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        // The sandboxed frame can see WebKit's handler too. It may NEVER call the native host directly.
        guard message.frameInfo.isMainFrame, message.webView === view,
              let payload = try? PhoneJSON.read(message.body), let type = payload["type"].text else {
            // i18n-exempt: a refusal to a frame that may never call the host, not shown
            replyHandler(nil, "This frame has no native access."); return
        }
        switch type {
        case "loaded": replyHandler(true, nil)
        case "hash":
            let scripts = payload["scripts"].list.compactMap(\.text)
            guard scripts.reduce(0, { $0 + $1.utf8.count }) <= 262_144 else { replyHandler(nil, PhoneMessages.phonePanelWebTooLarge()); return }
            replyHandler(scripts.map { PhonePanelFile.pin(Data($0.utf8)) }, nil)
        case "document":
            guard let body = payload["body"].text, let csp = payload["csp"].text, body.utf8.count <= 1_048_576 else {
                replyHandler(nil, PhoneMessages.phonePanelWebTooLarge()); return
            }
            assets?.document = (Data(body.utf8), csp)
            replyHandler(true, nil)
        case "height", "drawn":
            contentHeight = max(1, min(20_000, payload["height"].numeric ?? 1))
            replyHandler(true, nil)
        case "shown":
            decidedShown = payload["shown"] == .bool(true)
            replyHandler(true, nil)
        case "unresponsive":
            stopped()
            replyHandler(true, nil)
        case "steady":
            reloaded = false
            replyHandler(true, nil)
        case "cards":
            guard let onCards else { replyHandler(nil, PhoneMessages.phonePanelWebCannotDo()); return }
            let answer: PhoneJSON
            do throws(PhoneRequestError) { answer = try onCards(payload) }
            catch { replyHandler(nil, error.words); return }
            replyHandler((try? answer.foundation) ?? NSNull(), nil)
        case "point":
            replyHandler(onPoint?(payload) ?? false, nil)
        case "ask":
            guard let name = payload["channel"].text, let channel = PhonePanelRequest(rawValue: name), Self.pageAsks.contains(channel),
                  owns(channel, payload["args"].list) else {
                replyHandler(nil, PhoneMessages.phonePanelWebCannotAsk()); return
            }
            let args = payload["args"].list
            Task {
                do { replyHandler(try await session.panelAsk(channel, args).foundation, nil) }
                catch { replyHandler(nil, error.localizedDescription) }
            }
        default: replyHandler(nil, PhoneMessages.phonePanelWebCannotDo())
        }
    }

    /// An ask that names a panel names this one: its own background work, integrations and store.
    private func owns(_ channel: PhonePanelRequest, _ args: [PhoneJSON]) -> Bool {
        switch channel {
        case .pluginsInvoke, .pluginsIntegrations: args.first?.text == panel.id
        case .pluginsDb: args.first?["extensionId"].text == panel.id
        default: true
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url?.absoluteString ?? ""
        let main = navigationAction.targetFrame?.isMainFrame ?? true
        // Only the parent page, and in it the panel's own document. Even a meta refresh cannot leave either.
        let allowed = main ? url == "about:blank" && navigationAction.navigationType == .other : url == "app-frame://panel-\(mount)/"
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if webView === view { stopped() } }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
}

/// The page's one way to the host, holding it weakly, so letting go of a panel's host closes its page and process.
@MainActor private final class PanelHostHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var host: PanelWebHost?
    init(_ host: PanelWebHost) { self.host = host }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        // i18n-exempt: a refusal to a page whose host is already gone, never drawn
        guard let host else { replyHandler(nil, "This panel is closed."); return }
        host.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
    }
}

/// Serves one panel's page everything it loads, from memory: the bundled runtime and fonts, the library files and the
/// panel's own files, each checked against its pin before it arrived here, and the panel's document. Nothing else.
@MainActor final class PanelAssets: NSObject, WKURLSchemeHandler {
    private let mount: String
    private var library: [String: PhonePanelFile] = [:]
    private var files: [String: PhonePanelFile] = [:]
    var document: (Data, String)?
    private var live: Set<ObjectIdentifier> = []

    init(mount: String) { self.mount = mount }
    func serve(library: [String: PhonePanelFile], files: [String: PhonePanelFile]) { self.library = library; self.files = files }
    func cancel() { live.removeAll(); library = [:]; files = [:]; document = nil }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { live.remove(ObjectIdentifier(urlSchemeTask)) }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, urlSchemeTask.request.httpMethod == "GET", let (data, headers) = load(url) else {
            urlSchemeTask.didFailWithError(PhoneError.invalidReply); return
        }
        var fields = ["Content-Length": String(data.count), "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff"]
        fields.merge(headers) { _, new in new }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: fields)!
        urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
    }

    private func load(_ url: URL) -> (Data, [String: String])? {
        guard url.scheme == "app-frame", url.user == nil, url.password == nil, url.port == nil,
              url.query == nil, url.fragment == nil, let host = url.host else { return nil }
        let path = String(url.path.dropFirst())
        guard !path.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        let script = ["Content-Type": "text/javascript"]
        switch host {
        case "runtime" where path == "PanelHost.generated.js":
            guard let file = Bundle.main.url(forResource: "PanelHost.generated", withExtension: "js"),
                  let data = try? Data(contentsOf: file) else { return nil }
            return (data, script)
        case "fonts" where path.range(of: "^[a-z0-9-]+\\.woff2$", options: .regularExpression) != nil:
            guard let file = Bundle.main.url(forResource: String(path.dropLast(6)), withExtension: "woff2"),
                  let data = try? Data(contentsOf: file) else { return nil }
            return (data, ["Content-Type": "font/woff2"])
        case "lib":
            guard let file = library[path] else { return nil }
            return (file.data, ["Content-Type": Self.type(of: path)])
        case "panel-\(mount)":
            if path.isEmpty {
                guard let (body, csp) = document else { return nil }
                // i18n-exempt: a media type the web view reads, not shown
                return (body, ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp])
            }
            guard let file = files[path] else { return nil }
            return (file.data, ["Content-Type": Self.type(of: path)])
        default: return nil
        }
    }

    private static func type(of path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "mjs", "js": "text/javascript"
        case "css": "text/css"
        case "json": "application/json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "woff2": "font/woff2"
        default: "application/octet-stream"
        }
    }
}

/// A panel's page that says when a field in it holds the software keyboard, read as the keyboard comes and goes, as a
/// card's body does (`CardBodyView`).
final class PanelPageView: WKWebView {
    var onTyping: ((Bool) -> Void)?
    private var typing = false
    private var keyboardWatch: [NSObjectProtocol] = []
    override func didMoveToWindow() {
        super.didMoveToWindow()
        keyboardWatch.forEach(NotificationCenter.default.removeObserver)
        keyboardWatch = []
        guard window != nil else { readTyping(hides: true); return }
        for name in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillChangeFrameNotification,
                     UIResponder.keyboardWillHideNotification] {
            let hides = name == UIResponder.keyboardWillHideNotification
            keyboardWatch.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.readTyping(hides: hides) }
            })
        }
    }
    private func readTyping(hides: Bool) {
        let now = !hides && window != nil && phoneFirstResponder() != nil
        guard now != typing else { return }
        typing = now
        onTyping?(now)
    }
}

extension UIView {
    /// The view in this one's subtree that holds the keyboard's focus, if any.
    func phoneFirstResponder() -> UIView? {
        if isFirstResponder { return self }
        for child in subviews { if let found = child.phoneFirstResponder() { return found } }
        return nil
    }
}

/// The panel's view in the column, the one view its host keeps.
struct PanelWebView: UIViewRepresentable {
    let host: PanelWebHost
    let theme: String
    @Environment(\.dynamicTypeSize) private var typeSize
    func makeUIView(context: Context) -> WKWebView {
        host.updateTextScale(PhoneTextSize.scale(for: typeSize))
        return host.makeView(theme: theme)
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        host.updateTheme(theme)
        host.updateTextScale(PhoneTextSize.scale(for: typeSize))
    }
}
