import { HERE } from "@shared/deviceNames";
import { useEffect } from "react";
import { Button } from "../design";
import { thisDesktop } from "../design/core/desktop";
import { NoticeStrip } from "./NoticeStrip";
import { useShellStore } from "./store";

const TEXT = { fontSize: "var(--text-sm)", color: "var(--fg-2)" } as const;

/**
 * The quiet voice status strip under the input: first-use download consent
 * with progress (section 8), microphone access (docs/composer.md, "Voice"),
 * and capture/transcription errors. Hidden when there is nothing to say.
 */
export function VoiceNotice({ width }: { width: string }) {
  const notice = useShellStore((s) => s.voiceNotice);
  const startVoiceDownload = useShellStore((s) => s.startVoiceDownload);
  const dismissVoiceNotice = useShellStore((s) => s.dismissVoiceNotice);
  const recheckMicAccess = useShellStore((s) => s.recheckMicAccess);
  // Back in the window from System Settings, a line about access that no
  // longer holds comes down.
  const accessShut = notice?.kind === "mic" && notice.line !== "asking";
  useEffect(() => {
    if (!accessShut) return;
    window.addEventListener("focus", recheckMicAccess);
    return () => window.removeEventListener("focus", recheckMicAccess);
  }, [accessShut, recheckMicAccess]);
  if (!notice) return null;
  // A Mac names its own System Settings and opens them; another desktop's
  // settings differ by desktop, so the line names them and opens nothing.
  const mac = thisDesktop().mac;

  return (
    <NoticeStrip
      width={width}
      data-voice-notice={notice.kind === "mic" ? `mic-${notice.line}` : notice.kind}
    >
      {notice.kind === "consent" && (
        <>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
            Voice needs a one-time model download (about{" "}
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>1.6 GB</span>
            ). It runs on this machine; audio never leaves it.
          </span>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onClick={dismissVoiceNotice}>
              Not now
            </Button>
            <Button variant="primary" size="sm" onClick={startVoiceDownload}>
              Download
            </Button>
          </div>
        </>
      )}
      {notice.kind === "download" && (
        <>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", flexShrink: 0 }}>
            Downloading voice model
          </span>
          <div
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: "var(--bg-3)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.round(notice.fraction * 100)}%`,
                background: "var(--accent)",
                borderRadius: 2,
                transition: "width var(--dur-med) var(--ease-drift)",
              }}
            />
          </div>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-1)",
              flexShrink: 0,
            }}
          >
            {Math.round(notice.fraction * 100)}%
          </span>
        </>
      )}
      {notice.kind === "mic" && notice.line === "asking" && (
        <span style={TEXT}>
          {mac ? "macOS" : "Your desktop"} is asking whether Infinitary may use the microphone. What
          you say becomes text on {HERE.this} and is never stored.
        </span>
      )}
      {notice.kind === "mic" && notice.line === "off" && (
        <>
          <span style={TEXT}>
            {mac
              ? "Microphone access is off for Infinitary. Turn it on in System Settings, under Privacy & Security, Microphone."
              : "Microphone access is off for Infinitary. Turn it on in your desktop's privacy settings."}
          </span>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onClick={dismissVoiceNotice}>
              Close
            </Button>
            {mac && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void window.infinitary.voice.openMicSettings().catch(() => {})}
              >
                Open System Settings
              </Button>
            )}
          </div>
        </>
      )}
      {notice.kind === "mic" && notice.line === "managed" && (
        <>
          <span style={TEXT}>
            The administrator of {HERE.this} controls microphone access, so voice is off. You can
            still type.
          </span>
          <Button variant="ghost" size="sm" onClick={dismissVoiceNotice} style={{ flexShrink: 0 }}>
            Close
          </Button>
        </>
      )}
      {notice.kind === "error" && (
        <>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>{notice.message}</span>
          <Button variant="ghost" size="sm" onClick={dismissVoiceNotice} style={{ flexShrink: 0 }}>
            Close
          </Button>
        </>
      )}
    </NoticeStrip>
  );
}
