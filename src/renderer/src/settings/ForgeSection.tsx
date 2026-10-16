import { hostOfAddress } from "@shared/forge";
import {
  FORGE_BROWSER_WORDS,
  FORGE_SECTION_WORDS,
  type ForgeHostView,
  type ForgeServerView,
  type ForgeSignInFlow,
  type ForgeSignInView,
  type ForgesView,
  forgeAddressExample,
  forgeKeyIntro,
  forgeKeyPage,
  forgeKeyProblemText,
  GITHUB_ENTERPRISE,
} from "@shared/forges";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { useShellStore } from "../app/store";
import {
  Badge,
  Button,
  Input,
  type InputProps,
  RowMenu,
  StatusDot,
  type StatusDotTone,
} from "../design";
import { DeviceForgeRows } from "./DeviceForgeRows";
import { THIS_MAC_FORGE_ROLE } from "./deviceForgeWords";
import { ForgeBrowserAside } from "./ForgeBrowserAside";
import { LABEL_GAP, ROW_GAP } from "./settingRows";
import "../accounts/connectChips.css";
import "./forges.css";
import { HERE } from "@shared/deviceNames";

/**
 * "Where your projects live" (git integration PR 1.2; design skill
 * `components/projects/ForgeRow`): the optional section at the top of
 * Settings -> Projects where the person signs the app in to the place their
 * projects live - GitHub or GitLab. Optional by the captain's standing
 * constraint: with nothing signed in it is one quiet line and a chip, never
 * a warning, and a project kept on this Mac never needs it.
 *
 * The sign-in is the host's device flow, run by the core: this section
 * shows the code, opens the host's page on the person's click, and follows
 * the `inf:forges` push for how it ends. GitLab first guides a per-host
 * public application registration and offers the existing key form as an
 * alternative. GitHub Enterprise keeps its key form. No stored sign-in
 * secret comes back to the renderer (`docs/forge.md`).
 *
 * With a computer that runs work, each computer's own sign-in follows this
 * Mac's (`DeviceForgeRows`, design skill `components/devices/SignInOnAMac`),
 * and this Mac's row says its own part: it opens, checks and merges pull
 * requests.
 */

const plusIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M5 12h14M12 5v14" />
  </svg>
);

const EMPTY_VIEW: ForgesView = { signIns: [], hosts: [], flow: null, ended: null };

/** The row's dot and its one word, from the sign-in's health alone. */
export function forgeRowView(signIn: ForgeSignInView): {
  tone: StatusDotTone;
  label: string;
  reauth: boolean;
} {
  switch (signIn.state) {
    case "ok":
      return { tone: "ok", label: "signed in", reauth: false };
    case "needs_reauth":
      return { tone: "danger", label: "sign in again", reauth: true };
    case "unavailable":
      return { tone: "ring", label: `signed in · could not reach ${signIn.name}`, reauth: false };
    default:
      return { tone: "ring", label: "signed in · checking", reauth: false };
  }
}

/** "as octo · 3 projects here"; a host on the person's own server says what it runs first. */
export function forgeRowSub(signIn: ForgeSignInView): string {
  const who = signIn.login ? `as ${signIn.login}` : null;
  const projects =
    signIn.projects === 0
      ? "no projects here yet"
      : signIn.projects === 1
        ? "1 project here"
        : `${signIn.projects} projects here`;
  return [signIn.server?.name, who, projects].filter(Boolean).join(" · ");
}

/** Server sign-in setup on screen: the host it is for ("" for a new address) and the kind of server. */
type KeyForm = { host: string; server: ForgeServerView; method?: "key" };

