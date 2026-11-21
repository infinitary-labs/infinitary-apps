import * as m from "@shared/i18n/messages.generated";
import { useEffect } from "react";
import { Button } from "../design";
import { thisDesktop } from "../design/core/desktop";
import type { DictationField } from "../voice/dictationFields";
import { NoticeStrip } from "./NoticeStrip";
import { useShellStore } from "./store";

const TEXT = { fontSize: "var(--text-sm)", color: "var(--fg-2)" } as const;

/** Marks where the download's size sits in the consent line, so the size draws in its own type. */
const SIZE_MARK = "\u0000";

/**
 * The quiet voice status strip under the input: first-use download consent
 * with progress (section 8), microphone access (docs/composer.md, "Voice"),
 * and capture/transcription errors. Hidden when there is nothing to say.
 * It draws under the field the latest press of the dictation key writes
 * into (`voiceField`): under the main input without `field`, under that
 * field with it.
 */
export function VoiceNotice({
  width,
  field = null,
}: {
  width: string;
  field?: DictationField | null;
}) {
  const notice = useShellStore((s) => (s.voiceField === field ? s.voiceNotice : null));
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
  // A Mac and Windows name their own settings and open them; another
  // desktop's differ by desktop, so the line names them and opens nothing.
  const { mac, windows } = thisDesktop();
  const [beforeSize, afterSize = ""] = m.shellVoiceConsent({ size: SIZE_MARK }).split(SIZE_MARK);

  return (
    <NoticeStrip
      width={width}
      data-voice-notice={notice.kind === "mic" ? `mic-${notice.line}` : notice.kind}
    >
      {notice.kind === "consent" && (
        <>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
            {beforeSize}
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-1)" }}>
              {m.shellVoiceModelSize()}
            </span>
            {afterSize}
          </span>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onClick={dismissVoiceNotice}>
              {m.shellVoiceNotNow()}
            </Button>
            <Button variant="primary" size="sm" onClick={startVoiceDownload}>
              {m.shellVoiceDownload()}
            </Button>
          </div>
        </>
      )}
      {notice.kind === "download" && (
        <>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", flexShrink: 0 }}>
            {m.shellVoiceDownloading()}
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
        <span style={TEXT}>{mac ? m.shellVoiceAskingMac() : m.shellVoiceAskingDesktop()}</span>
      )}
      {notice.kind === "mic" && notice.line === "off" && (
        <>
          <span style={TEXT}>
            {mac
              ? m.shellVoiceMicOffMac()
              : windows
                ? m.shellVoiceMicOffWindows()
                : m.shellVoiceMicOffDesktop()}
          </span>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <Button variant="ghost" size="sm" onClick={dismissVoiceNotice}>
              {m.shellVoiceClose()}
            </Button>
            {(mac || windows) && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void window.infinitary.voice.openMicSettings().catch(() => {})}
              >
                {mac ? m.shellVoiceOpenSettings() : m.shellVoiceOpenWindowsSettings()}
              </Button>
            )}
          </div>
        </>
      )}
      {notice.kind === "mic" && notice.line === "managed" && (
        <>
          <span style={TEXT}>{m.shellVoiceManaged()}</span>
          <Button variant="ghost" size="sm" onClick={dismissVoiceNotice} style={{ flexShrink: 0 }}>
            {m.shellVoiceClose()}
          </Button>
        </>
      )}
      {notice.kind === "error" && (
        <>
          <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>{notice.message}</span>
          <Button variant="ghost" size="sm" onClick={dismissVoiceNotice} style={{ flexShrink: 0 }}>
            {m.shellVoiceClose()}
          </Button>
        </>
      )}
    </NoticeStrip>
  );
}
