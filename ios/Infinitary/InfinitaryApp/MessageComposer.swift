import ImageIO
import InfinitaryKit
import PhotosUI
import SwiftUI

struct MessageComposer: View {
    let session: ReadOnlySession
    @Environment(PhoneMessageContext.self) private var messageContext
    @State private var text = ""
    @State private var photos: [Photo] = []
    @State private var selection: [PhotosPickerItem] = []
    @State private var loading = false
    @State private var sending = false
    @State private var problem: String?
    @FocusState private var focused: Bool
    @Environment(\.verticalSizeClass) private var verticalSize

    // Native compact height identifies iPhone landscape, not a keyboard shrinking the workspace.
    private var compact: Bool { UIDevice.current.userInterfaceIdiom == .phone && verticalSize == .compact }
    private var draftLayout: AnyLayout {
        compact ? AnyLayout(HStackLayout(spacing: PhoneTheme.space2))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: PhoneTheme.space2))
    }
    private var turnLayout: AnyLayout {
        compact ? AnyLayout(HStackLayout(spacing: PhoneTheme.space2))
            : AnyLayout(VStackLayout(spacing: 0))
    }

    private var canSend: Bool {
        session.canChange && !sending && !loading && !(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty)
    }

    struct Photo: Identifiable {
        let id = UUID()
        let data: Data
        let image: UIImage
        var wire: [String: String] { ["mimeType": "image/jpeg", "data": data.base64EncodedString(), "name": "Photo.jpg"] }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            if let turn = session.lastTurn {
                // Two bare lines, as the Mac hangs them above its input: the captain's words, then the reply.
                turnLayout {
                    Group { turn.you.isEmpty ? Text("You sent photos") : quoted(turn.you) }
                        .foregroundStyle(PhoneTheme.secondary).accessibilityIdentifier("last-turn-you")
                    Group { turn.reply.map { quoted($0.text) } ?? Text("Working…").foregroundStyle(PhoneTheme.muted) }
                        .foregroundStyle(turn.reply?.problem == true ? PhoneTheme.warning : PhoneTheme.text)
                        .accessibilityIdentifier("last-turn-reply")
                }.font(PhoneFont.caption).lineLimit(1).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
            }
            // AnyLayout moves the same controls; neither rotation nor a tab creates a second draft.
            draftLayout {
                if !photos.isEmpty {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(photos) { photo in
                                Button { photos.removeAll { $0.id == photo.id } } label: {
                                    Image(uiImage: photo.image).resizable().scaledToFill()
                                        .frame(width: 44, height: 44).clipped()
                                        .overlay(alignment: .topTrailing) { Image(systemName: "xmark.circle.fill").foregroundStyle(PhoneTheme.text, PhoneTheme.surface) }
                                }.accessibilityLabel("Remove photo").accessibilityIdentifier("photo-chip")
                            }
                        }
                    }.frame(maxWidth: compact ? 96 : .infinity).disabled(sending)
                }
                HStack(alignment: .bottom, spacing: 0) {
                    PhotosPicker(selection: $selection, maxSelectionCount: max(1, PhoneLimits.images - photos.count), matching: .images) {
                        Label("Photos", systemImage: "photo").labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }.disabled(loading || sending || photos.count >= PhoneLimits.images).accessibilityIdentifier("add-photos")
                    TextField("Give your first mate a task", text: $text, axis: .vertical)
                        .lineLimit(1...(compact ? 2 : 4)).focused($focused).disabled(sending)
                        .padding(.vertical, PhoneTheme.space2).frame(minHeight: 44)
                        .accessibilityIdentifier("message-box")
                    Button { send() } label: {
                        Label("Send", systemImage: "arrow.up.circle.fill").labelStyle(.iconOnly).imageScale(.large)
                            .foregroundStyle(canSend ? PhoneTheme.accent : PhoneTheme.muted)
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }.keyboardShortcut(.return, modifiers: .command)
                        .disabled(!canSend)
                        .accessibilityIdentifier("send-message")
                }.phoneInput(floating: true)
            }
            if loading { ProgressView("Adding photos…") }
            if sending { ProgressView("Sending…") }
            if let words = session.changeRefusal {
                Text(words).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("connection-refusal")
            }
            if let problem {
                Text(problem).foregroundStyle(PhoneTheme.warning).accessibilityIdentifier("message-problem")
            }
        }.font(PhoneFont.callout).padding(.top, compact ? PhoneTheme.space2 : PhoneTheme.space3)
            .frame(maxWidth: 750).frame(maxWidth: .infinity)
            .task(id: selection) { await loadPhotos() }
    }

    /// Quotation marks in the faintest ink, so even a bare "Got it" reads as something said.
    private func quoted(_ words: String) -> Text {
        let open = Text(verbatim: "“").foregroundStyle(PhoneTheme.muted), close = Text(verbatim: "”").foregroundStyle(PhoneTheme.muted)
        return Text("\(open)\(words)\(close)")
    }

    private func send() {
        guard !sending, !loading, session.canChange else { return }
        guard text.utf16.count <= PhoneLimits.text else { problem = "This message is too long. Shorten it before sending."; return }
        var payload: [String: Any] = ["text": text, "images": photos.map(\.wire)]
        for (key, value) in messageContext.fields { payload[key] = value }
        focused = false
        sending = true; problem = nil
        Task {
            defer { sending = false }
            do {
                let result: PhoneAnswer = try await session.request(.converse, args: [payload])
                try result.accepted()
                text = ""; photos = []
            } catch { problem = error.localizedDescription }
        }
    }

    private func loadPhotos() async {
        guard !selection.isEmpty else { return }
        loading = true; problem = nil
        defer { loading = false; selection = [] }
        for item in selection {
            do {
                guard photos.count < PhoneLimits.images, let bytes = try await item.loadTransferable(type: Data.self),
                      let source = CGImageSourceCreateWithData(bytes as CFData, nil),
                      let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 2048,
                      ] as CFDictionary) else { throw PhoneError.refused("Could not add this photo. Choose another.") }
                try Task.checkCancellation()
                let image = UIImage(cgImage: thumbnail)
                guard let data = image.jpegData(compressionQuality: 0.85), data.count <= 5 * 1024 * 1024,
                      ((data.count + 2) / 3) * 4 <= PhoneLimits.imageBase64 else {
                    throw PhoneError.refused("This photo is too large. Choose a smaller photo.")
                }
                photos.append(Photo(data: data, image: image))
            } catch is CancellationError { return }
            catch { problem = error.localizedDescription }
        }
    }
}
