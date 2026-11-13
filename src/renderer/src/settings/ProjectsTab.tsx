import { keepsCommits, SQUASH_ONLY_WORDS } from "@shared/batches";
import { CONTRIBUTION_WORDS } from "@shared/contributions";
import type { ForgeKind } from "@shared/forge";
import * as m from "@shared/i18n/messages.generated";
import {
  deliveryChoices,
  hostRunsQueue,
  ownsBatches,
  queueSettingsWarning,
  queueShipped,
  type RepoPolicyPatch,
  type RepoView,
} from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import type { DeviceSignIns } from "@shared/signIns";
import {
  AUTONOMY_SWITCH_NAME,
  AUTONOMY_WORDS,
  PROJECT_DELIVERY_WORDS,
  RIGOR_WORDS,
} from "@shared/vocabulary";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Disclosure, GroupedPills, Input, Switch } from "../design";
import { useCutWords } from "../design/core/overflowTitle";
import { useInPlaceReveal } from "../design/reveals";
import { useFirstMatePlace, useHereAs } from "../devices/useFirstMatePlace";
import { isView } from "../devices/viewWords";
import { AddProject } from "./AddProject";
import { FOLDER_THERE_WORDS } from "./addProjectWords";
import { BatchHoldPanel } from "./BatchHoldPanel";
import { ForgeSection } from "./ForgeSection";
import { ProjectCostLimit } from "./ProjectCostLimit";
import { PROJECT_COST_WORDS } from "./projectCostWords";
import {
  BATCH_OWN_WORDS,
  PROJECT_POLICY_WORDS,
  PROJECT_ROW_WORDS,
  projectRowWords,
  QUEUE_HOW_TO_WORDS,
  QUEUE_SHIPPED_WORDS,
  queueHowTo,
  queueNoHostWords,
  queueWaitingWords,
} from "./projectsWords";
import { QueueKeyPanel } from "./QueueKeyPanel";
import { QueuePausePanel } from "./QueuePausePanel";
import { RemoveProject } from "./RemoveProject";
import { RunsOnControl, runsOnDescription, runsOnWhere, useWorkComputers } from "./RunsOn";
import { LABEL_GAP, ROW_GAP, SettingError } from "./settingRows";
import { useSettingSave } from "./useSettingSave";

/**
 * The Projects settings tab: the managed fleet (decision D-8, fleet-root
 * revision). Setup, settings and removal share the `app_change` catalog with
 * Firstmate. One list box holds every project, Add project and, on one
 * line under it, where new projects go (INF-1495, direction A). A closed row
 * says only how the project differs from a new one (`projectRowWords`);
 * delivery, autonomy, and standing rigor are accordion rows that write the
 * same policy `app_change project-settings` already writes.
 */

const RIGOR_OPTIONS = [
  { value: "quick" as const, label: RIGOR_WORDS.quick },
  { value: "standard" as const, label: RIGOR_WORDS.standard },
  { value: "reviewed" as const, label: RIGOR_WORDS.reviewed },
];

const chevron = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

function applyPatch(repo: RepoView, patch: RepoPolicyPatch): RepoView {
  return {
    ...repo,
    costLimit: patch.costLimit === undefined ? repo.costLimit : patch.costLimit,
    delivery: patch.delivery ?? repo.delivery,
    ...(patch.contributionDestination && repo.contribution
      ? { contribution: { ...repo.contribution, destination: patch.contributionDestination } }
      : {}),
    autonomy: patch.autonomy ?? repo.autonomy,
    rigor: patch.rigor === undefined ? repo.rigor : patch.rigor,
  };
}

const POLICY_BATCH_MS = 200;

/**
 * Drain queued policy patches. Used on debounce fire and on unmount (tab
 * switch). Configure rejection is swallowed the same way the live flush
 * does - an unhandled reject would surface as a renderer error.
 */
export function drainPendingPolicy(
  pending: Map<string, RepoPolicyPatch>,
  configure: (id: string, changes: RepoPolicyPatch) => Promise<unknown>,
): Promise<void> {
  const writes: Promise<unknown>[] = [];
  for (const [id, changes] of pending) {
    pending.delete(id);
    writes.push(Promise.resolve(configure(id, changes)).catch(() => undefined));
  }
  return Promise.all(writes).then(() => undefined);
}

