import SwiftUI
import UIKit

/// The approved phone preview's Lucide outlines, drawn once as native template images.
/// System bars supply their own tint, size and accessibility treatment.
enum PhoneSymbol: CaseIterable {
    case cards, activity, tasks, computer, scan

    @MainActor var image: Image { Image(uiImage: Self.images[self]!) }

    @MainActor private static let images: [PhoneSymbol: UIImage] = Dictionary(uniqueKeysWithValues: allCases.map { symbol in
        let image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { renderer in
            let context = renderer.cgContext
            context.setStrokeColor(UIColor.label.cgColor)
            context.setLineWidth(1.5)
            context.setLineCap(.round); context.setLineJoin(.round)
            func line(_ points: [CGPoint]) {
                guard let first = points.first else { return }
                context.move(to: first)
                for point in points.dropFirst() { context.addLine(to: point) }
                context.strokePath()
            }
            func points(_ values: [(CGFloat, CGFloat)]) { line(values.map { CGPoint(x: $0.0, y: $0.1) }) }
            switch symbol {
            case .cards:
                context.addPath(UIBezierPath(roundedRect: CGRect(x: 8, y: 8, width: 14, height: 14), cornerRadius: 2).cgPath)
                context.strokePath()
                points([(4, 16), (4, 4), (18, 4)])
            case .activity: points([(2, 12), (6, 12), (9, 3), (15, 21), (18, 12), (22, 12)])
            case .tasks:
                points([(3, 7), (5, 9), (9, 5)]); points([(3, 17), (5, 19), (9, 15)])
                for y: CGFloat in [6, 12, 18] { points([(13, y), (21, y)]) }
            case .computer:
                context.addPath(UIBezierPath(roundedRect: CGRect(x: 4, y: 5, width: 16, height: 11), cornerRadius: 2).cgPath)
                context.strokePath(); points([(4, 16), (2, 20), (22, 20), (20, 16)])
            case .scan:
                points([(3, 7), (3, 3), (7, 3)]); points([(17, 3), (21, 3), (21, 7)])
                points([(21, 17), (21, 21), (17, 21)]); points([(7, 21), (3, 21), (3, 17)])
                points([(7, 12), (17, 12)])
            }
        }.withRenderingMode(.alwaysTemplate)
        return (symbol, image)
    })
}
