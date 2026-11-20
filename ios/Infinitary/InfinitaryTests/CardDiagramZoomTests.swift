import SwiftUI
import WebKit
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// The captain's report: "full screen view of diagrams seem to render incorrectly when zoomed out". While a diagram is
/// zoomed, WebKit keeps a copy of the whole page drawn at the fitted size under the sharp tiles of the current zoom.
/// The viewer page drew no background of its own, so wherever the sharp tiles were empty that fitted copy, stretched to
/// the zoom, showed through: every line and word grew a blurred edge after a pinch to the deepest zoom and back out.
/// Hosts the shipped full-screen viewer with a timeline drawing as a card writes one out, pinches it in code to the
/// deepest zoom and back out to 3.6 times fitted, and reads the window's own pixels across the timeline's line.
@MainActor final class CardDiagramZoomTests: XCTestCase {
    /// The timeline's line: 2 units thick at y 70 of a 750 by 170 drawing, in the card's line color, with nothing else in
    /// the column measured.
    private static let lineWidth: CGFloat = 2
    private static let lineColor = (red: 0x9a, green: 0xa4, blue: 0xbd)
    private static let drawing: String = {
        let stroke = String(format: "#%02x%02x%02x", lineColor.red, lineColor.green, lineColor.blue)
        let svg = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 170" width="750" height="170">\
        <line x1="40" y1="70" x2="715" y2="70" stroke="\(stroke)" stroke-width="\(Int(lineWidth))"/>\
        <circle cx="55" cy="70" r="7" fill="#7fdcff"/><circle cx="690" cy="70" r="7" fill="#ff7a5c"/>\
        <g font-size="11" font-family="Menlo" fill="\(stroke)" text-anchor="middle">\
        <text x="55" y="50">1:14 PM</text><text x="690" y="50">2:41:18 PM</text></g>\
        <g font-size="13" fill="#e9eef8" text-anchor="middle">\
        <text x="55" y="100">App asks for</text><text x="690" y="100">Card ends it</text></g></svg>
        """
        return CardDrawing.prefix + (svg.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")
    }()

    func testAZoomedOutDiagramDrawsOnlyItsSharpTilesInDark() async throws { try await zoomedOut(.dark) }
    func testAZoomedOutDiagramDrawsOnlyItsSharpTilesInLight() async throws { try await zoomedOut(.light) }

    private func zoomedOut(_ style: UIUserInterfaceStyle) async throws {
        let session = ReadOnlySession(mac: JoinedMac(addresses: [], pin: "diagram", deviceID: "diagram", name: "Mac"),
                                      phone: try PhoneIdentity.loadOrCreate())
        let presentation = PhoneJSON.object(["type": .string("picture"), "index": .number(0), "pictures": .array([.object([
            "src": .string(Self.drawing), "width": .number(750), "height": .number(170), "alt": .string("Timeline"),
        ])])])
        // The host app may still be connecting its scene when the first test starts.
        var connecting = PhoneWaitDeadline(20)
        var connected: UIWindowScene?
        while connected == nil {
            connected = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            if connected == nil, connecting.expired() { XCTFail("The app connected no scene"); return }
            if connected == nil { try await Task.sleep(for: .seconds(PhoneWaitDeadline.tick)) }
        }
        let scene = try XCTUnwrap(connected)
        let window = UIWindow(windowScene: scene)
        defer { window.isHidden = true; window.rootViewController = nil }
        let size = scene.coordinateSpace.bounds.size
        window.frame = CGRect(x: 0, y: 0, width: min(size.width, size.height), height: max(size.width, size.height))
        window.overrideUserInterfaceStyle = style
        window.rootViewController = UIHostingController(rootView: CardMediaView(presentation: presentation, session: session))
        window.makeKeyAndVisible()

        // Drawn fitted first: the line shows at its own thickness, so WebKit has painted the page and set its fitted
        // scale, which would otherwise undo a zoom made before it.
        let background = UIColor(PhoneTheme.background).resolvedColor(with: window.traitCollection)
        var loading = PhoneWaitDeadline(20)
        var found: WKWebView?
        while true {
            try await settle()
            found = Self.viewer(in: window)
            if let found, found.bounds.width > 0, abs(Self.ink(at: found, in: window, background: background)
                - Double(Self.lineWidth * found.bounds.width / 750 * window.screen.scale)) <= 0.5 { break }
            if loading.expired() { XCTFail("The viewer never drew the diagram"); return }
        }
        let viewer = try XCTUnwrap(found)
        let scroll = viewer.scrollView
        // The reported route: the deepest pinch first, then out to about the captain's 3.6 times fitted.
        scroll.setZoomScale(scroll.minimumZoomScale * CardMediaZoom.deepest, animated: false)
        try await settle()
        let zoom: CGFloat = 3.6
        scroll.setZoomScale(scroll.minimumZoomScale * zoom, animated: false)
        // Centred on the line, at a column between the dots and the words.
        let fitted = viewer.bounds.width / 750
        let lineY = (viewer.bounds.height - 170 * fitted) / 2 + 70 * fitted
        scroll.contentOffset = CGPoint(x: (scroll.contentSize.width - viewer.bounds.width) / 2,
                                       y: lineY * zoom - viewer.bounds.height / 2)
        // The line's own thickness at this zoom, in pixels. Antialiasing spreads that ink over its edge pixels without
        // adding to it; a stretched fitted copy showing through adds a blurred edge, about a pixel more ink on the phone.
        let own = Double(Self.lineWidth * fitted * zoom * window.screen.scale)
        var deadline = PhoneWaitDeadline(10)
        var ink = 0.0
        while true {
            try await settle()
            ink = Self.ink(at: viewer, in: window, background: background)
            if abs(ink - own) <= 0.5 || deadline.expired() { break }
        }
        XCTAssertEqual(scroll.zoomScale, scroll.minimumZoomScale * zoom, accuracy: 0.01, "The diagram stays zoomed")
        XCTAssertEqual(ink, own, accuracy: 0.5,
                       "The zoomed-out line carries \(ink) pixels of ink against its own \(own): a stretched fitted copy shows through")
    }

    /// A few drawn frames, so the web view commits what the last zoom asked for.
    private func settle() async throws {
        let frames = DisplaySample(ticks: 2)
        _ = await frames.complete(within: 20)
        frames.stop()
    }

    private static func viewer(in view: UIView) -> WKWebView? {
        if let web = view as? WKWebView, web.accessibilityIdentifier == "card-picture" { return web }
        for sub in view.subviews { if let found = viewer(in: sub) { return found } }
        return nil
    }

    /// The line's ink down the viewer's middle column, 24 points above and below its centre: each pixel counts as the
    /// share of the way it is from the page's background to the line's color, so a sharp line sums to its own thickness.
    private static func ink(at viewer: WKWebView, in window: UIWindow, background: UIColor) -> Double {
        let point = viewer.convert(CGPoint(x: viewer.bounds.midX, y: viewer.bounds.midY), to: window)
        let rect = CGRect(x: point.x.rounded(), y: point.y - 24, width: 1, height: 48)
        let image = UIGraphicsImageRenderer(bounds: rect, format: UIGraphicsImageRendererFormat(for: window.traitCollection)).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        // Read back as 8-bit sRGB, whatever range the renderer chose.
        guard let source = image.cgImage, let space = CGColorSpace(name: CGColorSpace.sRGB) else { return 0 }
        let width = source.width, height = source.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return 0 }
        context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        background.getRed(&r, green: &g, blue: &b, alpha: &a)
        let ground = [r, g, b].map { Double($0 * 255) }
        let line = [lineColor.red, lineColor.green, lineColor.blue].map(Double.init)
        let span = zip(line, ground).map { abs($0 - $1) }.reduce(0, +)
        return (0..<height).reduce(0) { total, row in
            let at = (row * width + width / 2) * 4
            return total + zip(bytes[at..<at + 3], ground).map { abs(Double($0) - $1) }.reduce(0, +) / span
        }
    }
}
