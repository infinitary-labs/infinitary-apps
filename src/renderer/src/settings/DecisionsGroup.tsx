import type {
  DecisionConsentText,
  DecisionModelId,
  DecisionsSettings,
  DecisionsView,
  OpenRouterDecisionOffering,
} from "@shared/decisions";
import {
  DECISION_MODEL_CATALOG,
  decisionConsent,
  decisionModelRow,
  openRouterDecisionConsent,
  openRouterDecisionLine,
} from "@shared/decisions";
import {
  DECISION_APPROVAL_VERSION,
  type DecisionUseRequest,
  type DecisionUseView,
} from "@shared/decisionUses";
import * as m from "@shared/i18n/messages.generated";
import { modelNames } from "@shared/modelDisplayName";
import type { ModelSlotsView } from "@shared/modelSlots";
import { offeringKey } from "@shared/modelSlots";
import { useState } from "react";
import { Button, Input, RowMenu, type RowMenuItem, StatusDot, type StatusDotTone } from "../design";
import { ConsentDialog } from "../design/core/ConsentDialog";
import { useOverflowTitle } from "../design/core/overflowTitle";
import { Switch } from "../design/core/Switch";
import { DECISION_USES_WORDS, MODELS_WORDS } from "./modelsWords";

const CARD_MAX_ROWS_HEIGHT = 232;

const LABEL_STYLE = {
  fontSize: "var(--text-xs)",
  fontWeight: 500,
  letterSpacing: "var(--tracking-label)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
} as const;

/** What the consent dialog is open for, if anything. */
type Consent =
  | { kind: "native"; id: DecisionModelId }
  | { kind: "openrouter"; model: OpenRouterDecisionOffering }
  | { kind: "use"; use: DecisionUseView };

function rows(text: DecisionConsentText | readonly string[]) {
  return MODELS_WORDS.decisionDisclosureLabels.map(
    (label, index) => [label, text[index] ?? ""] as const,
  );
}

/**
 * The Decisions group (`docs/decision-models.md`): the answerer row on top,
 * and under it the Uses list, one switch per way Infinitary asks a decision
 * model, drawn from the home's view of `src/shared/decisionUses.ts` alone.
 * Every approval goes through the one `ConsentDialog`: turning Jev on (its
 * key field inside), picking an OpenRouter model not yet approved, and the
 * one-time OK a use needs when the answering model was approved on an older
 * screen. A home on an older version sends no uses, and the group draws the
 * answerer row alone.
 */
