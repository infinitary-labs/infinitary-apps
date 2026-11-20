import SwiftUI
import XCTest
@testable import Infinitary
@testable import InfinitaryKit

/// INF-3704, the captain's "why is there a horizontal line towards the top of the card i'm dragging? that seems
/// unintended": on iOS 27 a leaning card's own scroller drew the top bar's edge band, a lighter strip along the card's
/// top ending in a bright line. The card sits on the bar's bottom edge, leaned and moved as in the captain's screenshot.
@MainActor final class PhoneCardRowLeanTests: XCTestCase {
    private func until(_ what: String, _ done: () -> Bool) async throws {
        var deadline = PhoneWaitDeadline(20)
        while !done() {
            if deadline.expired() { throw PhoneError.refused("Never saw: \(what)") }
            try await Task.sleep(for: .seconds(PhoneWaitDeadline.tick))
        }
    }

    func testDraggedCardDrawsNoBandAlongItsTop() async throws {
        let row = PhoneCardRow()
        let card = PhoneLeanProbeCard()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        defer { window.isHidden = true; window.rootViewController = nil }
        window.rootViewController = UIHostingController(rootView: NavigationStack {
            VStack(spacing: 0) {
                ScrollView {
                    // The card's top runs blank, as a card's head does around its words, so only a band could light it.
                    VStack(alignment: .leading, spacing: PhoneTheme.space3) {
                        Color.clear.frame(height: 80)
                        ForEach(0..<30, id: \.self) { line in Text("A card's body, line \(line + 1)") }
                    }
                    .padding(PhoneTheme.space4).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 420)
                .clipShape(RoundedRectangle(cornerRadius: PhoneTheme.cardRadius, style: .continuous))
                .phoneCardSurface()
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { card.frame = $0 }
                .modifier(PhoneCardRowLean(row: row, card: "dragged"))
                .offset(x: row.offset)
                .padding(.horizontal, PhoneTheme.space4)
                Spacer(minLength: 0)
            }
            .background(PhoneTheme.background)
            .navigationTitle("Infinitary")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button {} label: { PhoneSymbol.settings.image } }
                ToolbarItem(placement: .topBarTrailing) { Button {} label: { Image(systemName: "laptopcomputer") } }
            }
        })
        window.makeKeyAndVisible()
        try await until("the card's place") { card.frame.height > 0 }
        // The upright card's place: its global frame takes the lean's turned bounds once it leans.
        let upright = card.frame

        // The captain's screenshot: the row dragged left, about 150 points, the card leaning 2.9 degrees.
        row.grabbed = "dragged"
        row.offset = -150
        row.lean = -2.9
        let picture = window.picture()
        let attachment = XCTAttachment(image: picture.image)
        attachment.name = "dragged-card-top"; attachment.lifetime = .keepAlways; add(attachment)

        // A column of the card between the bar's buttons. The card's top there is the first point brighter than the
        // void around the card; the inset edge band under it is two points deep.
        let column = upright.midX + row.offset + 70
        let void = try picture.brightness(x: column, y: upright.minY - 15)
        var top = upright.minY - 15
        while try picture.brightness(x: column, y: top) < void + 0.05 {
            top += 1 / picture.scale
            if top > upright.minY + 20 { return XCTFail("No card top in the column at \(column)") }
        }
        let surface = try picture.brightness(x: column, y: top + 60)
        var brightest = (lift: 0.0, at: 0.0)
        for depth in stride(from: 3.0, through: 40, by: 1 / picture.scale) {
            let lift = try picture.brightness(x: column, y: top + depth) - surface
            if lift > brightest.lift { brightest = (lift, depth) }
        }
        XCTAssertLessThan(brightest.lift, 0.02,
            "The dragged card's top is lit \(brightest.lift) brighter than its surface \(brightest.at) points down")
    }
}

/// Where the card sits, upright, in the window.
@MainActor private final class PhoneLeanProbeCard { var frame = CGRect.zero }

private struct PhoneWindowPicture {
    let image: UIImage
    let scale: CGFloat
    private let pixels: [UInt8]
    private let width: Int
    private let height: Int

    init(image: UIImage) {
        self.image = image
        scale = image.scale
        let cg = image.cgImage!
        width = cg.width; height = cg.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        self.pixels = pixels
    }

    /// The mean of a pixel's red, green and blue, 0 to 1, at a point in the window.
    func brightness(x: CGFloat, y: CGFloat) throws -> Double {
        let column = Int((x * scale).rounded(.down)), line = Int((y * scale).rounded(.down))
        guard (0..<width).contains(column), (0..<height).contains(line) else {
            throw PhoneError.refused("The point \(x), \(y) is outside the window")
        }
        let at = (line * width + column) * 4
        return (Double(pixels[at]) + Double(pixels[at + 1]) + Double(pixels[at + 2])) / (3 * 255)
    }
}

private extension UIWindow {
    func picture() -> PhoneWindowPicture {
        let format = UIGraphicsImageRendererFormat(for: traitCollection)
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
            drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        return PhoneWindowPicture(image: image)
    }
}

