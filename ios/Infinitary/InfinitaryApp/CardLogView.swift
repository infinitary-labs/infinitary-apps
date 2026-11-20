import InfinitaryKit
import SwiftUI

/// INF-3887: the phone's log reader, the twin of the desktop's. A merge card names each proof log by one line, its name
/// and size; a tap on it opens the log's text here, read from the Mac by its kept name, never written into the card.
struct CardLogView: View {
    let presentation: PhoneJSON
    let session: ReadOnlySession
    @State private var text: String?
    @State private var blocks: [String] = []
    @State private var failure: String?
    @Environment(\.dismiss) private var dismiss
    private var name: String { presentation["name"].text ?? "" }
    var body: some View {
        NavigationStack {
            Group {
                if let text {
                    // One Text holding a whole log draws nothing past the size a drawn layer may reach, so the log is
                    // drawn in short blocks, each laid out only as it scrolls into view.
                    ScrollView([.vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(blocks.indices, id: \.self) { index in
                                Text(blocks[index])
                                    .font(PhoneFont.mono)
                                    .foregroundStyle(PhoneTheme.text)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .accessibilityIdentifier("card-log-block")
                            }
                        }
                        .padding(PhoneTheme.space4)
                    }
                    .background(PhoneTheme.surface)
                    .accessibilityIdentifier("card-log-text")
                } else if let failure {
                    VStack(spacing: PhoneTheme.space3) {
                        Text(failure).font(PhoneFont.callout).foregroundStyle(PhoneTheme.warning).multilineTextAlignment(.center)
                        Button(PhoneMessages.uiLogReaderRetry()) { Task { await load() } }
                    }.padding(PhoneTheme.space4)
                } else { ProgressView(PhoneMessages.uiLogReaderReading()) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // The size sits in its own bar under the text, so it never covers a line of the log.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Text(PhoneLogSize.words(text.map { $0.utf8.count } ?? Int(presentation["bytes"].numeric ?? 0)))
                    .font(PhoneFont.micro).foregroundStyle(PhoneTheme.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, PhoneTheme.space2)
                    .background(PhoneTheme.surface)
                    .overlay(alignment: .top) { Rectangle().fill(PhoneTheme.line).frame(height: 1) }
                    .accessibilityIdentifier("card-log-size")
            }
            .background(PhoneTheme.background)
            .phoneTitle(name.isEmpty ? PhoneMessages.uiLogReaderUntitled() : name)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button(PhoneMessages.uiLogReaderDone()) { dismiss() } }
            }
        }
        .task { await load() }
    }
    private func load() async {
        guard let source = presentation["src"].text, let url = URL(string: source) else { return }
        failure = nil
        do {
            let (bytes, _) = try await CardAssets(session: session).load(url)
            try Task.checkCancellation()
            guard let read = String(data: bytes, encoding: .utf8) else { throw PhoneError.invalidReply }
            blocks = PhoneLogBlocks.split(read)
            text = read
        } catch { if !Task.isCancelled { failure = PhoneMessages.uiLogReaderUnreachable() } }
    }
}

/// A log cut into blocks that each draw: whole lines while they fit, and a line longer than a block cut at the block's
/// length. Both caps keep one block's wrapped text well under the tallest layer the phone draws: the characters for
/// long lines, the lines for many short or blank ones.
enum PhoneLogBlocks {
    static let blockLength = 2_000
    static let blockLines = 80
    static func split(_ text: String) -> [String] {
        var blocks: [String] = []
        var lines: [Substring] = []
        var length = 0
        func close() { if !lines.isEmpty { blocks.append(lines.joined(separator: "\n")); lines = []; length = 0 } }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            var rest = line
            // Each cut walks only the characters it takes, so a one-line log is cut in one pass.
            while let cut = rest.index(rest.startIndex, offsetBy: blockLength, limitedBy: rest.endIndex), cut < rest.endIndex {
                close()
                blocks.append(String(rest[..<cut]))
                rest = rest[cut...]
            }
            let count = rest.count
            if !lines.isEmpty && (length + count + 1 > blockLength || lines.count >= blockLines) { close() }
            lines.append(rest)
            length += count + 1
        }
        close()
        return blocks
    }
}

/// A log's size as the card's line says it, "24 KB" or "1.5 MB" (`fileSizeWords`, src/shared/attachments.ts).
enum PhoneLogSize {
    static func words(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(max(1, Int((Double(bytes) / 1024).rounded()))) KB" }
        return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
    }
}
