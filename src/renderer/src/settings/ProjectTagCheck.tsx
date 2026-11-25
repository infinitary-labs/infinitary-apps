import * as m from "@shared/i18n/messages.generated";
import type { TagCheckReach, TagCheckView } from "@shared/tagCheck";
import type { ProjectTagView } from "@shared/tags";
import { useEffect, useState } from "react";
import { Button } from "../design";
import { FIRSTMATE_SELECT_STYLE } from "./GeneralTab";
import { SettingError } from "./settingRows";

/**
 * The foot of a project's Tags box (design skill
 * components/projects/ProjectPage; docs/task-tags.md, "Automatic tagging"
 * and "Checking existing tasks"): whether new tasks are tagged on their own
 * and who answers, then Check existing tasks with its reach, the requests
 * it makes and Start, or its progress and Stop while it runs. `only` names
 * the tag just added or newly described, which the check then asks alone.
 */

/** How often the box reads its counts again: a check's progress, or tasks filed meanwhile. */
const READ_EVERY_MS = 2000;

const REACHES: { reach: TagCheckReach; label: () => string }[] = [
  { reach: "open", label: () => m.settingsProjectsTagsCheckOpen() },
  { reach: "week", label: () => m.settingsProjectsTagsCheckWeek() },
  { reach: "all", label: () => m.settingsProjectsTagsCheckAll() },
];

const QUIET = { fontSize: "var(--text-xs)", color: "var(--fg-3)" } as const;

export function ProjectTagCheck({
  projectId,
  tags,
  only,
  onDone,
}: {
  projectId: string;
  tags: readonly ProjectTagView[];
  only: ProjectTagView | null;
  onDone: () => void;
}) {
  const [view, setView] = useState<TagCheckView | null>(null);
  const [reach, setReach] = useState<TagCheckReach>("open");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onlyId = only?.id ?? null;
  // A tag's new description or a new tag changes what a reach counts.
  const tagsKey = tags.map((tag) => `${tag.id}:${tag.revision}`).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: tagsKey reads the counts again at once when a tag changes
  useEffect(() => {
    let live = true;
    const read = () =>
      window.infinitary.projects
        .tagChecks({ projectId, ...(onlyId ? { tagIds: [onlyId] } : {}) })
        .then((views) => {
          if (live) setView(views[0] ?? null);
        })
        .catch(() => {});
    void read();
    const timer = setInterval(read, READ_EVERY_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId, onlyId, tagsKey]);

  if (!view) return null;
  const send = async (change: Parameters<typeof window.infinitary.projects.tagCheck>[0]) => {
    setBusy(true);
    setError(null);
    try {
      setView(await window.infinitary.projects.tagCheck(change));
      if (change.op === "start") onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const requests = view.reaches[reach];
  const running = view.running;

  return (
    <div
      data-tag-check={projectId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "10px 0",
        borderTop: "1px solid var(--line-1)",
      }}
    >
      <div data-tag-auto={view.auto ? "on" : "off"} style={QUIET}>
        {!view.auto
          ? m.settingsProjectsTagsAutoOff()
          : view.answerer
            ? m.settingsProjectsTagsAutoOn({ answerer: view.answerer })
            : m.settingsProjectsTagsAutoOnOwn()}
      </div>
      {view.auto && (
        <>
          <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
            {only && !running
              ? m.settingsProjectsTagsCheckNamed({ name: only.name })
              : m.settingsProjectsTagsCheck()}
          </div>
          {running ? (
            <div
              data-tag-check-running
              style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}
            >
              <span
                role="status"
                style={{ ...QUIET, fontFamily: "var(--font-mono)", flex: 1, minWidth: 0 }}
              >
                {m.settingsProjectsTagsCheckProgress({
                  done: String(running.done),
                  total: running.total,
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                pending={busy}
                data-tag-check-stop
                onClick={() => void send({ op: "stop", projectId })}
              >
                {m.settingsProjectsTagsCheckStop()}
              </Button>
            </div>
          ) : view.elsewhere ? (
            <div data-tag-check-elsewhere style={QUIET}>
              {m.settingsProjectsTagsCheckElsewhere({ project: view.elsewhere })}
            </div>
          ) : (
            <>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  flexWrap: "wrap",
                }}
              >
                <select
                  value={reach}
                  data-tag-check-reach
                  aria-label={m.settingsProjectsTagsCheckReach()}
                  onChange={(event) => setReach(event.target.value as TagCheckReach)}
                  style={{ ...FIRSTMATE_SELECT_STYLE, fontFamily: "var(--font-ui)" }}
                >
                  {REACHES.map((option) => (
                    <option key={option.reach} value={option.reach}>
                      {option.label()}
                    </option>
                  ))}
                </select>
                <Button
                  variant="secondary"
                  size="sm"
                  pending={busy}
                  disabled={requests === 0}
                  data-tag-check-start
                  onClick={() =>
                    void send({
                      op: "start",
                      projectId,
                      reach,
                      ...(onlyId ? { tagIds: [onlyId] } : {}),
                    })
                  }
                >
                  {m.settingsProjectsTagsCheckStart()}
                </Button>
                {only && (
                  <Button variant="ghost" size="sm" disabled={busy} onClick={onDone}>
                    {m.settingsProjectsTagsCheckNotNow()}
                  </Button>
                )}
              </span>
              <div data-tag-check-cost style={QUIET}>
                {requests === 0
                  ? m.settingsProjectsTagsCheckNone()
                  : view.answerer
                    ? m.settingsProjectsTagsCheckCost({ count: requests, answerer: view.answerer })
                    : m.settingsProjectsTagsCheckCostOwn({ count: requests })}
              </div>
            </>
          )}
          <SettingError error={error} surface="project-tag-check" />
        </>
      )}
    </div>
  );
}