export function ProjectsTab() {
  const [repos, setRepos] = useState<RepoView[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const pending = useRef(new Map<string, RepoPolicyPatch>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const writing = useRef(new Set<string>());
  // Eligible projects expose Automatic even before another computer is added.
  const computers = useWorkComputers();
  const [runsOnError, setRunsOnError] = useState<string | null>(null);
  const folder = useProjectsFolder();
  const folderPath = folder.value?.path ?? null;

  useEffect(() => {
    const refresh = () => void window.infinitary.repos.list().then(setRepos);
    refresh();
    const off = window.infinitary.events.on((event) => {
      if (event.type === "repo_setup" || event.type === "repo_unregistered") refresh();
      if (event.type === "repo_configured" && !writing.current.has(event.repoId)) refresh();
      if (event.type === "repo_runs_on" || event.type === "repo_queue") refresh();
    });
    return () => {
      off();
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      // Tab switch unmounts this section: flush pending patches so they land.
      void drainPendingPolicy(pending.current, (id, changes) =>
        window.infinitary.repos.configure(id, changes),
      );
    };
  }, []);

  const flush = (id: string) => {
    timers.current.delete(id);
    const changes = pending.current.get(id);
    if (!changes) return;
    const slice = new Map<string, RepoPolicyPatch>([[id, changes]]);
    pending.current.delete(id);
    writing.current.add(id);
    void drainPendingPolicy(slice, (repoId, patch) =>
      window.infinitary.repos.configure(repoId, patch).then(
        (updated) => {
          setRepos((current) => current.map((repo) => (repo.id === updated.id ? updated : repo)));
          return updated;
        },
        () => {
          void window.infinitary.repos.list().then(setRepos);
        },
      ),
    ).finally(() => {
      writing.current.delete(id);
    });
  };

  const patch = (id: string, changes: RepoPolicyPatch) => {
    setRepos((current) =>
      current.map((repo) => (repo.id === id ? applyPatch(repo, changes) : repo)),
    );
    pending.current.set(id, { ...pending.current.get(id), ...changes });
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.set(
      id,
      setTimeout(() => {
        flush(id);
      }, POLICY_BATCH_MS),
    );
  };

  const chooseRunsOn = (id: string, deviceId: string | null) => {
    setRunsOnError(null);
    setRepos((current) =>
      current.map((repo) => (repo.id === id ? { ...repo, runsOn: deviceId } : repo)),
    );
    void window.infinitary.devices.runsOn(id, deviceId).then(
      (updated) =>
        setRepos((current) => current.map((repo) => (repo.id === updated.id ? updated : repo))),
      (caught: unknown) => {
        setRunsOnError(caught instanceof Error ? caught.message : String(caught));
        void window.infinitary.repos.list().then(setRepos);
      },
    );
  };

  return (
    <div>
      <ForgeSection />
      <div
        style={{
          fontSize: "var(--text-xs)",
          fontWeight: 500,
          letterSpacing: "var(--tracking-label)",
          textTransform: "uppercase",
          color: "var(--fg-3)",
          marginBottom: LABEL_GAP,
        }}
      >
        {m.settingsProjectsLabel()}
      </div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", marginBottom: ROW_GAP }}>
        {m.settingsProjectsIntro()}
      </div>
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-m)",
          overflow: "hidden",
        }}
      >
        {repos.length === 0 && (
          <div
            style={{
              padding: "12px 18px",
              borderBottom: "1px solid var(--line-1)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-3)",
            }}
          >
            {m.settingsProjectsEmpty()}
          </div>
        )}
        {repos.map((repo) => (
          <ProjectRow
            key={repo.id}
            repo={repo}
            folder={folderPath}
            open={openId === repo.id}
            onToggle={() => setOpenId((current) => (current === repo.id ? null : repo.id))}
            onPatch={(changes) => patch(repo.id, changes)}
            computers={
              computers?.length || (repo.kind === "project" && repo.origin)
                ? (computers ?? [])
                : null
            }
            onRunsOn={(deviceId) => chooseRunsOn(repo.id, deviceId)}
            runsOnError={openId === repo.id ? runsOnError : null}
            onRemoved={() => {
              setOpenId((current) => (current === repo.id ? null : current));
              setRepos((current) => current.filter((entry) => entry.id !== repo.id));
            }}
          />
        ))}
        <AddProject
          repos={repos}
          onAdded={(repo) => {
            setRepos((current) =>
              current.some((entry) => entry.id === repo.id) ? current : [...current, repo],
            );
            setOpenId(repo.id);
          }}
        />
        <ProjectsFolderLine folder={folder} />
      </div>
    </div>
  );
}

