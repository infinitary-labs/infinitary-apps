import {
  DIAGNOSTIC_EVENT_NAMES,
  DIAGNOSTIC_EVENTS,
  type DiagnosticEventSpec,
} from "@shared/diagnostics";
import { formatDate, formatTime } from "@shared/i18n/format";
import {
  DIAGNOSTICS_NOTHING_WAITING,
  DIAGNOSTICS_SUMMARY,
  type SharingAskAnswer,
  type SharingChannel,
  type SharingPreview,
  type SharingView,
} from "@shared/sharing";
import type React from "react";
import { useEffect, useState } from "react";
import termsSource from "../../../../DATA-TERMS.md?raw";
import { useShellStore } from "../app/store";
import { Button, Disclosure, Empty, Switch } from "../design";
import { useFirstMatePlace } from "../devices/useFirstMatePlace";
import { waitsForUpdate } from "../devices/viewWords";
import { ROW_GAP, SECTION_GAP, SectionLabel, SettingError, SettingRow } from "./settingRows";
import { useSettingSave } from "./useSettingSave";

/**
 * The two switches (roadmap 1.4, `docs/sharing.md`): the Sharing section of
 * Settings -> General. Diagnostics - a fixed set of anonymous events with
 * the app version and a random install ID (`src/shared/diagnostics.ts`) -
 * is on out of the box and this switch is its opt-out; contribution is
 * off. No feature is gated on either.
 *
 * The section keeps three promises on screen: what a channel sends is
 * SHOWN before its first send (the first-launch notice, or this viewer -
 * turning a switch on that was never shown opens it, and the core sends
 * nothing until it has painted and said so), it stays INSPECTABLE
 * afterwards (the viewer lists what was sent), and the terms in force are
 * the ones this build ships (the file rendered under "The terms", bundled
 * beside the code).
 *
 * The contribution switch and "The terms" exist only once the terms are
 * published; until then the section has one switch and shows no terms.
 * The unpublished draft is not in force, and it describes a build where
 * Diagnostics is absent - shown under the switch that is on, it would
 * contradict the row above it. The row, the viewer and the alpha notice
 * are what describe an unpublished build (`docs/sharing.md`).
 */

const CHANNELS: readonly SharingChannel[] = ["diagnostics", "contribution"];

/** The install ID's promise, said wherever the ID is. */
export function installIdNote(place: { this: string }): string {
  return `The install ID is random, tied to nothing about you or ${place.this}, and replaced with a new one whenever Diagnostics is turned off and back on.`;
}

/** The rows' words: one function, so a build's honesty is a fact of the view, not the copy. */
export function sharingRowDescription(view: SharingView, channel: SharingChannel): string {
  if (channel === "diagnostics") {
    return view.diagnosticsDestination
      ? `${DIAGNOSTICS_SUMMARY} Sent to ${view.diagnosticsDestination}. Never a conversation, code or a card.`
      : `${DIAGNOSTICS_SUMMARY} This build has nowhere to send them, so nothing leaves either way.`;
  }
  return "Redacted records of your first mate's own decisions, so the next model learns from them. Shown in full before anything is sent.";
}

/** A channel the person turned on and has not yet seen the payload of. */
export function channelsAwaitingView(view: SharingView): SharingChannel[] {
  return CHANNELS.filter(
    (channel) =>
      view[channel].enabled &&
      view[channel].viewedAt === null &&
      (channel === "diagnostics" ? view.diagnosticsDestination !== null : view.termsPublished),
  );
}

/** Everything the section paints, from the values alone (tested as markup). */
export type SharingSectionViewProps = {
  view: SharingView | null;
  /** Why a switch's last change was refused, beside that switch. */
  refusal?: { channel: SharingChannel; message: string } | null;
  /** A change is still being saved: the switches wait for its answer. */
  saving?: boolean;
  preview: SharingPreview | null;
  viewerOpen: boolean;
  termsOpen: boolean;
  onSwitch: (channel: SharingChannel, enabled: boolean) => void;
  onViewer: (open: boolean) => void;
  onTerms: (open: boolean) => void;
};