export function ForgeSection() {
  const [view, setView] = useState<ForgesView>(EMPTY_VIEW);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [keyForm, setKeyForm] = useState<KeyForm | null>(null);
  const [devices, setDevices] = useState(false);
  const pending = useShellStore((s) => s.pendingForgeSignIn);

  useEffect(() => {
    let live = true;
    void window.infinitary.forges.list().then((next) => {
      if (!live) return;
      setView(next);
      setLoaded(true);
    });
    const off = window.infinitary.forges.onChange(setView);
    return () => {
      live = false;
      off();
    };
  }, []);

  const signIn = useCallback((host: string) => {
    setKeyForm(null);
    setStarting(host);
    void window.infinitary.forges
      .signIn(host)
      .catch(() => undefined)
      .finally(() => setStarting((current) => (current === host ? null : current)));
  }, []);

  // Opening server setup (browser registration or a key) ends a code on screen.
  const openKeyForm = useCallback((form: KeyForm) => {
    void window.infinitary.forges.cancel();
    setKeyForm(form);
  }, []);

  // A card's "Sign in to GitHub" lands here with the sign-in to start, so
  // the code - or, for a host on the person's own server, its key form - is
  // on screen when the section opens.
  useEffect(() => {
    if (!pending || !loaded) return;
    useShellStore.getState().clearPendingForgeSignIn();
    const known = [...view.hosts, ...view.signIns].find((entry) => entry.host === pending);
    if (view.hosts.some((entry) => entry.host === pending && !entry.server)) signIn(pending);
    else
      openKeyForm({
        host: pending,
        server: known?.server ?? view.servers?.[0] ?? GITHUB_ENTERPRISE,
      });
  }, [pending, loaded, view, signIn, openKeyForm]);

  const signedIn = new Set(view.signIns.map((row) => row.host));
  const flowHost = (view.flow ?? view.ended)?.host;
  const chips = view.hosts.filter((host) => !signedIn.has(host.host));
  const servers = (view.servers ?? []).filter(
    (server) =>
      !chips.some((host) => host.server?.kind === server.kind && host.name === server.name),
  );
  const flowUnderRow = (host: string) =>
    !keyForm && (view.flow?.host === host || view.ended?.host === host);
  const keyUnderRow = (host: string) => keyForm !== null && keyForm.host === host;
  const keyAside =
    keyForm &&
    (keyForm.server.browser && keyForm.method !== "key" ? (
      <ForgeBrowserAside
        key={`browser:${keyForm.host}`}
        address={keyForm.host}
        applicationId={view.signIns.find((row) => row.host === keyForm.host)?.applicationId}
        server={keyForm.server}
        onDone={() => setKeyForm(null)}
        onKey={(host) => setKeyForm({ ...keyForm, host, method: "key" })}
        onCancel={() => {
          void window.infinitary.forges.cancel();
          setKeyForm(null);
        }}
      />
    ) : (
      <KeyAside
        key={`${keyForm.server.kind}:${keyForm.host}`}
        form={keyForm}
        onDone={() => setKeyForm(null)}
        onBrowser={
          keyForm.server.browser
            ? (host) => setKeyForm({ host, server: keyForm.server })
            : undefined
        }
        onCancel={() => setKeyForm(null)}
      />
    ));

  return (
    <section data-forges="" style={{ marginBottom: "var(--space-6)" }}>
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
        Where your projects live
      </div>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", marginBottom: ROW_GAP }}>
        Optional. Sign in once and your first mate can clone your projects and merge changes for
        you; projects kept on {HERE.this} need no sign-in.
      </div>
      <div className="fm-forges-box" data-forges-list="">
        {view.signIns.length === 0 && (
          <div className="fm-forges-quiet" data-forges-quiet="">
            {FORGE_SECTION_WORDS.quiet}
          </div>
        )}
        {view.signIns.map((row) => (
          <div key={row.host}>
            <ForgeRow
              signIn={row}
              beside={devices}
              busy={starting === row.host}
              onSignIn={() =>
                row.server ? openKeyForm({ host: row.host, server: row.server }) : signIn(row.host)
              }
              onSignOut={() => void window.infinitary.forges.signOut(row.host).then(setView)}
            />
            {flowUnderRow(row.host) && <SignInAside view={view} onRetry={signIn} />}
            {keyUnderRow(row.host) && keyAside}
          </div>
        ))}
        {(chips.length > 0 || servers.length > 0) && (
          <div className="fm-forges-add">
            <div className="fm-connect-chips" data-connect-chips="foot">
              {chips.map((host) => (
                <HostChip
                  key={host.host}
                  host={host}
                  busy={starting === host.host || view.flow?.host === host.host}
                  onConnect={() =>
                    host.server
                      ? openKeyForm({ host: host.host, server: host.server })
                      : signIn(host.host)
                  }
                />
              ))}
              {servers.map((server) => (
                <HostChip
                  key={`server:${server.kind}`}
                  host={{ host: "", name: server.name }}
                  busy={false}
                  onConnect={() => openKeyForm({ host: "", server })}
                />
              ))}
            </div>
            {!keyForm && flowHost && !signedIn.has(flowHost) && (
              <SignInAside view={view} onRetry={signIn} />
            )}
            {keyForm && !signedIn.has(keyForm.host) && keyAside}
          </div>
        )}
        <DeviceForgeRows onAny={setDevices} />
      </div>
    </section>
  );
}