/**
 * Where new projects go (design skill `components/projects/ProjectsFolder`):
 * one line under Add project naming the folder Firstmate clones into and
 * starts new projects in, picked with the system's folder picker. Choosing
 * writes nothing until the core accepts the folder; a refusal is shown under
 * the line and the line reads the saved folder again. Projects already set
 * up never move.
 */
function ProjectsFolderLine({ folder }: { folder: ReturnType<typeof useProjectsFolder> }) {
  const { refresh, save } = folder;
  const [choosing, setChoosing] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const pathCut = useCutWords(folder.value?.path);
  // A view takes the folder's path on the first mate's computer, since a
  // folder picker here shows only this computer's folders (docs/run.md).
  const there = useShellStore((s) => (isView(s.thisMac) ? s.thisMac.name : null));
  const [typed, setTyped] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveTyped = () => {
    const path = typed?.trim();
    if (!path) return;
    void save(() => window.infinitary.repos.setFolder(path)).then((saved) => {
      if (saved) setTyped(null);
    });
  };

  const choose = () => {
    if (there) {
      setTyped(folder.value?.path ?? "");
      return;
    }
    setChoosing(true);
    setPickError(null);
    void window.infinitary.app
      .chooseFolder(folder.value?.path)
      .then(
        (picked) => (picked ? save(() => window.infinitary.repos.setFolder(picked)) : false),
        () => setPickError(m.settingsProjectsFolderPickerFailed()),
      )
      .finally(() => setChoosing(false));
  };

  const useDefault = () => {
    setPickError(null);
    void save(() => window.infinitary.repos.setFolder(null));
  };

  const busy = choosing || folder.saving;
  return (
    <div
      data-setting="projects-folder"
      style={{ padding: "0 var(--space-4) var(--space-4)", fontSize: "var(--text-sm)" }}
    >
      {there && typed !== null ? (
        <form
          style={{ display: "flex", gap: "var(--space-2)" }}
          onSubmit={(event) => {
            event.preventDefault();
            saveTyped();
          }}
        >
          <Input
            aria-label={FOLDER_THERE_WORDS.label(there)}
            mono
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={folder.saving}
            autoFocus
          />
          <Button type="submit" size="sm" disabled={!typed.trim() || folder.saving}>
            {m.settingsProjectsFolderSave()}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setTyped(null)}>
            {m.settingsProjectsFolderCancel()}
          </Button>
        </form>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
          <span style={{ color: "var(--fg-3)", whiteSpace: "nowrap" }}>
            {m.settingsProjectsFolderLine()}
          </span>
          {folder.value && (
            <>
              <span
                data-projects-folder-path
                {...pathCut}
                style={{
                  minWidth: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {folder.value.path}
              </span>
              {!folder.value.custom && (
                <span
                  style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}
                >
                  {m.settingsProjectsFolderDefault()}
                </span>
              )}
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={!folder.value || folder.saving}
            pending={choosing}
            pendingLabel={m.settingsProjectsFolderChoosing()}
            onClick={choose}
          >
            {m.settingsProjectsFolderChoose()}
          </Button>
          {folder.value?.custom && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={useDefault}>
              {m.settingsProjectsFolderUseDefault()}
            </Button>
          )}
        </div>
      )}
      <SettingError error={pickError ?? folder.error} />
    </div>
  );
}

/** The projects folder as Settings last read it, shared by the rows and the folder line. */
function useProjectsFolder() {
  return useSettingSave(() => window.infinitary.repos.folder());
}

function ProjectDetails({ repo }: { repo: RepoView }) {
  const place = useFirstMatePlace();
  const [name, setName] = useState(repo.name);
  const [scope, setScope] = useState(repo.scope ?? "");
  const [path, setPath] = useState(repo.path);
  const [origin, setOrigin] = useState(repo.origin ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setName(repo.name);
    setScope(repo.scope ?? "");
    setPath(repo.path);
    setOrigin(repo.origin ?? "");
  }, [repo.name, repo.scope, repo.path, repo.origin]);
  const changed =
    name !== repo.name ||
    (scope || null) !== (repo.scope ?? null) ||
    path !== repo.path ||
    (origin || null) !== repo.origin;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.infinitary.repos.configure(repo.id, {
        ...(name !== repo.name ? { name } : {}),
        ...((scope || null) !== (repo.scope ?? null) ? { scope: scope || null } : {}),
        ...(path !== repo.path ? { path } : {}),
        ...((origin || null) !== repo.origin
          ? { origin: origin || null, ...(!origin ? { delivery: "local-only" as const } : {}) }
          : {}),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !saving) void save();
      }}
    >
      <PolicyRow
        title={m.settingsProjectsName()}
        description={m.settingsProjectsNameDescription()}
        control={
          <Input
            aria-label={m.settingsProjectsNameLabel()}
            mono
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        }
      />
      <PolicyRow
        title={m.settingsProjectsScope()}
        description={m.settingsProjectsScopeDescription()}
        control={
          <textarea
            aria-label={m.settingsProjectsScope()}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            rows={4}
            style={{
              width: "100%",
              fontFamily: "var(--font-ui)",
              fontSize: "var(--text-base)",
              color: "var(--fg-1)",
              background: "var(--surface-input)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-m)",
              padding: "9px 14px",
              resize: "vertical",
            }}
          />
        }
      />
      <PolicyRow
        title={m.settingsProjectsFolder()}
        description={m.settingsProjectsFolderDescription()}
        control={
          <Input
            aria-label={m.settingsProjectsFolderLabel()}
            mono
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        }
      />
      <PolicyRow
        title={m.settingsProjectsOrigin()}
        description={m.settingsProjectsOriginDescription({ place: place.this })}
        control={
          <Input
            aria-label={m.settingsProjectsOriginLabel()}
            mono
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
        }
      />
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: ROW_GAP }}>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={!changed || saving}
          pending={saving}
        >
          {m.settingsProjectsSaveDetails()}
        </Button>
      </div>
      <SettingError error={error} surface="project-details" />
    </form>
  );
}