export function SharingSectionView({
  view,
  refusal = null,
  saving = false,
  preview,
  viewerOpen,
  termsOpen,
  onSwitch,
  onViewer,
  onTerms,
}: SharingSectionViewProps) {
  const place = useFirstMatePlace();
  const pendingCount = preview
    ? preview.diagnostics.pending.length +
      (view?.termsPublished ? preview.contribution.pendingCount : 0)
    : undefined;
  return (
    <div data-sharing-section style={{ marginTop: SECTION_GAP }}>
      <SectionLabel>Sharing</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
        <SettingRow
          id="diagnostics"
          error={refusal?.channel === "diagnostics" ? refusal.message : null}
          title="Diagnostics"
          description={view ? sharingRowDescription(view, "diagnostics") : DIAGNOSTICS_SUMMARY}
          control={
            <Switch
              checked={view?.diagnostics.enabled ?? false}
              disabled={!view || saving}
              onChange={(checked) => onSwitch("diagnostics", checked)}
            />
          }
        />
        {view?.termsPublished ? (
          <SettingRow
            id="contribution"
            error={refusal?.channel === "contribution" ? refusal.message : null}
            title="Contribution"
            description={sharingRowDescription(view, "contribution")}
            control={
              <Switch
                checked={view.contribution.enabled}
                disabled={saving}
                onChange={(checked) => onSwitch("contribution", checked)}
              />
            }
          />
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "0 -6px 0" }}>
          <Disclosure
            label={`What would leave ${place.this}`}
            count={pendingCount}
            open={viewerOpen}
            onToggle={onViewer}
          >
            {viewerOpen ? <PayloadViewer view={view} preview={preview} /> : null}
          </Disclosure>
          {view?.termsPublished ? (
            <Disclosure
              label="The terms"
              count={view.termsVersion}
              open={termsOpen}
              onToggle={onTerms}
            >
              {termsOpen ? <Terms /> : null}
            </Disclosure>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The payload, exactly as it would go (or went), one record at a time. */
function PayloadViewer({
  view,
  preview,
}: {
  view: SharingView | null;
  preview: SharingPreview | null;
}) {
  if (!preview) {
    return (
      <div data-sharing-viewer style={{ padding: "6px 6px 2px" }}>
        <Empty>Reading...</Empty>
      </div>
    );
  }
  const diagnosticsOn = view?.diagnostics.enabled ?? false;
  return (
    <div
      data-sharing-viewer
      style={{ display: "flex", flexDirection: "column", gap: 14, padding: "6px 6px 2px" }}
    >
      <InstallId installId={view?.diagnostics.installId ?? null} />
      <RecordList
        title="Diagnostics waiting to send"
        kind="diagnostics-pending"
        records={preview.diagnostics.pending.map((record) => ({
          key: `${record.at}-${record.name}`,
          name: record.name,
          at: record.at,
          body: record.body,
        }))}
        empty={diagnosticsOn ? DIAGNOSTICS_NOTHING_WAITING.on : DIAGNOSTICS_NOTHING_WAITING.off}
      />
      {preview.diagnostics.sent.length > 0 ? (
        <RecordList
          title="Diagnostics sent"
          kind="diagnostics-sent"
          records={preview.diagnostics.sent.map((record) => ({
            key: `${record.at}-${record.name}`,
            name: record.name,
            at: record.at,
            body: record.body,
          }))}
          empty=""
        />
      ) : null}
      <EventCatalog />
      {view?.termsPublished ? (
        <RecordList
          title={
            preview.contribution.pendingCount > preview.contribution.pending.length
              ? `Decision records waiting to send (newest ${preview.contribution.pending.length} of ${preview.contribution.pendingCount})`
              : "Decision records waiting to send"
          }
          kind="contribution-pending"
          records={preview.contribution.pending.map((record, index) => ({
            key: `${String(record.ref ?? index)}-${String(record.taskId ?? "")}`,
            name: String(record.ref ?? "decision"),
            at: typeof record.at === "number" ? record.at : null,
            body: record,
          }))}
          empty="No decision records yet."
        />
      ) : null}
    </div>
  );
}

const viewerHeading: React.CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  fontWeight: 500,
};

const viewerNote: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
};

/** The one identifier every event carries, shown as it goes. */
function InstallId({ installId }: { installId: string | null }) {
  const place = useFirstMatePlace();
  return (
    <div data-sharing-install-id style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={viewerHeading}>Anonymous install ID</div>
      <code
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: installId ? "var(--fg-1)" : "var(--fg-3)",
          wordBreak: "break-all",
        }}
      >
        {installId ?? "none while Diagnostics is off"}
      </code>
      <div style={viewerNote}>{installIdNote(place)}</div>
    </div>
  );
}

