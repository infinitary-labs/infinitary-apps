import InfinitaryKit
import SwiftUI

/// Settings → Appearance → Theme as one group of tiles, as on the computer (INF-6888's part 3): Device, Dark, Light and
/// each built-in color theme under its maker's name, each a small window in its own colors, drawn whatever the phone
/// wears. A tap applies the pick at once; the arrow keys move it from the group (`PhoneSettingsSheet`).
struct PhoneThemeTiles: View {
    @Binding var look: PhoneLook

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: PhoneTheme.space2)], spacing: PhoneTheme.space2) {
            ForEach(PhoneLook.allCases, id: \.self) { choice in
                let chosen = choice == look
                Button { look = choice } label: {
                    VStack(alignment: .leading, spacing: PhoneTheme.space2) {
                        swatch(choice)
                        Text(choice.words).font(PhoneFont.caption).lineLimit(2).multilineTextAlignment(.leading)
                            .foregroundStyle(chosen ? PhoneTheme.text : PhoneTheme.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(PhoneTheme.space2)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .background(chosen ? PhoneTheme.accentDim : .clear, in: .rect(cornerRadius: PhoneTheme.controlRadius))
                    .overlay(RoundedRectangle(cornerRadius: PhoneTheme.controlRadius)
                        .strokeBorder(chosen ? PhoneTheme.accent : PhoneTheme.line, lineWidth: 1))
                    .contentShape(.rect(cornerRadius: PhoneTheme.controlRadius))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(choice.words)
                .accessibilityAddTraits(chosen ? .isSelected : [])
                .accessibilityIdentifier("phone-theme-\(choice.rawValue)")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("phone-theme")
    }

    /// Device shows Dark and Light side by side, since it follows whichever the device shows.
    @ViewBuilder private func swatch(_ choice: PhoneLook) -> some View {
        switch choice {
        case .device:
            window(.dark)
                .overlay { window(.light).mask(HStack(spacing: 0) { Color.clear; Color.black }) }
                .clipShape(.rect(cornerRadius: 6))
        case .dark: window(.dark).clipShape(.rect(cornerRadius: 6))
        case .light: window(.light).clipShape(.rect(cornerRadius: 6))
        case .theme(let theme): window(theme.palette).clipShape(.rect(cornerRadius: 6))
        }
    }

    /// The window's background, a card with a line of words, and the calm, working and person's colors.
    private func window(_ palette: PhonePalette) -> some View {
        HStack(spacing: 4) {
            Capsule().fill(Color(uiColor: palette.text)).frame(height: 3)
            Circle().fill(Color(uiColor: palette.accent)).frame(width: 8, height: 8)
            Circle().fill(Color(uiColor: palette.hot)).frame(width: 8, height: 8)
            Circle().fill(Color(uiColor: palette.captain)).frame(width: 8, height: 8)
        }
        .padding(.horizontal, 6).padding(.vertical, 5)
        .background(Color(uiColor: palette.surface), in: .rect(cornerRadius: 4))
        .padding(6)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .bottom)
        .background(Color(uiColor: palette.background))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(uiColor: palette.line), lineWidth: 1))
    }
}