function ProjectRow({
  repo,
  folder,
  open,
  onToggle,
  onPatch,
  onRemoved,
  computers,
  onRunsOn,
  runsOnError,
}: {
  repo: RepoView;
  /** The projects folder, or null while it is unread. */
  folder: string | null;
  open: boolean;
  onToggle: () => void;
  onPatch: (changes: RepoPolicyPatch) => void;
  onRemoved: () => void;
  /** Computers that run work, or null when Runs on is not drawn. */
  computers: DeviceSignIns[] | null;
  onRunsOn: (deviceId: string | null) => void;
  runsOnError: string | null;
}) {
  const here = useHereAs();
  const personal = repo.kind === "personal";
  const shipped = personal ? undefined : queueShipped(repo);
  // Batches of this person's own: the app combines the approved changes, with no queue to set up.
  const ownBatch = !personal && ownsBatches(repo.delivery, repo) === true;
  const held = !personal && repo.batch?.open?.hold ? repo.batch.open : undefined;
  // A project that allows only squash merges and carries no team queue is not offered batches.
  const squashOnly =
    !personal &&
    repo.delivery !== "queue-pr" &&
    repo.queueWorkflows?.length === 0 &&
    repo.batch?.ways !== undefined &&
    !keepsCommits(repo.batch.ways);
  const runsWhere = computers ? runsOnWhere(repo, computers) : null;
  const words = projectRowWords(repo, folder, runsWhere);
  const showPath = !personal && folder !== null && words.includes(PROJECT_ROW_WORDS.linked);
  const autonomyLabel = repo.autonomy ? AUTONOMY_WORDS.putsInItself : AUTONOMY_WORDS.asksFirst;
  const reveal = useInPlaceReveal(open);
  return (
    <div
      data-project={repo.id}
      style={{
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={
          open
            ? m.settingsProjectsRowExpanded({ name: repo.name })
            : m.settingsProjectsRowCollapsed({ name: repo.name })
        }
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          width: "100%",
          padding: "12px 18px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "start",
          color: "inherit",
          font: "inherit",
        }}
      >
        <span style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-1)",
              whiteSpace: "nowrap",
            }}
          >
            {repo.name}
          </span>
          {words.length > 0 && (
            <span
              data-project-words
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
                whiteSpace: "nowrap",
              }}
            >
              {words.map((word, index) => (
                <span key={word}>
                  {index > 0 && " · "}
                  <span data-project-word>{word}</span>
                </span>
              ))}
            </span>
          )}
          {showPath && (
            <span
              data-project-path
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-3)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {repo.path}
            </span>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span
            style={{
              display: "inline-flex",
              color: "var(--fg-3)",
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform var(--dur-fast) var(--ease-out)",
            }}
          >
            {chevron}
          </span>
        </span>
      </button>
      {open && (
        <div data-in-place-reveal={reveal ? "drift" : undefined} style={{ padding: "0 18px 12px" }}>
          {!personal && <ProjectDetails repo={repo} />}
          <PolicyRow
            // The personal workspace is a workspace kind, not a posture, so
            // its first row is not a Delivery at all - naming it one is the
            // conflation this tab stopped making.
            title={personal ? m.settingsProjectsWorkspace() : m.settingsProjectsDeliveryTitle()}
            description={
              personal ? m.settingsProjectsWorkspaceDescription() : PROJECT_POLICY_WORDS.delivery
            }
            control={
              personal ? (
                <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
                  {PROJECT_ROW_WORDS.personal}
                </span>
              ) : (
                <GroupedPills
                  name={m.settingsProjectsDeliveryTitle()}
                  htmlName={`delivery-${repo.id}`}
                  value={repo.delivery}
                  // A project that runs the shipped queue decides for everyone on it.
                  disabled={shipped !== undefined}
                  options={deliveryChoices(repo.origin ? repo.host : null).map((value) => ({
                    value,
                    label: PROJECT_DELIVERY_WORDS[value],
                  }))}
                  onChange={(delivery) => onPatch({ delivery })}
                />
              )
            }
          />
          {!personal && repo.contribution?.fork && (
            <PolicyRow
              title={CONTRIBUTION_WORDS.target}
              description={CONTRIBUTION_WORDS.description}
              control={
                <GroupedPills
                  name={CONTRIBUTION_WORDS.target}
                  htmlName={`contribution-${repo.id}`}
                  value={repo.contribution.destination ?? ""}
                  options={[
                    { value: "upstream", label: CONTRIBUTION_WORDS.upstream },
                    { value: "fork", label: CONTRIBUTION_WORDS.fork },
                  ]}
                  onChange={(contributionDestination) => {
                    if (contributionDestination) onPatch({ contributionDestination });
                  }}
                />
              }
            />
          )}
          {!personal && repo.queuePendingAt !== undefined && (
            <div
              role="status"
              data-queue-waiting={repo.id}
              style={{
                width: "fit-content",
                fontSize: "var(--text-xs)",
                color: "var(--fg-2)",
                paddingBottom: "var(--space-3)",
              }}
            >
              {queueWaitingWords(repo.delivery)}
            </div>
          )}
          {!personal && shipped !== undefined && (
            <QueueNote words={QUEUE_SHIPPED_WORDS.set(shipped)} data="shipped" id={repo.id} />
          )}
          {!personal && repo.origin && repo.host && !hostRunsQueue(repo.host) && (
            <QueueNote words={queueNoHostWords()} data="no-host" id={repo.id} />
          )}
          {squashOnly && <QueueNote words={SQUASH_ONLY_WORDS} data="squash-only" id={repo.id} />}
          {ownBatch && <QueueNote words={BATCH_OWN_WORDS.note} data="own-batch" id={repo.id} />}
          {held?.hold && <BatchHoldPanel repo={repo} batch={{ ...held, hold: held.hold }} />}
          {!personal && repo.queuePause && <QueuePausePanel repo={repo} pause={repo.queuePause} />}
          {!personal &&
            !ownBatch &&
            repo.origin &&
            (repo.delivery === "queue-pr" ||
              repo.queuePendingAt !== undefined ||
              shipped !== undefined) && <QueueKeyPanel key={repo.id} repo={repo} />}
          {!personal && <QueueWarning repo={repo} />}
          {!personal && !ownBatch && repo.delivery === "queue-pr" && shipped === undefined && (
            <QueueHowTo kind={repo.host?.kind} />
          )}
          <PolicyRow
            title={AUTONOMY_SWITCH_NAME}
            description={
              personal
                ? m.settingsProjectsAutonomyPersonal()
                : repo.autonomy
                  ? m.settingsProjectsAutonomyOn()
                  : m.settingsProjectsAutonomyOff()
            }
            control={
              personal ? (
                <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
                  {autonomyLabel}
                </span>
              ) : (
                <Switch
                  checked={!repo.autonomy}
                  label={autonomyLabel}
                  labelPosition="before"
                  aria-label={AUTONOMY_SWITCH_NAME}
                  onChange={(asksFirst) => onPatch({ autonomy: !asksFirst })}
                />
              )
            }
          />
          <PolicyRow
            title={m.settingsProjectsCare()}
            description={
              personal ? m.settingsProjectsCarePersonal() : m.settingsProjectsRigorDescription()
            }
            control={
              personal ? (
                <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
                  {m.settingsProjectsCareNone()}
                </span>
              ) : (
                <GroupedPills
                  name={m.settingsProjectsCare()}
                  htmlName={`rigor-${repo.id}`}
                  value={(repo.rigor ?? "standard") as Rigor}
                  options={RIGOR_OPTIONS}
                  onChange={(value) => onPatch({ rigor: value as Rigor })}
                />
              )
            }
          />
          {!personal && repo.costLimit !== undefined && (
            <PolicyRow
              title={PROJECT_COST_WORDS.title}
              description={PROJECT_COST_WORDS.description}
              control={
                <ProjectCostLimit
                  id={repo.id}
                  limit={repo.costLimit}
                  onChange={(costLimit) => onPatch({ costLimit })}
                />
              }
            />
          )}
          {computers && (
            <PolicyRow
              title={m.settingsRunsOnLabel()}
              description={here(runsOnDescription(repo))}
              control={<RunsOnControl repo={repo} computers={computers} onChoose={onRunsOn} />}
            />
          )}
          <SettingError error={runsOnError} surface="runs-on" />
          {!personal && repo.delivery === "local-only" && repo.rigor === "reviewed" && (
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--warn)",
                paddingTop: 6,
                borderTop: "1px solid var(--line-1)",
              }}
            >
              {m.settingsProjectsLocalCareful()}
            </div>
          )}
          {!personal && <RemoveProject repo={repo} onRemoved={onRemoved} />}
        </div>
      )}
    </div>
  );
}

