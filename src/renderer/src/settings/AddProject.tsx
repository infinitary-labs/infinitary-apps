import { forgeOf } from "@shared/forge";
import type { ForgeProject, ForgesView } from "@shared/forges";
import type { RepoSetupSpec, RepoView } from "@shared/repos";
import { useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Input } from "../design";
import { useFirstMatePlace } from "../devices/useFirstMatePlace";
import { isView } from "../devices/viewWords";
import {
  FOLDER_HERE_WORDS,
  FOLDER_THERE_WORDS,
  newProjectWords,
  OTHER_HOST_WORDS,
  projectSignInWords,
  STARTED_GIT_WORDS,
  TASK_KEY_WORDS,
  taskKeyTyped,
} from "./addProjectWords";

/** The add row's mode that takes a folder's path on the first mate's computer. */
const FOLDER_MODE = "folder";

/**
 * Design skill components/projects/AddProject: the foot of the projects list
 * box, above the folder line. Setup continues if Settings closes.
 */
export function AddProject({
  repos,
  onAdded,
}: {
  repos: RepoView[];
  onAdded: (repo: RepoView) => void;
}) {
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
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
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
    if (!host || !signedIn) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.infinitary.forges
      .projects(host.host)
      .then(
        (rows) => {
          if (live) setProjects(rows);
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
        taskKey ? { ...spec, key: taskKey } : spec,
      );
      onAdded(result.repo);
      if (result.created) setTaskKey("");
      setStatus(
        result.initializedGit
          ? `Added ${result.repo.name}. ${STARTED_GIT_WORDS}`
          : result.created
            ? `Added ${result.repo.name}.`
            : `${result.repo.name} is already added. Its row is open.`,
      );
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
      setError("Could not open the folder picker. Please try again.");
    } finally {
      setBusy(null);
    }
  };
  const addLink = () => {
    if (!host) return;
    if (forgeOf(link.trim()).host !== host.host) {
      setError(`Paste a ${host.name} project link. ${OTHER_HOST_WORDS}`);
      return;
    }
    void add({ kind: "clone", origin: link.trim() }, "link");
  };
  return (
    <section
      aria-label="Add project"
      data-add-project
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
          Add project
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
          {there ? FOLDER_THERE_WORDS.button(there) : FOLDER_HERE_WORDS}
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
            {entry.name} repo
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
          New project
        </Button>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            marginLeft: "auto",
            color: "var(--fg-2)",
          }}
        >
          <label htmlFor="add-project-key">{TASK_KEY_WORDS.label}</label>
          <Input
            id="add-project-key"
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
      </div>
      {taskKey && (
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
              <label htmlFor="add-project-folder-path">{FOLDER_THERE_WORDS.label(there)}</label>
              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                <Input
                  id="add-project-folder-path"
                  value={folderPath}
                  onChange={(event) => setFolderPath(event.target.value)}
                  disabled={!!busy}
                  required
                  mono
                />
                <Button type="submit" size="sm" disabled={!!busy || !folderPath.trim()}>
                  {busy === "folder" ? "Adding..." : FOLDER_THERE_WORDS.add}
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
              <label htmlFor="new-project-name">Name</label>
              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
                <Input
                  id="new-project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={!!busy}
                  required
                  mono
                />
                <Button type="submit" size="sm" disabled={!!busy || !name.trim()}>
                  {busy === "new" ? "Adding..." : "Start project"}
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
                    <p>Your {host.name} repos</p>
                    <Input
                      aria-label="Find a repo"
                      placeholder="Find a repo"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    {loading && <p role="status">Reading your repos...</p>}
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
                                  · private
                                </span>
                              )}
                            </span>
                            {added ? (
                              <span style={{ color: "var(--fg-3)" }}>added</span>
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
                                {busy === project.fullName ? "Adding..." : "Add"}
                              </Button>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    addLink();
                  }}
                  style={{ marginTop: "var(--space-3)" }}
                >
                  <label htmlFor="project-link">
                    {signedIn ? "Or paste a" : "Paste a"} {host.name} link
                  </label>
                  <div
                    style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}
                  >
                    <Input
                      id="project-link"
                      mono
                      placeholder={`https://${host.host}/owner/project`}
                      value={link}
                      onChange={(event) => setLink(event.target.value)}
                      disabled={!!busy}
                      required
                    />
                    <Button type="submit" size="sm" disabled={!!busy || !link.trim()}>
                      {busy === "link" ? "Adding..." : "Add"}
                    </Button>
                  </div>
                  <p style={{ color: "var(--fg-3)" }}>Goes into your projects folder, {folder}.</p>
                </form>
              </>
            )
          )}
          <Button variant="ghost" size="sm" onClick={() => chooseMode(null)}>
            Close
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
        {error ?? status ?? (busy === "folder" ? "Adding..." : null)}
      </div>
    </section>
  );
}
