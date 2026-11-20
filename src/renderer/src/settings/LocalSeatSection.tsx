import * as m from "@shared/i18n/messages.generated";
import {
  DEFAULT_LOCAL_ORCHESTRATOR_SETTING,
  type LocalOrchestratorSetting,
  type LocalOrchestratorView,
  localSeatDescription,
} from "@shared/localOrchestrator";
import { useEffect, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { Input, Switch } from "../design";
import { ROW_GAP, SECTION_GAP, SectionLabel, SettingRow } from "./settingRows";

/** Sample values the fields show: a URL and a model id, never words. */
const LOCAL_ENDPOINT_SAMPLE = "http://localhost:11434/v1";
// i18n-exempt: a model id, not words
const LOCAL_MODEL_SAMPLE = "qwen3:8b";

/**
 * The dev-only local seat (roadmap 1.7; docs/local-orchestrator.md): the
 * Settings side of the same choice the environment variables make - a
 * switch, the endpoint, the model - rendered ONLY while the core says the
 * control is available, which it never is on a packaged build (the view
 * says so and the write is refused, so there is nothing to hide). Dev
 * checkout only: the plain-language vocabulary (roadmap 1.5) does not
 * govern these words, which name the machinery a developer is pointing at.
 */

export function LocalSeatSectionView({
  view,
  draft,
  onToggle,
  onDraft,
  onCommit,
}: {
  view: LocalOrchestratorView | null;
  draft: LocalOrchestratorSetting;
  onToggle: (enabled: boolean) => void;
  onDraft: (draft: LocalOrchestratorSetting) => void;
  /** The fields save on blur or Enter, the switch at once. */
  onCommit: () => void;
}) {
  if (!view?.available) return null;
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") onCommit();
  };
  const fieldStyle = { width: "calc(var(--space-9) * 3)" };
  return (
    <div data-local-seat style={{ marginTop: SECTION_GAP }}>
      <SectionLabel>{m.settingsLocalSeatHeading()}</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
        <SettingRow
          id="local-seat"
          title={m.settingsLocalSeatRun()}
          description={localSeatDescription(view)}
          control={<Switch checked={draft.enabled} onChange={onToggle} />}
        />
        <SettingRow
          id="local-seat-url"
          title={m.settingsLocalSeatEndpoint()}
          description={m.settingsLocalSeatEndpointDescription({ url: LOCAL_ENDPOINT_SAMPLE })}
          control={
            <Input
              mono
              aria-label={m.settingsLocalSeatEndpointLabel()}
              placeholder={LOCAL_ENDPOINT_SAMPLE}
              value={draft.baseUrl}
              onChange={(event) => onDraft({ ...draft, baseUrl: event.target.value })}
              onBlur={onCommit}
              onKeyDown={commitOnEnter}
              style={fieldStyle}
            />
          }
        />
        <SettingRow
          id="local-seat-model"
          title={m.settingsLocalSeatModel()}
          description={m.settingsLocalSeatModelDescription({ model: LOCAL_MODEL_SAMPLE })}
          control={
            <Input
              mono
              aria-label={m.settingsLocalSeatModelLabel()}
              placeholder={LOCAL_MODEL_SAMPLE}
              value={draft.model}
              onChange={(event) => onDraft({ ...draft, model: event.target.value })}
              onBlur={onCommit}
              onKeyDown={commitOnEnter}
              style={fieldStyle}
            />
          }
        />
      </div>
    </div>
  );
}

export function LocalSeatSection() {
  const [view, setView] = useState<LocalOrchestratorView | null>(null);
  const [draft, setDraft] = useState<LocalOrchestratorSetting>(DEFAULT_LOCAL_ORCHESTRATOR_SETTING);
  const loadFirstRun = useShellStore((s) => s.loadFirstRun);
  const saveSequence = useRef(0);

  useEffect(() => {
    void window.infinitary.settings.getLocalOrchestrator().then((next) => {
      setView(next);
      setDraft(next.setting);
    });
  }, []);

  const save = (next: LocalOrchestratorSetting) => {
    const sequence = ++saveSequence.current;
    setDraft(next);
    void window.infinitary.settings
      .setLocalOrchestrator(next)
      .then((result) => {
        if (sequence !== saveSequence.current) return;
        setView(result);
        // A blur/Enter save can finish while the person is typing in the
        // other field. Never replace edits made after this request began.
        setDraft((current) => (current === next ? result.setting : current));
        // The seat is a model that can answer: the stage's gate follows it.
        void loadFirstRun();
      })
      .catch(() => {
        if (sequence !== saveSequence.current) return;
        setView((current) =>
          current ? { ...current, problem: m.settingsLocalSeatSaveFailed() } : current,
        );
      });
  };

  const commit = () => {
    if (!view) return;
    if (draft.baseUrl === view.setting.baseUrl && draft.model === view.setting.model) return;
    save(draft);
  };

  return (
    <LocalSeatSectionView
      view={view}
      draft={draft}
      onToggle={(enabled) => save({ ...draft, enabled })}
      onDraft={setDraft}
      onCommit={commit}
    />
  );
}