/** One quiet line under "Where changes go" about the project's queue: set by the project, or not offered on its host. */
function QueueNote({ words, data, id }: { words: string; data: string; id: string }) {
  return (
    <div
      data-queue-note={data}
      data-repo={id}
      style={{
        width: "fit-content",
        fontSize: "var(--text-xs)",
        color: "var(--fg-2)",
        paddingBottom: "var(--space-3)",
      }}
    >
      {words}
    </div>
  );
}

/**
 * The warning under "Where changes go" when the batched delivery is chosen
 * and the app's read of the project's workflows finds none that mentions its
 * batch check (docs/forge.md, "A project's queue"). It names what was read;
 * it clears once a workflow mentions the check or the check answers.
 */
function QueueWarning({ repo }: { repo: RepoView }) {
  const words = queueSettingsWarning(repo);
  if (!words) return null;
  return (
    <div
      role="status"
      data-queue-warning={repo.id}
      style={{
        width: "fit-content",
        fontSize: "var(--text-xs)",
        color: "var(--warn)",
        paddingBottom: "var(--space-2)",
      }}
    >
      {words}
    </div>
  );
}

/**
 * What the batched choice needs, under "Where changes go" while the project
 * has it: one sentence in the open, and the how-to behind a disclosure with
 * a link to the host's own guide for the status the queue writes.
 */
