import XCTest

/// INF-4326 (INF-4241's speed-ups): one read of the whole screen that answers many questions. Each `exists` or `frame`
/// of an XCUIElement is its own read of the app's tree, and the keyboard probes asked twenty or more of them per check;
/// a probe reads the screen once here and looks each element up in that read, as XCTest's own queries would find it:
/// the first match in the tree's order, by identifier or label, of the asked type.
struct PhoneScreen {
    struct Element {
        let type: XCUIElement.ElementType
        let identifier: String
        let label: String
        let frame: CGRect
        let enabled: Bool
        let inWebView: Bool
        /// Whether a keyboard is drawn inside it, as `containing(.keyboard, identifier: nil)` asks.
        fileprivate(set) var holdsKeyboard: Bool
    }

    let elements: [Element]

    /// Nil when the app's tree could not be read, which a steady reading treats as not found.
    @MainActor init?(_ app: XCUIApplication) {
        guard let root = try? app.snapshot() else { return nil }
        var elements: [Element] = []
        @discardableResult func walk(_ node: XCUIElementSnapshot, inWebView: Bool) -> Bool {
            let index = elements.count
            elements.append(Element(type: node.elementType, identifier: node.identifier, label: node.label, frame: node.frame,
                                    enabled: node.isEnabled, inWebView: inWebView, holdsKeyboard: false))
            let below = inWebView || node.elementType == .webView
            var keyboard = false
            for child in node.children where walk(child, inWebView: below) { keyboard = true }
            elements[index].holdsKeyboard = keyboard
            return keyboard || node.elementType == .keyboard
        }
        walk(root, inWebView: false)
        self.elements = elements
    }

    /// The first element named `name` (its identifier, or its label as XCTest's subscript also matches), of `type`.
    func first(_ name: String, _ type: XCUIElement.ElementType = .any, inWebView: Bool = false) -> Element? {
        elements.dropFirst().first { ($0.identifier == name || $0.label == name) && (type == .any || $0.type == type) && (!inWebView || $0.inWebView) }
    }

    /// The first element of `type`, as `firstMatch` on that type's query.
    func first(_ type: XCUIElement.ElementType) -> Element? {
        elements.dropFirst().first { $0.type == type }
    }

    func all(_ type: XCUIElement.ElementType, where matches: (Element) -> Bool = { _ in true }) -> [Element] {
        elements.dropFirst().filter { $0.type == type && matches($0) }
    }

    /// Where the app stops showing above the keyboard, or nil with no keyboard. XCUITest's keyboard frame is its keys
    /// alone; the suggestion row and, on an iPhone, WebKit's form bar (previous, next, Done) stand above them in the
    /// keyboard's own container, whose top is that line.
    func keyboardDrawnTop() -> CGFloat? {
        guard let keys = first(.keyboard) else { return nil }
        let window = first(.window)?.frame ?? .null
        let tops = all(.other) { $0.holdsKeyboard }.map(\.frame.minY).filter { $0 > window.minY + 0.5 && $0 < keys.frame.minY }
        return tops.max() ?? keys.frame.minY
    }
}
