@preconcurrency import AVFoundation
import InfinitaryKit
import SwiftUI

/// A card's sound clip as the phone plays it (docs/card-authoring.md "Sound clips", docs/ios.md "Sound clips"): the one
/// sound in the whole app, started only by the captain's press on a clip's Listen button. Its bytes come through the
/// pinned connection into memory and play from there, so nothing is written to disk. The sound session is set for
/// playback when a press starts it, so it plays with the silent switch on, and ended when it pauses, ends or stops; it
/// stops when its card leaves the front, and pauses when the captain leaves the app.
@MainActor @Observable final class CardSound: NSObject, AVAudioPlayerDelegate {
    static let shared = CardSound()

    /// The clip a press asked for: its card, served name, caption and the length the home wrote on its figure.
    struct Clip: Equatable {
        let cardID: String
        let src: String
        let caption: String
        let durationMs: Double
        /// A new one for each press, so pressing Listen again starts the clip again.
        let press: Int
    }
    enum State: Equatable { case loading, playing, paused, ended, failed }

    private(set) var clip: Clip?
    private(set) var state: State = .loading
    private(set) var time: TimeInterval = 0
    private(set) var length: TimeInterval = 0
    private var player: Output?
    private var loading: Task<Void, Never>?
    private var clock: Task<Void, Never>?
    private var presses = 0
    /// A new one for each start, pause or stop, so a start that comes back late after a pause or stop is let go.
    private var turn = 0

