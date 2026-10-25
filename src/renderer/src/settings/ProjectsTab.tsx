import { forgePlace } from "@shared/forge";
import type { RepoPolicyPatch, RepoView } from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import type { DeviceSignIns } from "@shared/signIns";
import {
  AUTONOMY_SWITCH_NAME,
  AUTONOMY_WORDS,
  CARE_WORDS,
  PROJECT_DELIVERY_WORDS,
} from "@shared/vocabulary";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, GroupedPills, Input, Switch } from "../design";
import { useCutWords } from "../design/core/overflowTitle";
import { useInPlaceReveal } from "../design/reveals";
import { AddProject } from "./AddProject";
import { ForgeSection } from "./ForgeSection";
import { PROJECT_POLICY_WORDS, PROJECT_SETUP_WORDS } from "./projectsWords";
import { RemoveProject } from "./RemoveProject";
import { RunsOnControl, runsOnDescription, runsOnWhere, useWorkComputers } from "./RunsOn";
import { LABEL_GAP, ROW_GAP, SettingError, SettingRow } from "./settingRows";
import { useSettingSave } from "./useSettingSave";

/**
 * The Projects settings tab: the managed fleet (decision D-8, fleet-root
 * revision). Setup, settings and removal share the `app_change` catalog with
 * Firstmate. Where new projects
 * go is one folder row; delivery, autonomy, and standing rigor are
 * accordion rows that write the same policy `app_change project-settings` already
 * writes.
 */

const KIND_LABEL: Record<RepoView["setupKind"], string> = PROJECT_SETUP_WORDS;

const DELIVERY_OPTIONS = [
  { value: "direct-pr" as const, label: PROJECT_DELIVERY_WORDS["direct-pr"] },
  { value: "local-only" as const, label: PROJECT_DELIVERY_WORDS["local-only"] },
];

const RIGOR_OPTIONS = [
  { value: "quick" as const, label: CARE_WORDS.quick },
  { value: "standard" as const, label: CARE_WORDS.standard },
  { value: "reviewed" as const, label: CARE_WORDS.reviewed },
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
    delivery: patch.delivery ?? repo.delivery,
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

  useEffect(() => {
    const refresh = () => void window.infinitary.repos.list().then(setRepos);
    refresh();
    const off = window.infinitary.events.on((event) => {
      if (event.type === "repo_setup" || event.type === "repo_unregistered") refresh();
      if (event.type === "repo_configured" && !writing.current.has(event.repoId)) refresh();
      if (event.type === "repo_runs_on") refresh();
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
        Projects
      </div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", marginBottom: ROW_GAP }}>
        Add a project here or ask your first mate. For each project, set where its changes go,
        whether your first mate merges on its own, and how carefully it works.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}>
        <ProjectsFolderRow />
        {repos.length === 0 && (
          <div
            style={{
              padding: "14px 18px",
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-m)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-3)",
            }}
          >
            No projects yet. Add one below, or tell your first mate which project to work on.
          </div>
        )}
        {repos.map((repo) => (
          <ProjectRow
            key={repo.id}
            repo={repo}
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
      </div>
    </div>
  );
}

/**
 * Where new projects go (design skill `components/projects/ProjectsFolder`):
 * the folder Firstmate clones into and starts new projects in, picked with
 * the system's folder picker. Choosing writes nothing until the core
 * accepts the folder; a refusal is shown beside the control and the row
 * reads the saved folder again. Projects already set up never move.
 */
export function ProjectsFolderRow() {
  const folder = useSettingSave(() => window.infinitary.repos.folder());
  const { refresh, save } = folder;
  const [choosing, setChoosing] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const pathCut = useCutWords(folder.value?.path);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = () => {
    setChoosing(true);
    setPickError(null);
    void window.infinitary.app
      .chooseFolder(folder.value?.path)
      .then(
        (picked) => (picked ? save(() => window.infinitary.repos.setFolder(picked)) : false),
        () => setPickError("Could not open the folder picker. Please try again."),
      )
      .finally(() => setChoosing(false));
  };

  const useDefault = () => {
    setPickError(null);
    void save(() => window.infinitary.repos.setFolder(null));
  };

  const busy = choosing || folder.saving;
  return (
    <SettingRow
      id="projects-folder"
      title="Projects folder"
      description="Where your first mate keeps the projects it clones or starts for you. Projects already set up stay where they are."
      detail={
        folder.value && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginTop: "var(--space-2)",
              minWidth: 0,
            }}
          >
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
            {!folder.value.custom && <Badge tone="outline">default</Badge>}
          </div>
        )
      }
      error={pickError ?? folder.error}
      control={
        <span
          style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0 }}
        >
          {folder.value?.custom && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={useDefault}>
              Use default
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={!folder.value || folder.saving}
            pending={choosing}
            pendingLabel="Choosing..."
            onClick={choose}
          >
            Choose folder
          </Button>
        </span>
      }
    />
  );
}

