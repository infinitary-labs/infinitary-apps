import * as m from "@shared/i18n/messages.generated";
import { DIAGNOSTICS_NOTICE_TEXT, type SharingView } from "@shared/sharing";
import { useState } from "react";
import { Button } from "../design";
import { useSharingSave } from "../settings/SharingSection";
import { SettingError } from "../settings/settingRows";
import { NoticeStrip } from "./NoticeStrip";

/**
 * The first-launch disclosure of Diagnostics (`docs/sharing.md`; on by
 * default since the EONA alpha decision of 2026-09-22): the first launch
 * says what it sends, under the input, with the way off beside it.
 *
 * Every event waits for this notice. It shows while the switch is on, this
 * build has somewhere to send, and the person has never been shown what it
 * sends (`viewedAt`); it stays, launch after launch, until they answer it.
 * "OK" is the showing the core waits for, and what waited goes;
 * "Turn off" is the opt-out, and nothing is ever sent (turned back on in
 * Settings, the viewer opens first, as for any switch never shown). Opening
 * the viewer in Settings is a showing too, so a person who went there first
 * never sees this.
 */

/** Whether the notice is owed: on, somewhere to send, never shown. */
export function diagnosticsNoticeDue(view: SharingView): boolean {
  return (
    view.diagnostics.enabled &&
    view.diagnostics.viewedAt === null &&
    view.diagnosticsDestination !== null
  );
}

export function DiagnosticsNoticeView({
  width,
  onTurnOff,
  onOk,
  error = null,
  enabled = true,
  pending = null,
}: {
  width: string;
  onTurnOff: () => void;
  onOk: () => void;
  error?: string | null;
  enabled?: boolean;
  pending?: "off" | "ok" | null;
}) {
  return (
    <NoticeStrip width={width} data-diagnostics-notice data-diagnostics-enabled={enabled}>
      <div style={{ minWidth: 0, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
        {DIAGNOSTICS_NOTICE_TEXT}
        <SettingError
          error={error ? `${error} Last saved: Diagnostics ${enabled ? "on" : "off"}.` : null}
        />
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== null}
          pending={pending === "off"}
          pendingLabel={m.shellDiagnosticsSaving()}
          onClick={onTurnOff}
        >
          {m.shellDiagnosticsTurnOff()}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={pending !== null}
          pending={pending === "ok"}
          pendingLabel={m.shellDiagnosticsSaving()}
          onClick={onOk}
        >
          {m.shellDiagnosticsOk()}
        </Button>
      </div>
    </NoticeStrip>
  );
}

export function DiagnosticsNotice({ width }: { width: string }) {
  const save = useSharingSave(m.shellDiagnosticsRetry());
  const [action, setAction] = useState<"off" | "ok">("off");
  const view = save.value;
  // A refusal remains visible even if a partial write made the notice no
  // longer due. Only a successful receipt (or a saved push) dismisses it.
  if (!view || (!diagnosticsNoticeDue(view) && !save.error && !save.saving)) return null;
  return (
    <DiagnosticsNoticeView
      width={width}
      error={save.error}
      enabled={view.diagnostics.enabled}
      pending={save.saving ? action : null}
      onTurnOff={() => {
        setAction("off");
        void save.save(() => window.infinitary.settings.setSharing("diagnostics", false));
      }}
      onOk={() => {
        setAction("ok");
        void save.save(() => window.infinitary.settings.markSharingViewed("diagnostics"));
      }}
    />
  );
}