function ForgeRow({
  signIn,
  beside,
  busy,
  onSignIn,
  onSignOut,
}: {
  signIn: ForgeSignInView;
  /** Computers' own sign-ins follow it: it names its login and its own part. */
  beside: boolean;
  busy: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const row = forgeRowView(signIn);
  return (
    <div className="fm-forges-row" data-forge-row={signIn.host} data-forge-state={signIn.state}>
      <span className="fm-forges-dot">
        <StatusDot
          tone={row.tone}
          label={row.label}
          nativeTitle={row.label !== "signed in" && row.label !== "sign in again"}
          focusable
        />
      </span>
      <span className="fm-forges-name">
        {beside && signIn.login ? `${signIn.name} · ${signIn.login}` : signIn.name}
      </span>
      <span className="fm-forges-who">
        {row.reauth ? (
          <span className="fm-forges-state" data-tone="danger">
            {FORGE_SECTION_WORDS.reauth}
          </span>
        ) : (
          <Badge tone="ok">signed in</Badge>
        )}
        <span className="fm-forges-sub">{beside ? THIS_MAC_FORGE_ROLE : forgeRowSub(signIn)}</span>
      </span>
      <span className="fm-forges-action">
        {row.reauth && (
          <Button
            variant="primary"
            size="sm"
            pending={busy}
            pendingLabel="Starting..."
            onClick={onSignIn}
          >
            Sign in again
          </Button>
        )}
      </span>
      <span className="fm-forges-menu">
        <RowMenu
          label={`${signIn.name} actions`}
          items={[{ id: "sign-out", label: "Sign out", tone: "danger", onSelect: onSignOut }]}
        />
      </span>
    </div>
  );
}

function HostChip({
  host,
  busy,
  onConnect,
}: {
  host: ForgeHostView;
  busy: boolean;
  onConnect: () => void;
}) {
  return (
    <button
      type="button"
      className="fm-connect-chip"
      data-forge-chip={host.host || host.name}
      aria-label={`Sign in to ${host.name}`}
      title={`Sign in to ${host.name}`}
      disabled={busy}
      onClick={onConnect}
    >
      {plusIcon}
      <span>{busy ? "Connecting..." : host.name}</span>
    </button>
  );
}

/**
 * The key sign-in for a host on the person's own server: its address (filled
 * in for a host the app knows), a button that opens the host's page where
 * the person makes a key, and the key itself, masked. Sign in hands both to
 * the core, which asks the host who the key is before keeping it; the key
 * field clears either way, and what went wrong reads in the status line.
 */
function KeyAside({
  form,
  onDone,
  onCancel,
  onBrowser,
}: {
  form: KeyForm;
  onDone: () => void;
  onCancel: () => void;
  onBrowser?: ((address: string) => void) | undefined;
}) {
  const [address, setAddress] = useState(form.host);
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState("");
  const ids = useId();
  const host = hostOfAddress(address);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!host || !key.trim() || checking) return;
    setChecking(true);
    setProblem("");
    try {
      const result = await window.infinitary.forges.signInWithKey({
        kind: form.server.kind,
        address,
        key,
      });
      setKey("");
      if (result.ok) onDone();
      else setProblem(forgeKeyProblemText(result.problem, result.host, form.server));
    } catch {
      setProblem(FORGE_SECTION_WORDS.keyFailed);
    } finally {
      setChecking(false);
    }
  };
  return (
    <form
      className="fm-connect-aside fm-forges-aside"
      data-forge-key-form={form.host || form.server.kind}
      aria-label={`Sign in to ${form.host || form.server.name}`}
      onSubmit={(event) => void submit(event)}
    >
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
        {forgeKeyIntro(host, form.server)}
      </div>
      <div className="fm-forges-field">
        <label htmlFor={`${ids}-address`}>{FORGE_SECTION_WORDS.address}</label>
        <KeyFormInput
          id={`${ids}-address`}
          value={address}
          placeholder={forgeAddressExample(form.server.kind)}
          autoComplete="off"
          spellCheck={false}
          autoFocus={!form.host}
          onChange={(event) => setAddress(event.target.value)}
        />
      </div>
      <div className="fm-forges-aside-actions">
        <Button
          variant="secondary"
          size="sm"
          disabled={!host}
          onClick={() =>
            host && void window.infinitary.app.openExternal(forgeKeyPage(form.server.kind, host))
          }
        >
          Make a key on {host ?? form.server.name}
        </Button>
      </div>
      <div className="fm-forges-field">
        <label htmlFor={`${ids}-key`}>{FORGE_SECTION_WORDS.key}</label>
        <KeyFormInput
          id={`${ids}-key`}
          type="password"
          value={key}
          autoComplete="off"
          spellCheck={false}
          autoFocus={!!form.host}
          onChange={(event) => setKey(event.target.value)}
        />
      </div>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-forge-key-problem=""
        style={{ display: "block", fontSize: "var(--text-sm)", color: "var(--danger)" }}
      >
        {problem}
      </span>
      <div className="fm-forges-aside-actions">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          pending={checking}
          pendingLabel="Checking..."
          disabled={!host || !key.trim()}
        >
          Sign in
        </Button>
        {onBrowser && (
          <Button
            variant="secondary"
            size="sm"
            disabled={checking}
            onClick={() => onBrowser(address)}
          >
            {FORGE_BROWSER_WORDS.useBrowser}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The design input in the mono face, for an address or a key. */
function KeyFormInput(props: InputProps) {
  return <Input mono {...props} />;
}

/** Copy feedback belongs only to this code and this sign-in attempt. */
function CopyCode({ code }: { code: string }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const copy = async () => {
    setState("copying");
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        pending={state === "copying"}
        pendingLabel="Copying..."
        style={{ marginLeft: "var(--space-2)" }}
        onClick={() => void copy()}
      >
        Copy code
      </Button>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          display: "block",
          fontSize: "var(--text-sm)",
          color: state === "failed" ? "var(--danger)" : "var(--fg-2)",
        }}
      >
        {state === "copied"
          ? FORGE_SECTION_WORDS.copied
          : state === "failed"
            ? FORGE_SECTION_WORDS.copyFailed
            : ""}
      </span>
    </>
  );
}

/** The device-code aside: the code, the host's page, and how it ended. */
function SignInAside({ view, onRetry }: { view: ForgesView; onRetry: (host: string) => void }) {
  const flow: ForgeSignInFlow | null = view.flow;
  const name = (host: string) =>
    view.hosts.find((entry) => entry.host === host)?.name ??
    view.signIns.find((entry) => entry.host === host)?.name ??
    host;
  if (flow) {
    return (
      <div className="fm-connect-aside fm-forges-aside" data-forge-flow={flow.host}>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          Enter this code on {name(flow.host)}:
          <span className="fm-forges-code" data-forge-code="">
            {flow.userCode}
          </span>
          <CopyCode key={`${flow.host}:${flow.userCode}:${flow.expiresAt}`} code={flow.userCode} />
        </div>
        <div className="fm-forges-aside-actions">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void window.infinitary.app.openExternal(flow.verificationUri)}
          >
            Open {name(flow.host)}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void window.infinitary.forges.cancel()}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  const ended = view.ended;
  if (!ended) return null;
  return (
    <div className="fm-connect-aside fm-forges-aside" data-forge-ended={ended.end}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
        {ended.end === "expired"
          ? "The code expired."
          : `Could not reach ${name(ended.host)} - try again.`}
      </div>
      <div className="fm-forges-aside-actions">
        <Button variant="secondary" size="sm" onClick={() => onRetry(ended.host)}>
          {ended.end === "expired" ? "Get a new code" : "Try again"}
        </Button>
      </div>
    </div>
  );
}