/**
 * Where a project's proposed changes go, in the person's words ("on
 * GitHub", "on git.example.com"), or nothing (git integration PR 1.1). Only
 * a project whose changes are offered where it lives says so: a project
 * kept on this Mac, and one whose changes go straight in, read exactly as
 * they did before - nothing here suggests a project needs a host.
 */
function ProjectDetails({ repo }: { repo: RepoView }) {
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
        title="Name"
        description="Your project keeps its key and history."
        control={
          <Input
            aria-label="Project name"
            mono
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        }
      />
      <PolicyRow
        title="Scope"
        description="What work belongs in this project. Your first mate reads it to choose where new work goes."
        control={
          <textarea
            aria-label="Scope"
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
        title="Folder"
        description="Move the folder first, then enter its new location. Its tasks must be finished or dropped."
        control={
          <Input
            aria-label="Project folder"
            mono
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        }
      />
      <PolicyRow
        title="Where it lives"
        description="Enter the address your folder points at, or leave it empty for this computer."
        control={
          <Input
            aria-label="Where the project lives"
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
          Save details
        </Button>
      </div>
      <SettingError error={error} surface="project-details" />
    </form>
  );
}

function hostWords(repo: RepoView): string | null {
  if (repo.kind === "personal" || repo.delivery !== "direct-pr" || !repo.host) return null;
  const place = forgePlace({ kind: repo.host.kind, host: repo.host.name });
  return place ? `on ${place}` : null;
}

function ProjectRow({
  repo,
  open,
  onToggle,
  onPatch,
  onRemoved,
  computers,
  onRunsOn,
  runsOnError,
}: {
  repo: RepoView;
  open: boolean;
  onToggle: () => void;
  onPatch: (changes: RepoPolicyPatch) => void;
  onRemoved: () => void;
  /** Computers that run work, or null when Runs on is not drawn. */
  computers: DeviceSignIns[] | null;
  onRunsOn: (deviceId: string | null) => void;
  runsOnError: string | null;
}) {
  const personal = repo.kind === "personal";
  const runsWhere = computers ? runsOnWhere(repo, computers) : null;
  const lives = hostWords(repo);
  const autonomyLabel = repo.autonomy ? AUTONOMY_WORDS.putsInItself : AUTONOMY_WORDS.asksFirst;
  const reveal = useInPlaceReveal(open);
  return (
    <div
      data-project={repo.id}
      style={{
        background: "var(--bg-1)",
        border: `1px solid ${open ? "var(--line-2)" : "var(--line-1)"}`,
        borderRadius: "var(--radius-m)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${repo.name}, ${open ? "expanded" : "collapsed"}`}
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
          textAlign: "left",
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
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {repo.path}
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {!open && (
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Badge tone="outline">{KIND_LABEL[repo.setupKind]}</Badge>
              {personal ? (
                <Badge tone="outline">builds in place</Badge>
              ) : (
                <>
                  {lives && <Badge tone="outline">{lives}</Badge>}
                  <Badge tone="outline">{PROJECT_DELIVERY_WORDS[repo.delivery]}</Badge>
                  <Badge tone={repo.autonomy ? "outline" : "accent"}>{autonomyLabel}</Badge>
                  {runsWhere && <Badge tone="accent">{`runs ${runsWhere}`}</Badge>}
                </>
              )}
            </span>
          )}
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
            title={personal ? "Workspace" : "Where changes go"}
            description={
              personal
                ? "Builds in place: no working copy and no pull request."
                : PROJECT_POLICY_WORDS.delivery
            }
            control={
              personal ? (
                <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
                  builds in place
                </span>
              ) : (
                <GroupedPills
                  name="Where changes go"
                  htmlName={`delivery-${repo.id}`}
                  value={repo.delivery}
                  options={DELIVERY_OPTIONS.filter(
                    (option) => repo.origin || option.value === "local-only",
                  )}
                  onChange={(delivery) => onPatch({ delivery })}
                />
              )
            }
          />
          <PolicyRow
            title={AUTONOMY_SWITCH_NAME}
            description={
              personal
                ? "Builds in place. Work that passes the checks is written as soon as it is done."
                : repo.autonomy
                  ? "Work that passes the checks may merge without asking you."
                  : "Finished work waits for your word."
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
            title="Care"
            description={
              personal
                ? "Nothing here passes through a gate."
                : repo.rigor
                  ? "The standing care for every task here."
                  : "Default care for every task here."
            }
            control={
              personal ? (
                <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>none</span>
              ) : (
                <GroupedPills
                  name="Care"
                  htmlName={`rigor-${repo.id}`}
                  value={(repo.rigor ?? "standard") as Rigor}
                  options={RIGOR_OPTIONS}
                  onChange={(value) => onPatch({ rigor: value as Rigor })}
                />
              )
            }
          />
          {computers && (
            <PolicyRow
              title="Runs on"
              description={runsOnDescription(repo)}
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
              Changes that merge locally are done carefully, without a review - there is no pull
              request to look at.
            </div>
          )}
          {!personal && <RemoveProject repo={repo} onRemoved={onRemoved} />}
        </div>
      )}
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