export function DecisionsGroup({
  decisions,
  slots,
  onSetDecisions,
  onSetDecisionKey,
  onRemoveDecisionKey,
  onSetDecisionUse,
}: {
  decisions: DecisionsView;
  slots: Pick<ModelSlotsView, "models" | "byName">;
  onSetDecisions: (decisions: DecisionsSettings) => void;
  onSetDecisionKey: (id: DecisionModelId, key: string) => Promise<boolean>;
  onRemoveDecisionKey: (id: DecisionModelId) => void;
  onSetDecisionUse: (request: DecisionUseRequest) => void;
}) {
  const { models, byName } = slots;
  const [pickingOpenRouter, setPickingOpenRouter] = useState(false);
  const [pickingDecisionModel, setPickingDecisionModel] = useState(false);
  const [consent, setConsent] = useState<Consent | null>(null);
  /**
   * The key as it is being typed, and nowhere else. It is cleared the
   * moment it is submitted or the dialog is closed, and no state here ever
   * holds a key that was already stored: the view cannot return one.
   */
  const [keyDraft, setKeyDraft] = useState("");

  const answerer = decisions.settings.answerer;
  const write = (next: DecisionsSettings) => onSetDecisions(next);
  const chooseAdapted = (offering: string) =>
    write({ ...decisions.settings, answerer: { kind: "adapted", offering } });
  /**
   * The approval screen this view shows, as the home can keep it: an older
   * home has no newer screen to record, so it is recorded as its own.
   */
  const screen = Math.min(
    DECISION_APPROVAL_VERSION,
    decisions.approvalVersion ?? decisions.stateVersion,
  );
  /** An approval just given in the dialog, never lowering one already given. */
  const approved = (family: string) => ({
    enabled: true,
    consentedVersion: Math.max(decisions.settings.egress[family]?.consentedVersion ?? -1, screen),
  });
  /** Picking again a model approved before keeps the screen it was approved on. */
  const kept = (family: string) => ({
    enabled: true,
    consentedVersion: decisions.settings.egress[family]?.consentedVersion ?? screen,
  });

  const natives = DECISION_MODEL_CATALOG.map((row) => {
    const native = decisions.natives.find((entry) => entry.id === row.id);
    const chosen = answerer.kind === "native" && answerer.id === row.id;
    return { row, native, chosen, state: native?.keyStored ? native.state : ("absent" as const) };
  });

  // A pick is named only while it is the model answering.
  const pinned = answerer.kind === "adapted" ? decisions.pinned : undefined;
  const activeNative = natives.find((entry) => entry.chosen && entry.state === "ready");
  const rejected = natives.find((entry) => entry.chosen && entry.state === "key-rejected");

  const chooseOpenRouter = (model: OpenRouterDecisionOffering, justApproved: boolean) => {
    write({
      ...decisions.settings,
      answerer: { kind: "openrouter", model: model.id },
      egress: {
        ...decisions.settings.egress,
        openrouter: justApproved ? approved("openrouter") : kept("openrouter"),
      },
    });
    setPickingOpenRouter(false);
  };
  const openRouterModel =
    answerer.kind === "openrouter"
      ? decisions.openrouter?.models.find((model) => model.id === answerer.model)
      : undefined;
  const openRouterReady = openRouterModel && decisions.openrouter?.state === "ready";
  /** The answering Jev or OpenRouter model, by name and with its approval screen's rows. */
  const answering =
    answerer.kind === "native"
      ? (() => {
          const row = decisionModelRow(answerer.id);
          return row ? { name: row.name, consent: decisionConsent(row) } : undefined;
        })()
      : answerer.kind === "openrouter" && openRouterModel
        ? { name: openRouterModel.name, consent: openRouterDecisionConsent(openRouterModel) }
        : undefined;

  const menu: RowMenuItem[] = [
    ...(decisions.openrouter?.models.length
      ? [
          {
            id: "openrouter",
            label: MODELS_WORDS.useOpenRouterDecisionModel,
            onSelect: () => {
              setPickingOpenRouter((open) => !open);
              setPickingDecisionModel(false);
            },
          },
        ]
      : []),
    ...(answerer.kind === "adapted" && answerer.offering === "auto"
      ? []
      : [
          {
            id: "auto",
            label: m.settingsDecisionsUseAuto(),
            onSelect: () => chooseAdapted("auto"),
          },
        ]),
    {
      id: "specific",
      label: m.settingsDecisionsUseSpecific(),
      onSelect: () => setPickingDecisionModel((open) => !open),
    },
    ...natives.map((entry) => ({
      id: `native-${entry.row.id}`,
      label: entry.chosen
        ? m.settingsDecisionsTurnOff({ model: entry.row.name })
        : m.settingsDecisionsUseNative({ model: entry.row.name, vendor: entry.row.vendor }),
      onSelect: () => {
        if (entry.chosen) {
          chooseAdapted("auto");
          return;
        }
        if (entry.native?.keyStored && entry.native.consented) {
          write({
            ...decisions.settings,
            answerer: { kind: "native", id: entry.row.id },
            egress: { ...decisions.settings.egress, [entry.row.id]: kept(entry.row.id) },
          });
          return;
        }
        setConsent({ kind: "native", id: entry.row.id });
      },
    })),
    ...natives
      .filter((entry) => entry.native?.keyStored)
      .flatMap((entry) => [
        {
          id: `replace-${entry.row.id}`,
          label: m.settingsDecisionsReplaceKey({ model: entry.row.name }),
          onSelect: () => setConsent({ kind: "native", id: entry.row.id }),
        },
        {
          id: `remove-${entry.row.id}`,
          label: m.settingsDecisionsRemove({ model: entry.row.name }),
          onSelect: () => onRemoveDecisionKey(entry.row.id),
        },
      ]),
  ];

  const line =
    answerer.kind === "openrouter"
      ? openRouterReady
        ? openRouterDecisionLine(openRouterModel)
        : m.settingsDecisionsOpenRouterUnavailable()
      : activeNative
        ? m.settingsDecisionsLineNative({
            model: activeNative.row.name,
            vendor: activeNative.row.vendor,
          })
        : rejected
          ? m.settingsDecisionsKeyRejected()
          : pinned === "ready" && answerer.kind === "adapted"
            ? modelNames([...models, ...byName])(answerer.offering)
            : pinned === "fallback"
              ? m.settingsDecisionsChosenFallback()
              : pinned === "held"
                ? m.settingsDecisionsChosenHeld()
                : m.settingsDecisionsAuto();
  const tone = rejected
    ? "danger"
    : pinned === "held"
      ? "warn"
      : activeNative || openRouterReady
        ? "ok"
        : "ring";
  const last = openRouterReady ? decisions.openrouter?.last : activeNative?.native?.last;

  const switchUse = (use: DecisionUseView, on: boolean) => {
    if (use.kind === "always-on") return;
    if (!on) {
      onSetDecisionUse({ id: use.id, on: false });
      return;
    }
    if ((use.needsApproval && answering) || use.disclosure) {
      setConsent({ kind: "use", use });
      return;
    }
    onSetDecisionUse({ id: use.id, on: true });
  };

  const closeConsent = () => {
    setKeyDraft("");
    setConsent(null);
  };

  const dialog = () => {
    if (!consent) return null;
    if (consent.kind === "native") {
      const row = decisionModelRow(consent.id);
      if (!row) return null;
      return (
        <ConsentDialog
          title={DECISION_USES_WORDS.turnOnNamed(row.name)}
          facts={rows(decisionConsent(row))}
          act={DECISION_USES_WORDS.turnOn}
          actDisabled={!keyDraft.trim()}
          onClose={closeConsent}
          onAct={() => {
            const key = keyDraft.trim();
            if (!key) return;
            // Two acts, in order: store the credential, then make this the
            // model that answers with the approval just given. The core
            // keeps them apart - a key is not a pick - so the dialog that
            // means "use Jev" says both.
            void onSetDecisionKey(row.id, key).then((saved) => {
              if (!saved) return;
              write({
                ...decisions.settings,
                answerer: { kind: "native", id: row.id },
                egress: { ...decisions.settings.egress, [row.id]: approved(row.id) },
              });
            });
            closeConsent();
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
            <Input
              // Write-only: the field starts empty every time, and no call
              // this component can make ever returns a stored key.
              type="password"
              mono
              autoComplete="off"
              aria-label={m.settingsDecisionsKeyLabel({ model: row.name })}
              placeholder={m.settingsDecisionsKeyPlaceholder({ vendor: row.vendor })}
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
            />
            <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
              {m.settingsDecisionsKeysFrom({ url: row.keysUrl })}
            </span>
          </div>
        </ConsentDialog>
      );
    }
    if (consent.kind === "openrouter") {
      const model = consent.model;
      return (
        <ConsentDialog
          title={m.settingsDecisionsTurnOnOpenRouter({ model: model.name })}
          facts={rows(openRouterDecisionConsent(model))}
          act={DECISION_USES_WORDS.turnOn}
          onClose={closeConsent}
          onAct={() => {
            chooseOpenRouter(model, true);
            closeConsent();
          }}
        />
      );
    }
    const { use } = consent;
    const approval = use.needsApproval ? answering : undefined;
    return (
      <ConsentDialog
        title={
          approval
            ? DECISION_USES_WORDS.allowTitle(use.name, approval.name)
            : DECISION_USES_WORDS.turnOnNamed(use.name)
        }
        facts={[
          ...(approval ? rows(approval.consent) : []),
          ...(use.disclosure ? rows(use.disclosure.text) : []),
        ]}
        act={approval ? DECISION_USES_WORDS.allow : DECISION_USES_WORDS.turnOn}
        onClose={closeConsent}
        onAct={() => {
          onSetDecisionUse({
            id: use.id,
            on: true,
            ...(approval ? { approve: screen } : {}),
            ...(use.disclosure ? { agreed: use.disclosure.version } : {}),
          });
          closeConsent();
        }}
      />
    );
  };

  return (
    <div
      data-slot-group="decisions"
      style={{
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
        <span style={{ ...LABEL_STYLE }}>{m.settingsDecisionsHeading()}</span>
        <span style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)", minWidth: 0, flex: 1 }}>
          {m.settingsDecisionsSubtitle()}
        </span>
      </div>
      <DecisionAnswerer
        line={line}
        tone={tone}
        danger={Boolean(rejected)}
        last={last}
        items={menu}
      />
      {pickingOpenRouter && !!decisions.openrouter?.models.length && (
        <fieldset
          aria-label={m.settingsDecisionsOpenRouterModels()}
          style={{
            border: 0,
            borderTop: "1px solid var(--line-1)",
            margin: 0,
            padding: "8px 0",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {decisions.openrouter.models.map((model) => (
            <Button
              key={model.id}
              variant="ghost"
              size="sm"
              onClick={() => {
                if (decisions.openrouter?.consented) chooseOpenRouter(model, false);
                else setConsent({ kind: "openrouter", model });
              }}
            >
              {m.settingsDecisionsOpenRouterPrice({
                model: model.name,
                vendor: model.vendor,
                price: String(model.inputPrice),
              })}
            </Button>
          ))}
        </fieldset>
      )}
      {pickingDecisionModel && (
        <fieldset
          id="fm-decision-picker"
          aria-label={m.settingsDecisionsPicker()}
          className="fm-subs-scroll"
          style={{
            borderTop: "1px solid var(--line-1)",
            margin: 0,
            paddingTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: CARD_MAX_ROWS_HEIGHT,
            overflowY: "auto",
          }}
        >
          {models.map((model) => (
            <button
              key={offeringKey(model)}
              type="button"
              aria-label={m.settingsDecisionsAnswerWith({ model: model.label })}
              onClick={() => {
                chooseAdapted(offeringKey(model));
                setPickingDecisionModel(false);
              }}
              style={{
                background: "transparent",
                border: 0,
                borderRadius: "var(--radius-s)",
                color: "var(--fg-2)",
                cursor: "pointer",
                display: "flex",
                gap: 10,
                padding: "7px 8px",
                textAlign: "start",
              }}
            >
              <span style={{ ...LABEL_STYLE, textTransform: "none", letterSpacing: 0, width: 64 }}>
                {model.providerLabel}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-sm)",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {model.label}
              </span>
            </button>
          ))}
        </fieldset>
      )}
      {decisions.uses && (
        <section
          aria-label={DECISION_USES_WORDS.group}
          style={{
            borderTop: "1px solid var(--line-1)",
            paddingTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            minWidth: 0,
          }}
        >
          <span aria-hidden="true" style={LABEL_STYLE}>
            {DECISION_USES_WORDS.group}
          </span>
          {decisions.uses.map((use) => (
            <DecisionUseRow
              key={use.id}
              use={use}
              approvalFor={use.needsApproval && !use.on ? answering?.name : undefined}
              onSwitch={(on) => switchUse(use, on)}
            />
          ))}
        </section>
      )}
      {dialog()}
    </div>
  );
}

/** One use: its name, how it helps and what it reads, and its switch at the row's right edge. */
function DecisionUseRow({
  use,
  approvalFor,
  onSwitch,
}: {
  use: DecisionUseView;
  /** The answering model whose older approval this use waits on, if it does. */
  approvalFor: string | undefined;
  onSwitch: (on: boolean) => void;
}) {
  const locked = use.kind === "always-on";
  return (
    <div
      data-decision-use={use.id}
      style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-1)" }}>{use.name}</div>
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            lineHeight: "var(--leading-body)",
          }}
        >
          {use.id === "kind" ? m.settingsDecisionUseKindReads() : use.reads}
        </div>
        {approvalFor && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
            {DECISION_USES_WORDS.needsApproval(approvalFor)}
          </div>
        )}
      </div>
      <Switch
        checked={locked || use.on}
        onChange={onSwitch}
        aria-label={use.name}
        off={locked}
        note={locked ? DECISION_USES_WORDS.locked : undefined}
      />
    </div>
  );
}

