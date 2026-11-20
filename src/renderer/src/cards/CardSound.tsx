import * as m from "@shared/i18n/messages.generated";
import { useEffect, useRef, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { IconButton, MicroLabel } from "../design";
import { type PlayingSound, useCardSound } from "./playingSound";

/** A clip's time as the strip shows it: `2:10`. */
export function soundClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const ICON = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * A card's sound strip (docs/card-authoring.md "Sound clips"; the design
 * skill's ResponseCard, "A sound strip"): host chrome between the body and
 * the buttons, drawn once the captain pressed a clip's Listen button, with
 * the clip's caption, Play or Pause, a seek slider and its time. It plays the
 * host's own verified copy at normal speed, keeps playing while the window
 * is hidden, and stops on Pause, at its end, or when the strip goes - when
 * its card leaves the front, or another clip starts. The body's frame never
 * sees it.
 */
export function CardSound({ sound }: { sound: PlayingSound }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(sound.durationMs / 1000);
  const keys = useCommandKeys("cards.sound");

  // The captain's press started it: it plays at once, and stops with the strip.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.play().catch(() => setPlaying(false));
    return () => audio.pause();
  }, []);

  // The ambient music hushes while the clip plays (../ambient/ambient.ts).
  useEffect(() => {
    useCardSound.setState({ playing });
  }, [playing]);
  useEffect(() => () => useCardSound.setState({ playing: false }), []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || failed) return;
    if (audio.paused || audio.ended) {
      if (audio.ended) audio.currentTime = 0;
      audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  };
  const seek = (to: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(to)) return;
    audio.currentTime = Math.max(0, Math.min(to, length || 0));
    setTime(audio.currentTime);
  };

  const label = ended
    ? m.uiPictureViewerReplay()
    : playing
      ? m.uiPictureViewerPause()
      : m.uiPictureViewerPlay();
  return (
    <div
      data-card-sound=""
      data-sound-src={sound.src}
      data-sound-state={failed ? "failed" : ended ? "ended" : playing ? "playing" : "paused"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        minWidth: 0,
        fontSize: "var(--text-xs)",
      }}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: a sound clip's words are its caption, shown beside it. */}
      <audio
        ref={audioRef}
        src={sound.src}
        preload="auto"
        data-card-sound-audio=""
        onPlay={() => {
          setPlaying(true);
          setEnded(false);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setEnded(true);
        }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const read = event.currentTarget.duration;
          if (Number.isFinite(read) && read > 0) setLength(read);
        }}
        onError={() => {
          setFailed(true);
          setPlaying(false);
        }}
      />
      <MicroLabel style={{ flexShrink: 0 }}>{m.cardSoundWord()}</MicroLabel>
      <IconButton
        label={label}
        {...keys}
        data-sound-toggle=""
        disabled={failed}
        size={28}
        onClick={toggle}
        style={{ flex: "none", color: "var(--fg-1)" }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" {...ICON} aria-hidden="true">
          {ended ? (
            <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />
          ) : playing ? (
            <path d="M8 5v14M16 5v14" />
          ) : (
            <path d="M7 5l12 7-12 7z" fill="currentColor" />
          )}
        </svg>
      </IconButton>
      <span
        data-sound-caption=""
        title={sound.caption || undefined}
        style={{
          flex: "1 1 40%",
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: "var(--fg-2)",
        }}
      >
        {sound.caption}
      </span>
      <input
        type="range"
        data-sound-seek=""
        aria-label={m.uiPictureViewerSeek()}
        aria-valuetext={m.uiPictureViewerSeekValue({
          time: soundClock(time),
          length: soundClock(length),
        })}
        min={0}
        max={length || 0}
        step="any"
        value={Math.min(time, length || 0)}
        disabled={failed}
        onChange={(event) => seek(Number(event.currentTarget.value))}
        onKeyDown={(event) => {
          // Five seconds a press: the slider's own step is a hair, and a clip may run minutes.
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            seek(time + (event.key === "ArrowRight" ? 5 : -5));
          }
        }}
        style={{ flex: "1 1 60%", minWidth: 0, accentColor: "var(--accent)" }}
      />
      <span
        data-sound-time=""
        style={{
          flex: "none",
          fontFamily: "var(--font-mono)",
          color: "var(--fg-3)",
          whiteSpace: "nowrap",
        }}
      >
        {failed ? m.cardSoundUnplayable() : `${soundClock(time)} / ${soundClock(length)}`}
      </span>
    </div>
  );
}