function QueueHowTo({ kind }: { kind: ForgeKind | undefined }) {
  const [open, setOpen] = useState(false);
  const howTo = queueHowTo(kind);
  return (
    <div
      data-queue-how-to
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
        paddingBottom: "var(--space-3)",
        fontSize: "var(--text-xs)",
        color: "var(--fg-2)",
      }}
    >
      <div>{QUEUE_HOW_TO_WORDS.needs}</div>
      <Disclosure
        label={QUEUE_HOW_TO_WORDS.label}
        open={open}
        onToggle={setOpen}
        style={{ margin: "0 -6px" }}
      >
        {open ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "var(--space-2)",
              padding: "var(--space-1) 6px 0",
            }}
          >
            <ol
              style={{
                margin: 0,
                paddingInlineStart: "var(--space-4)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
              }}
            >
              {howTo.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div>{QUEUE_HOW_TO_WORDS.firstMate}</div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void window.infinitary.app.openExternal(howTo.guideLink).catch(() => {})
              }
            >
              {howTo.guide}
            </Button>
          </div>
        ) : null}
      </Disclosure>
    </div>
  );
}

function PolicyRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 0",
        borderTop: "1px solid var(--line-1)",
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, color: "var(--fg-1)" }}>
          {title}
        </div>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>{description}</div>
      </div>
      {control}
    </div>
  );
}
