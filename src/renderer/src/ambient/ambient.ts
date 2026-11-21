// The window's ambient music (docs/ambient-music.md): plays while the
// captain's Ambient music switch is on, in its style and at its volume,
// following the crew.
// It hushes while voice input listens, since the microphone would hear it,
// and while a card's sound clip or a demo recording with sound plays, then
// comes back. While nobody is at the computer it stops as the pause button
// does, closing its audio so the computer may sleep, and starts again once
// someone is back, unless the captain chose to keep it playing.
//
// The window says where it stands on the document, `data-ambient-music`:
// `off`, `paused`, `away`, `playing`, or `hushed`; and, while its player
// runs, the style it plays, `data-ambient-style`.

import { ambientStyleOf } from "@shared/preferences";
import { useShellStore } from "../app/store";
import { useCardSound } from "../cards/playingSound";
import { workingCrew } from "../character/crew/crewSignal";
import { onCharacterCue } from "../character/emoteSignal";
import { crewLevel } from "./composer";
import { AmbientPlayer } from "./player";
import { followPresence, usePresence } from "./presence";
import { STYLES } from "./styles/catalog";

/** How often the scheduler looks ahead, in ms. */
const TICK_MS = 250;
/** How far ahead bars are composed, in seconds: under half a bar, so the crew is heard soon. */
const LOOKAHEAD_SECONDS = 1;
/** How long it fades out when switched off, in seconds. */
const FADE_OUT_SECONDS = 0.6;
/**
 * The music's sample rate, in Hz: half the usual, which halves its cost, and
 * still above everything it plays, since the mix is cut at 11 kHz.
 */
const SAMPLE_RATE = 24_000;
/** At 24 kHz / 512, each bin is about 47 Hz. Ignore DC and the upper roll-off. */
const BANDS = [
  [1, 4],
  [4, 12],
  [12, 34],
  [34, 100],
] as const;

type Playing = {
  ctx: AudioContext;
  player: AmbientPlayer;
  analyser: AnalyserNode;
  bins: Uint8Array<ArrayBuffer>;
  timer: ReturnType<typeof setInterval>;
  hushed: boolean;
};

let playing: Playing | null = null;

function shouldHush(): boolean {
  const sound = useCardSound.getState();
  return useShellStore.getState().recording || sound.playing || sound.demo;
}

/**
 * Whether it waits for someone to come back: nobody is at the computer and
 * the captain did not choose to keep it playing. Unlike the pause button's,
 * this pause is never saved.
 */
function waitsForSomeone(): boolean {
  return usePresence.getState().away && !useShellStore.getState().ambientPlaysWhenAway;
}

/** Marks where it stands: `playing` or `hushed` only once its audio runs, else `off`. */
function mark(): void {
  const { ambientMusic, ambientPaused } = useShellStore.getState();
  document.documentElement.dataset.ambientMusic =
    ambientMusic && ambientPaused
      ? "paused"
      : ambientMusic && waitsForSomeone()
        ? "away"
        : playing?.ctx.state !== "running"
          ? "off"
          : playing.hushed
            ? "hushed"
            : "playing";
}

/** Reads four bands of the music only, from bass to the chimes. */
export function readAmbientBands(levels: number[]): boolean {
  if (!playing || playing.hushed || playing.ctx.state !== "running") return false;
  const { analyser, bins } = playing;
  analyser.getByteFrequencyData(bins);
  for (const [i, [start, end]] of BANDS.entries()) {
    let peak = 0;
    for (let bin = start; bin < end; bin++) peak = Math.max(peak, bins[bin] ?? 0);
    levels[i] = peak / 255;
  }
  return true;
}

function begin(volume: number, style: string): void {
  const ctx = new AudioContext({ latencyHint: "playback", sampleRate: SAMPLE_RATE });
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -70;
  analyser.maxDecibels = -25;
  const id = ambientStyleOf(style);
  const player = new AmbientPlayer(ctx, STYLES[id], Math.floor(Math.random() * 2 ** 31), {
    volume,
    analyser,
  });
  const hushed = shouldHush();
  if (hushed) player.hush(true);
  const tick = () => {
    if (ctx.state !== "running") return;
    player.scheduleUntil(ctx.currentTime + LOOKAHEAD_SECONDS, crewLevel(workingCrew()));
  };
  playing = {
    ctx,
    player,
    analyser,
    bins: new Uint8Array(analyser.frequencyBinCount),
    timer: setInterval(tick, TICK_MS),
    hushed,
  };
  ctx.addEventListener("statechange", mark);
  document.documentElement.dataset.ambientStyle = id;
  void ctx.resume().then(tick, () => {});
  mark();
}

function end(): void {
  if (!playing) {
    mark();
    return;
  }
  const { ctx, player, timer } = playing;
  playing = null;
  clearInterval(timer);
  ctx.removeEventListener("statechange", mark);
  delete document.documentElement.dataset.ambientStyle;
  player.setVolume(0);
  setTimeout(() => {
    player.stop();
    void ctx.close().catch(() => {});
  }, FADE_OUT_SECONDS * 1000);
  mark();
}

/** Follows the switch, the volume, voice input and card sound; call once the saved look is read. */
export function followAmbientMusic(): void {
  const follow = () => {
    const { ambientMusic, ambientPaused, ambientVolume, ambientStyle } = useShellStore.getState();
    // Nobody here: close the audio as the pause button does, since a silent
    // hush still holds the computer awake (docs/ambient-music.md).
    if (!ambientMusic || ambientPaused || waitsForSomeone()) return end();
    if (!playing) return begin(ambientVolume / 100, ambientStyle);
    const hush = shouldHush();
    if (hush !== playing.hushed) {
      playing.hushed = hush;
      playing.player.hush(hush);
      mark();
    }
  };
  mark();
  follow();
  useShellStore.subscribe((state, previous) => {
    if (state.ambientVolume !== previous.ambientVolume && playing)
      playing.player.setVolume(state.ambientVolume / 100);
    // Another style fades this one out and starts the new one from its first bar.
    if (ambientStyleOf(state.ambientStyle) !== ambientStyleOf(previous.ambientStyle) && playing) {
      end();
      follow();
    }
    if (
      state.ambientMusic !== previous.ambientMusic ||
      state.ambientPaused !== previous.ambientPaused ||
      state.ambientPlaysWhenAway !== previous.ambientPlaysWhenAway ||
      state.recording !== previous.recording
    )
      follow();
  });
  useCardSound.subscribe((state, previous) => {
    if (state.playing !== previous.playing || state.demo !== previous.demo) follow();
  });
  usePresence.subscribe((state, previous) => {
    if (state.away !== previous.away) follow();
  });
  followPresence();
  // The notice pulse's and the celebrate emote's moments.
  onCharacterCue((cue) => {
    if (!playing || playing.hushed || playing.ctx.state !== "running") return;
    if (cue === "notice") playing.player.waiting();
    else playing.player.merged();
  });
}