    override private init() {
        super.init()
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { CardSound.shared.pause() }
        }
    }

    /// A press on a clip's Listen button: it replaces any sound before it and plays once its bytes are in.
    func play(card: String, payload: PhoneJSON, session: ReadOnlySession) {
        guard let src = payload["src"].text, let url = URL(string: src) else { return }
        stop()
        presses += 1
        let clip = Clip(cardID: card, src: src, caption: payload["caption"].text ?? "",
                        durationMs: max(0, payload["durationMs"].numeric ?? 0), press: presses)
        self.clip = clip
        length = clip.durationMs / 1000
        state = .loading
        loading = Task {
            do {
                let (bytes, type) = try await CardAssets(session: session).load(url)
                try Task.checkCancellation()
                guard self.clip == clip, ["audio/mp4", "audio/mpeg", "audio/wav"].contains(type) else { throw PhoneError.invalidReply }
                let output = try await Output.make(bytes)
                try Task.checkCancellation()
                guard self.clip == clip else { return }
                output.player.delegate = self
                self.player = output
                if output.duration > 0 { length = output.duration }
                start()
            } catch {
                if !Task.isCancelled, self.clip == clip { state = .failed; Output.endSession() }
            }
        }
    }

    /// Play, Pause or Replay, as the strip's button reads.
    func toggle() {
        guard let player else { return }
        switch state {
        case .playing: pause()
        case .ended: player.seek(to: 0); time = 0; start()
        case .paused: start()
        case .loading, .failed: break
        }
    }

    func seek(to seconds: TimeInterval) {
        guard let player, seconds.isFinite else { return }
        time = max(0, min(seconds, length))
        player.seek(to: time)
        if state == .ended { state = .paused }
    }

    func pause() {
        guard let player, state == .playing || state == .loading else { return }
        turn += 1
        clock?.cancel()
        state = .paused
        player.pause { [weak self] now in self?.time = now }
    }

    /// The strip goes: its card left the front, or another clip replaced it.
    func stop(card: String? = nil) {
        if let card, clip?.cardID != card { return }
        turn += 1
        loading?.cancel(); loading = nil
        clock?.cancel(); clock = nil
        player?.stop(); player = nil
        clip = nil; time = 0; length = 0; state = .loading
    }

    /// Starts the sound on the player's own queue: the system's sound service can keep a start waiting, and the
    /// screen keeps answering meanwhile, with the button held until the sound is playing.
    private func start() {
        guard let player else { return }
        turn += 1
        let turn = turn
        state = .loading
        clock?.cancel()
        clock = Task {
            let playing = await player.start()
            guard turn == self.turn, player === self.player else { return }
            guard playing else { state = .failed; Output.endSession(); return }
            state = .playing
            while !Task.isCancelled, turn == self.turn, self.state == .playing {
                let (now, still) = await player.reading()
                guard turn == self.turn, self.state == .playing else { return }
                self.time = now
                // A call or another app may take the sound away; the player stops itself, and the strip says so.
                if !still { self.state = .paused; Output.endSession(); return }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }

    // The player may tell its end on any thread; the strip changes on the main one.
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let which = ObjectIdentifier(player)
        Task { @MainActor in self.ended(which, failed: !flag) }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let which = ObjectIdentifier(player)
        Task { @MainActor in self.ended(which, failed: true) }
    }

    private func ended(_ which: ObjectIdentifier, failed: Bool) {
        guard let player = self.player?.player, ObjectIdentifier(player) == which else { return }
        turn += 1
        clock?.cancel()
        if !failed { time = length }
        state = failed ? .failed : .ended
        Output.endSession()
    }

    static func clock(_ seconds: TimeInterval) -> String {
        let whole = Int(max(0, seconds.isFinite ? seconds : 0))
        return "\(whole / 60):\(String(format: "%02d", whole % 60))"
    }

    /// The player and the sound session, used only on one queue of their own. Starting and ending the session and
    /// starting the sound can wait on the system's sound service; Apple warns that such a wait on the main thread
    /// stops the screen answering, so none of it runs there.
    final class Output: @unchecked Sendable {
        private static let queue = DispatchQueue(label: "infinitary.card-sound", qos: .userInitiated)
        /// The phone check's simulators run on machines with no sound device, where starting any sound waits minutes on
        /// the system's sound service; there `INFINITARY_TEST_SOUND_CLOCK` (`1`) keeps the decoded clip's time on a clock
        /// in place of the sound output, standing in for it, and the clip is read but never prepared for the output. A phone always plays through the sound output.
        private static let standIn = ProcessInfo.processInfo.environment["INFINITARY_TEST_SOUND_CLOCK"] == "1"
        let player: AVAudioPlayer
        let duration: TimeInterval
        /// The stand-in clock: where the clip stood when it last started or stopped, and when it started.
        private var offset: TimeInterval = 0
        private var begun: Date?
        private init(_ player: AVAudioPlayer) { self.player = player; duration = player.duration }

        static func make(_ bytes: Data) async throws -> Output {
            try await withCheckedThrowingContinuation { done in
                queue.async {
                    do {
                        // Reading the clip checks its kind and length; preparing it already reaches for the sound
                        // output, which the stand-in leaves alone.
                        let player = try AVAudioPlayer(data: bytes)
                        guard standIn || player.prepareToPlay() else { throw PhoneError.invalidReply }
                        done.resume(returning: Output(player))
                    } catch { done.resume(throwing: error) }
                }
            }
        }

        /// Playback, not ambient: the captain pressed Listen, so it plays with the silent switch on, as video apps do.
        func start() async -> Bool {
            await withCheckedContinuation { done in
                Self.queue.async {
                    if Self.standIn { self.begun = Date(); done.resume(returning: true); return }
                    do {
                        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
                        try AVAudioSession.sharedInstance().setActive(true)
                    } catch {}
                    done.resume(returning: self.player.play())
                }
            }
        }

        func reading() async -> (TimeInterval, Bool) {
            await withCheckedContinuation { done in
                Self.queue.async {
                    guard Self.standIn else { return done.resume(returning: (self.player.currentTime, self.player.isPlaying)) }
                    if let begun = self.begun, self.offset + Date().timeIntervalSince(begun) >= self.duration {
                        self.begun = nil; self.offset = self.duration
                        let player = self.player
                        DispatchQueue.main.async { player.delegate?.audioPlayerDidFinishPlaying?(player, successfully: true) }
                    }
                    done.resume(returning: (self.standInTime, self.begun != nil))
                }
            }
        }

        private var standInTime: TimeInterval {
            min(duration, offset + (begun.map { Date().timeIntervalSince($0) } ?? 0))
        }

        func pause(_ now: @escaping @MainActor (TimeInterval) -> Void) {
            Self.queue.async {
                let time: TimeInterval
                if Self.standIn {
                    self.offset = self.standInTime; self.begun = nil; time = self.offset
                } else {
                    self.player.pause(); time = self.player.currentTime
                }
                Self.endSessionHere()
                Task { @MainActor in now(time) }
            }
        }

        func seek(to seconds: TimeInterval) {
            Self.queue.async {
                if Self.standIn { self.offset = seconds; if self.begun != nil { self.begun = Date() } } else { self.player.currentTime = seconds }
            }
        }

        func stop() { Self.queue.async { self.begun = nil; self.player.stop(); Self.endSessionHere() } }

        static func endSession() { queue.async { endSessionHere() } }

        private static func endSessionHere() {
            guard !standIn else { return }
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}

/// The card's sound strip under its body (the design skill's ResponseCard, "A sound strip"), in the browser strip's place
/// and style: the micro label, the caption, then Play, Pause or Replay, a seek slider and the time.
struct CardSoundStrip: View {
    let sound: CardSound
    /// Where a drag on the slider stands while it moves, so the clock does not pull it back.
    @State private var dragging: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: PhoneTheme.space2) {
            HStack(spacing: PhoneTheme.space3) {
                Text(PhoneMessages.cardSoundWord()).textCase(.uppercase).font(PhoneFont.micro).tracking(PhoneFont.labelTracking)
                    .foregroundStyle(PhoneTheme.secondary).fixedSize()
                Text(sound.clip?.caption ?? "").font(PhoneFont.caption).foregroundStyle(PhoneTheme.secondary).lineLimit(1)
                    .accessibilityIdentifier("card-sound-caption")
            }
            HStack(spacing: PhoneTheme.space3) {
                Button(action: sound.toggle) {
                    Image(systemName: sound.state == .ended ? "arrow.counterclockwise" : sound.state == .playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(PhoneTheme.text)
                        .frame(width: 36, height: 36).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(sound.state == .ended ? PhoneMessages.uiPictureViewerReplay()
                    : sound.state == .playing ? PhoneMessages.uiPictureViewerPause() : PhoneMessages.uiPictureViewerPlay())
                .accessibilityIdentifier("card-sound-toggle")
                .disabled(sound.state == .loading || sound.state == .failed)
                if sound.state == .failed {
                    Text(PhoneMessages.cardSoundUnplayable()).font(PhoneFont.caption).foregroundStyle(PhoneTheme.warning)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Slider(value: Binding(get: { dragging ?? min(sound.time, sound.length) },
                                          set: { dragging = $0 }),
                           in: 0...max(sound.length, 0.001)) { editing in
                        if !editing, let dragging { sound.seek(to: dragging); self.dragging = nil }
                    }
                    .tint(PhoneTheme.accent)
                    .accessibilityLabel(PhoneMessages.uiPictureViewerSeek())
                    .accessibilityValue(PhoneMessages.uiPictureViewerSeekValue(length: CardSound.clock(sound.length),
                                                                               time: CardSound.clock(sound.time)))
                    .accessibilityIdentifier("card-sound-seek")
                    .disabled(sound.state == .loading)
                    Text(verbatim: "\(CardSound.clock(dragging ?? sound.time)) / \(CardSound.clock(sound.length))")
                        .font(PhoneFont.mono).foregroundStyle(PhoneTheme.secondary).lineLimit(1).fixedSize()
                        .accessibilityIdentifier("card-sound-time")
                }
            }
        }
        .accessibilityElement(children: .contain).accessibilityIdentifier("card-sound")
    }
}
