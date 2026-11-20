import InfinitaryKit
import SwiftUI

/// The captain's pick "Direction 1: Maximize card, as on the Mac": the card's size control, just before its minus,
/// wherever a side panel shares the window with Home's card, an open iPhone Duo or an iPad on its side. It reads
/// Maximize card with outward arrows; maximized, the card takes Home's room and the control reads Restore card with
/// inward arrows (the Mac's `CardSize.tsx`). The choice is this device's own (`PhoneCardMaximized`), so it holds from
/// card to card, through turns and folds and after a relaunch, until Restore. Where the card already has the window,
/// an iPhone, a closed Duo or an iPad upright, the control does not show. A change of size is a cut, as on the Mac.
struct PhoneCardSizeButton: View {
    @Environment(PhoneAppearance.self) private var appearance: PhoneAppearance?
    @Environment(PhoneMessageContext.self) private var messageContext

    var body: some View {
        if messageContext.cardSizeOffered, let appearance {
            let maximized = appearance.cardMaximized
            Button { appearance.cardMaximized.toggle() } label: {
                Label(maximized ? PhoneMessages.uiCardRestore() : PhoneMessages.uiCardMaximize(),
                      systemImage: maximized ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                    .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            }
            .accessibilityIdentifier("card-size")
        }
    }
}