/** The answerer line and its dot. The dot's tooltip stays only while the line is cut short. */
function DecisionAnswerer({
  line,
  tone,
  danger,
  last,
  items,
}: {
  line: string;
  tone: StatusDotTone;
  danger: boolean;
  last: { value: string; tokens: number } | null | undefined;
  items: RowMenuItem[];
}) {
  const lineFit = useOverflowTitle(line);
  return (
    <div
      data-decision-row="answerer"
      style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
    >
      {/*
        Same columns as a slot-card model row (64 + flex): the StatusDot
        sits in the label column where a provider name would, and the
        value column carries the answerer line.
      */}
      <span
        data-col="provider"
        style={{
          flexShrink: 0,
          width: 64,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
        }}
      >
        <StatusDot tone={tone} label={line} nativeTitle={lineFit.hidden} />
      </span>
      <span
        data-col="value"
        ref={lineFit.ref}
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          color: danger ? "var(--danger)" : "var(--fg-2)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {line}
      </span>
      {last && (
        <span
          style={{
            flexShrink: 0,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
          }}
        >
          {m.settingsDecisionsLastAnswer({ value: last.value, tokens: String(last.tokens) })}
        </span>
      )}
      <RowMenu label={m.settingsDecisionsActions()} items={items} size={24} />
    </div>
  );
}