/**
 * Every event Diagnostics can send and every field it carries, read from
 * the allowlist itself (`src/shared/diagnostics.ts`), so the list cannot
 * drift from what the wire allows.
 */
function EventCatalog() {
  return (
    <div data-sharing-catalog style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={viewerHeading}>Everything Diagnostics can send</div>
      <div style={viewerNote}>
        Each event also carries the app version and the install ID, and nothing else: no text you
        wrote, no names, no paths.
      </div>
      {DIAGNOSTIC_EVENT_NAMES.map((name) => {
        const spec: DiagnosticEventSpec = DIAGNOSTIC_EVENTS[name];
        const fields = Object.entries(spec.fields);
        return (
          <div
            key={name}
            data-sharing-catalog-event={name}
            style={{ display: "flex", flexDirection: "column", gap: 2 }}
          >
            <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "baseline" }}>
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-1)",
                }}
              >
                {name}
              </code>
              <span style={viewerNote}>{spec.description}</span>
            </div>
            {fields.map(([field, fieldSpec]) => (
              <div
                key={field}
                data-sharing-catalog-field={field}
                style={{ ...viewerNote, fontFamily: "var(--font-mono)", paddingInlineStart: 12 }}
              >
                {field}: {fieldSpec.type === "enum" ? fieldSpec.values.join(" | ") : fieldSpec.type}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

type ViewerRecord = { key: string; name: string; at: number | null; body: unknown };

function RecordList({
  title,
  kind,
  records,
  empty,
}: {
  title: string;
  kind: string;
  records: ViewerRecord[];
  empty: string;
}) {
  return (
    <div data-sharing-records={kind} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={viewerHeading}>{title}</div>
      {records.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        records.map((record) => (
          <details
            key={record.key}
            data-sharing-record={record.name}
            style={{
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-m)",
              padding: "8px 12px",
            }}
          >
            <summary
              style={{
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                gap: "var(--space-3)",
                fontSize: "var(--text-sm)",
                color: "var(--fg-1)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span>{record.name}</span>
              {record.at !== null ? (
                <span style={{ color: "var(--fg-3)" }}>{formatWhen(record.at)}</span>
              ) : null}
            </summary>
            <pre
              style={{
                margin: "8px 0 0",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                lineHeight: 1.5,
                color: "var(--fg-2)",
              }}
            >
              {JSON.stringify(record.body, null, 2)}
            </pre>
          </details>
        ))
      )}
    </div>
  );
}

function formatWhen(at: number): string {
  const date = new Date(at);
  return `${formatDate(date)} ${formatTime(date, { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * The terms this build ships, read from the file beside the code. The file
 * is plain prose - headings, paragraphs, a bold lead - so the reader here
 * is deliberately small and renders nothing it does not know.
 */
export function renderTerms(source: string): React.ReactNode {
  const keys = new KeyCounter();
  const nodes = source
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((text) => {
      const key = keys.for(text);
      const heading = /^(#{1,3})\s+(.*)$/.exec(text);
      if (heading) {
        const level = heading[1]?.length ?? 1;
        const body = heading[2] ?? "";
        const style: React.CSSProperties = {
          margin: level === 1 ? "0 0 4px" : "14px 0 2px",
          fontSize: level === 1 ? "var(--text-base)" : "var(--text-sm)",
          fontWeight: 600,
          color: "var(--fg-1)",
        };
        return level === 1 ? (
          <h3 key={key} style={style}>
            {body}
          </h3>
        ) : (
          <h4 key={key} style={style}>
            {body}
          </h4>
        );
      }
      return (
        <p
          key={key}
          style={{ margin: 0, fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--fg-2)" }}
        >
          {renderInline(text.replace(/\n/g, " "))}
        </p>
      );
    });
  return <>{nodes}</>;
}

function renderInline(text: string): React.ReactNode {
  const keys = new KeyCounter();
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={keys.for(part)} style={{ color: "var(--fg-1)", fontWeight: 600 }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={keys.for(part)} style={{ fontFamily: "var(--font-mono)" }}>
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  });
  return <>{parts}</>;
}

/** Keys from the content itself, a repeat told apart by how often it has appeared. */
class KeyCounter {
  private readonly seen = new Map<string, number>();

  for(text: string): string {
    const count = (this.seen.get(text) ?? 0) + 1;
    this.seen.set(text, count);
    return count === 1 ? text : `${text}#${count}`;
  }
}

function Terms() {
  return (
    <div
      data-sharing-terms
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: "6px 6px 2px" }}
    >
      {renderTerms(termsSource)}
    </div>
  );
}

/** The section wired to the core: reads once, follows every push, writes through. */
export function SharingSection() {
  const save = useSharingSave();
  const view = save.value;
  // Which switch the last change was, so a refusal is told beside it.
  const [changed, setChanged] = useState<SharingChannel | null>(null);
  const [preview, setPreview] = useState<SharingPreview | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const awaiting = view ? channelsAwaitingView(view) : [];
  const awaitingKey = awaiting.join(",");

  // A switch turned on with the payload never seen opens the viewer itself:
  // the terms say the payload is shown before the first send, so the app
  // shows it rather than hoping the person looks.
  useEffect(() => {
    if (awaitingKey) setViewerOpen(true);
  }, [awaitingKey]);

  // The viewer's value, re-read on every change of the row while it is open.
  useEffect(() => {
    if (!viewerOpen || !view) return;
    let cancelled = false;
    void window.infinitary.settings.sharingPreview().then((next) => {
      if (!cancelled) setPreview(next);
    });
    return () => {
      cancelled = true;
    };
  }, [viewerOpen, view]);

  // Viewed means painted: the stamp goes only once the preview is on screen,
  // and the core's first send follows it.
  useEffect(() => {
    if (!viewerOpen || !preview || !awaitingKey) return;
    for (const channel of awaitingKey.split(",") as SharingChannel[]) {
      void window.infinitary.settings.markSharingViewed(channel);
    }
  }, [viewerOpen, preview, awaitingKey]);

  return (
    <SharingSectionView
      view={view}
      refusal={changed && save.error ? { channel: changed, message: save.error } : null}
      saving={save.saving}
      preview={preview}
      viewerOpen={viewerOpen}
      termsOpen={termsOpen}
      onSwitch={(channel, enabled) => {
        setChanged(channel);
        void save.save(() => window.infinitary.settings.setSharing(channel, enabled));
      }}
      onViewer={setViewerOpen}
      onTerms={setTermsOpen}
    />
  );
}

/**
 * The sharing view for a control that changes it (../settings/settingSave.ts):
 * read on opening, following every push, and read again after a refused
 * change. A view that cannot be read shows nothing; only a change of the
 * person's own says why it failed. The first-launch notice shares this writer
 * and supplies its own recovery hint because it lives outside Settings.
 */
export function useSharingSave(recoveryHint?: string) {
  const save = useSettingSave(() => window.infinitary.settings.getSharing(), recoveryHint);
  const waits = useShellStore((s) => waitsForUpdate(s.thisMac));
  useEffect(() => {
    if (!waits) void save.refresh();
    try {
      return window.infinitary.settings.onSharing(save.apply);
    } catch {
      return undefined;
    }
  }, [save.refresh, save.apply, waits]);
  return save;
}

/**
 * The one-time ask (DATA-TERMS.md section 6): the local model was just
 * enabled, and the app asks once whether to contribute. "Not now" is a
 * full answer. Painted at the top of Settings while it is pending, because
 * that is where the person is when a model gets turned on.
 */
export function SharingAskView({
  onAnswer,
  error = null,
  saving = false,
}: {
  onAnswer: (answer: SharingAskAnswer) => void;
  /** Why the last answer was refused; the ask stays until one is saved. */
  error?: string | null;
  saving?: boolean;
}) {
  return (
    <div
      data-sharing-ask
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        padding: "14px 18px",
        marginBottom: 20,
        background: "var(--accent-dim)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "var(--text-base)", color: "var(--fg-1)", fontWeight: 500 }}>
          Help the next model learn?
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
          The local model was trained on decision records people chose to share. Your first mate can
          send redacted records of its own, shown in full before anything leaves. The model works
          the same either way, and this is the only time the app asks.
        </div>
        <SettingError error={error} surface="sharing-ask" />
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <Button variant="secondary" size="sm" disabled={saving} onClick={() => onAnswer("not-now")}>
          Not now
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={saving}
          onClick={() => onAnswer("contribute")}
        >
          Contribute
        </Button>
      </div>
    </div>
  );
}

export function SharingAsk() {
  const save = useSharingSave();
  if (!save.value?.askPending) return null;
  return (
    <SharingAskView
      error={save.error}
      saving={save.saving}
      onAnswer={(answer) => {
        void save.save(() => window.infinitary.settings.answerSharingAsk(answer));
      }}
    />
  );
}
