import { forgeOf } from "@shared/forge";
import type { ForgeProject, ForgesView } from "@shared/forges";
import * as m from "@shared/i18n/messages.generated";
import type { RepoSetupSpec, RepoView } from "@shared/repos";
import { useEffect, useId, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Input } from "../design";
import { useFirstMatePlace } from "../devices/useFirstMatePlace";
import { isView } from "../devices/viewWords";
import {
  ADD_PROJECT_WORDS,
  FOLDER_THERE_WORDS,
  newProjectWords,
  notAllListedWords,
  projectSignInWords,
  TASK_KEY_WORDS,
  taskKeyTyped,
} from "./addProjectWords";
import type { GroupProject } from "./projectGroups";

/** The add row's mode that takes a folder's path on the first mate's computer. */
const FOLDER_MODE = "folder";

/**
 * Design skill components/projects/AddProject: the foot of the projects list
 * box, above the folder line. Setup continues if Settings closes. With
 * `into` it is a project's Add a repository row (design skill
 * components/projects/ProjectRepositories, INF-4220): the same pills, no
 * task key, and what it adds joins that project.
 */
export function AddProject({
  repos,
  onAdded,
  into,
  notice,
}: {
  repos: RepoView[];
  /**
   * What was added, with the confirmation this row shows for it, and whether
   * it was added from a project's Add a repository row.
   */
  onAdded: (repo: RepoView, said: string, intoProject: boolean) => void;
  /** The existing project the added repository joins. */
  into?: GroupProject;
  /**
   * A confirmation this row starts with: a project of one's own row, where
   * the add began, gives way to the project's group once it holds two.
   */
  notice?: string | null;
}) {
  // Several of these rows can be on the page at once, so each names its own fields.
  const ids = useId();
  const thisMac = useShellStore((s) => s.thisMac);
  // A view adds a folder on the first mate's computer by its path there.
  const there = isView(thisMac) ? thisMac.name : null;
  const place = useFirstMatePlace();
  const [forges, setForges] = useState<ForgesView | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [name, setName] = useState("");
  const [link, setLink] = useState("");
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<ForgeProject[]>([]);
  // False when the host's listing stopped at its page budget: some projects were not read.
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(notice ?? null);
  const [folder, setFolder] = useState("");
  // The task key the next added project takes; empty, it comes from the name.
  const [taskKey, setTaskKey] = useState("");
  useEffect(() => {
    const refresh = () =>
      void window.infinitary.forges
        .list()
        .then(setForges)
        .catch(() => undefined);
    refresh();
    const refreshFolder = () =>
      void window.infinitary.repos.folder().then((value) => setFolder(value.path));
    refreshFolder();
    const offForges = window.infinitary.forges.onChange(setForges);
    const offEvents = window.infinitary.events.on((event) => {
      if (event.type === "personalized") refreshFolder();
    });
    return () => {
      offForges();
      offEvents();
    };
  }, []);
  const host = forges?.hosts.find((entry) => entry.host === mode);
  const signedIn = !!forges?.signIns.some((entry) => entry.host === mode);
  useEffect(() => {
    let live = true;
    setProjects([]);
    setComplete(true);
    if (!host || !signedIn) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.infinitary.forges
      .projects(host.host)
      .then(
        (listing) => {
          if (!live) return;
          setProjects(listing.projects);
          setComplete(listing.complete);
        },
        (caught) => {
          if (live) setError(caught instanceof Error ? caught.message : String(caught));
        },
      )
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [host, signedIn]);
  const chooseMode = (next: string | null) => {
    setMode(next);
    setError(null);
    setStatus(null);
    setSearch("");
    setLink("");
    setName("");
    setFolderPath("");
  };
  const add = async (spec: RepoSetupSpec, key: string) => {
    setBusy(key);
    setError(null);
    setStatus(null);
    try {
      const result = await window.infinitary.repos.setup(
        into ? { ...spec, project: into.key } : taskKey ? { ...spec, key: taskKey } : spec,
      );
      const said =
        into && result.created
          ? m.settingsAddRepositoryAdded({ name: result.repo.name, project: into.name })
          : result.initializedGit
            ? m.settingsAddProjectAddedGit({ name: result.repo.name })
            : result.created
              ? m.settingsAddProjectAdded({ name: result.repo.name })
              : m.settingsAddProjectAlreadyAdded({ name: result.repo.name });
      onAdded(result.repo, said, !!into);
      if (result.created) setTaskKey("");
      setStatus(said);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };
  const chooseFolder = async () => {
    setError(null);
    setStatus(null);
    setBusy("folder");
    try {
      const path = await window.infinitary.app.chooseFolder();
      if (path) await add({ kind: "adopt", path }, "folder");
    } catch {
      setError(m.settingsProjectsFolderPickerFailed());
    } finally {
      setBusy(null);
    }
  };
  const addLink = () => {
    if (!host) return;
    if (forgeOf(link.trim()).host !== host.host) {
      setError(m.settingsAddProjectWrongHost({ host: host.name }));
      return;
    }
    void add({ kind: "clone", origin: link.trim() }, "link");
  };
  return (
    <section
      aria-label={
        into ? m.settingsAddRepositoryLabel({ project: into.name }) : m.settingsAddProjectLabel()
      }
      {...(into ? { "data-add-repository": into.key } : { "data-add-project": "" })}
      style={{
        padding: "var(--space-4) var(--space-4) var(--space-3)",
        fontSize: "var(--text-sm)",
        overflowWrap: "anywhere",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-2)" }}
      >
        <span
          style={{
            color: "var(--fg-3)",
            fontSize: "var(--text-xs)",
            letterSpacing: "var(--tracking-label)",
            textTransform: "uppercase",
          }}
        >
          {into ? m.settingsAddRepositoryTitle() : m.settingsAddProjectLabel()}
        </span>
        <Button
          variant="secondary"
          size="sm"
          style={{ borderRadius: "var(--radius-pill)" }}
          disabled={!!busy}
          {...(there ? { "aria-expanded": mode === FOLDER_MODE } : {})}
          onClick={() =>
            there ? chooseMode(mode === FOLDER_MODE ? null : FOLDER_MODE) : void chooseFolder()
          }
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M5 12h14M12 5v14" />
          </svg>
          {there ? FOLDER_THERE_WORDS.button(there) : ADD_PROJECT_WORDS.folderHere}
        </Button>
        {forges?.hosts.map((entry) => (
          <Button
            key={entry.host}
            variant="secondary"
            size="sm"
            style={{ borderRadius: "var(--radius-pill)" }}
            disabled={!!busy}
            aria-expanded={mode === entry.host}
            onClick={() => chooseMode(mode === entry.host ? null : entry.host)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M5 12h14M12 5v14" />
            </svg>
            {m.settingsAddProjectHostRepo({ host: entry.name })}
          </Button>
        ))}
        <Button
          variant="secondary"
          size="sm"
          style={{ borderRadius: "var(--radius-pill)" }}
          disabled={!!busy}
          aria-expanded={mode === "new"}
          onClick={() => chooseMode(mode === "new" ? null : "new")}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M5 12h14M12 5v14" />
          </svg>
          {into ? m.settingsAddRepositoryNew() : m.settingsAddProjectNew()}
        </Button>
        {!into && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginInlineStart: "auto",
              color: "var(--fg-2)",
            }}
          >
            <label htmlFor={`${ids}-key`}>{TASK_KEY_WORDS.label}</label>
            <Input
              id={`${ids}-key`}
              mono
              value={taskKey}
              placeholder={TASK_KEY_WORDS.placeholder}
              onChange={(event) => {
                setTaskKey(taskKeyTyped(event.target.value));
                setError(null);
                setStatus(null);
              }}
              disabled={!!busy}
              // A small Button's height, and wide enough for the placeholder's 13
              // mono characters with their padding and border.
              style={{
                width: "calc(13ch + 2 * var(--space-3) + var(--space-1))",
                padding: "calc(var(--space-1) * 1.5) var(--space-3)",
                fontSize: "var(--text-sm)",
              }}
            />
          </div>
        )}
      </div>
      {into && (
        <p style={{ color: "var(--fg-3)", margin: "var(--space-2) 0 0" }}>
          {m.settingsAddRepositoryNext({ key: into.key, project: into.name })}
        </p>
      )}
      {!into && taskKey && (
        <p style={{ color: "var(--fg-3)", margin: "var(--space-2) 0 0" }}>
          {TASK_KEY_WORDS.next(taskKey)}
        </p>
      )}
      {mode && (
        <div
          style={{
            borderTop: "1px solid var(--line-1)",
            marginTop: "var(--space-3)",
            paddingTop: "var(--space-3)",
          }}
        >
          {mode === FOLDER_MODE && there ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void add({ kind: "adopt", path: folderPath.trim() }, "folder");
              }}
            >
              <label htmlFor={`${ids}-folder`}>{FOLDER_THERE_WORDS.label(there)}</label>
              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                <Input
                  id={`${ids}-folder`}
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.target.value)}
                  disabled={!!busy}
                  required
                  mono
                />
                <Button type="submit" size="sm" disabled={!!busy || !folderPath.trim()}>
                  {busy === "folder" ? m.settingsAddProjectAdding() : FOLDER_THERE_WORDS.add}
                </Button>
              </div>
            </form>
          ) : mode === "new" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void add({ kind: "init", name: name.trim() }, "new");
              }}
            >
              <label htmlFor={`${ids}-name`}>{m.settingsAddProjectName()}</label>
              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                <Input
                  id={`${ids}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={!!busy}
                  required
                  mono
                />
                <Button type="submit" size="sm" disabled={!!busy || !name.trim()}>
                  {busy === "new" ? m.settingsAddProjectAdding() : m.settingsAddProjectStart()}
                </Button>
              </div>
              <p style={{ color: "var(--fg-3)" }}>{newProjectWords(folder, place)}</p>
            </form>
          ) : (
            host && (
              <>
                {!signedIn && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      useShellStore.setState({
                        settingsSection: "integrations",
                        pendingForgeSignIn: host.host,
                      })
                    }
                  >
                    {projectSignInWords(host.name)}
                  </Button>
                )}
                {signedIn && (
                  <div>
                    <p>{m.settingsAddProjectYourRepos({ host: host.name })}</p>
                    <Input
                      aria-label={m.settingsAddProjectFind()}
                      placeholder={m.settingsAddProjectFind()}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    {loading && <p role="status">{m.settingsAddProjectReading()}</p>}
                    {projects
                      .filter((project) =>
                        project.fullName.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((project) => {
                        const added = repos.some(
                          (repo) =>
                            repo.kind !== "personal" &&
                            forgeOf(repo.origin).host === host.host &&
                            `${forgeOf(repo.origin).owner}/${forgeOf(repo.origin).name}`.toLowerCase() ===
                              project.fullName.toLowerCase(),
                        );
                        return (
                          <div
                            key={project.fullName}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              gap: "var(--space-2)",
                              padding: "var(--space-2) 0",
                              borderBottom: "1px solid var(--line-1)",
                            }}
                          >
                            <span
                              style={{ fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}
                            >
                              {project.fullName}
                              {project.private && (
                                <span
                                  style={{ color: "var(--fg-3)", fontFamily: "var(--font-ui)" }}
                                >
                                  {" "}
                                  {m.settingsAddProjectPrivate()}
                                </span>
                              )}
                            </span>
                            {added ? (
                              <span style={{ color: "var(--fg-3)" }}>
                                {m.settingsAddProjectAddedMark()}
                              </span>
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                disabled={!!busy}
                                onClick={() =>
                                  void add(
                                    { kind: "clone", origin: project.cloneUrl },
                                    project.fullName,
                                  )
                                }
                              >
                                {busy === project.fullName
                                  ? m.settingsAddProjectAdding()
                                  : m.settingsAddProjectAdd()}
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    {!loading && !complete && (
                      <p data-add-project-not-all-listed="" style={{ color: "var(--fg-3)" }}>
                        {notAllListedWords(host.name)}
                      </p>
                    )}
                  </div>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    addLink();
                  }}
                  style={{ marginTop: "var(--space-3)" }}
                >
                  <label htmlFor={`${ids}-link`}>
                    {signedIn
                      ? ADD_PROJECT_WORDS.orPasteLink(host.name)
                      : m.settingsAddProjectPasteLink({ host: host.name })}
                  </label>
                  <div
                    style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}
                  >
                    <Input
                      id={`${ids}-link`}
                      mono
                      placeholder={`https://${host.host}/owner/project`}
                      value={link}
                      onChange={(event) => setLink(event.target.value)}
                      disabled={!!busy}
                      required
                    />
                    <Button type="submit" size="sm" disabled={!!busy || !link.trim()}>
                      {busy === "link" ? m.settingsAddProjectAdding() : m.settingsAddProjectAdd()}
                    </Button>
                  </div>
                  <p style={{ color: "var(--fg-3)" }}>{m.settingsAddProjectGoesInto({ folder })}</p>
                </form>
              </>
            )
          )}
          <Button variant="ghost" size="sm" onClick={() => chooseMode(null)}>
            {m.settingsAddProjectClose()}
          </Button>
        </div>
      )}
      <div
        role="status"
        aria-live="polite"
        style={{
          color: error ? "var(--danger)" : "var(--fg-3)",
          marginTop: error || status || busy === "folder" ? "var(--space-2)" : 0,
        }}
      >
        {error ?? status ?? (busy === "folder" ? m.settingsAddProjectAdding() : null)}
      </div>
    </section>
  );
}
