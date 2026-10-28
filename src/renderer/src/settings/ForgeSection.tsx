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
  GITLAB,
} from "@shared/forges";
import {
  INTEGRATIONS_SIGN_IN_HOST,
  INTEGRATIONS_WORDS,
  integrationHostArrival,
} from "@shared/integrations";
import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { CopyCode } from "../accounts/CopyCode";
import { useShellStore } from "../app/store";
import { Button, Input, type InputProps, type StatusDotTone } from "../design";
import { DeviceForgeRows } from "./DeviceForgeRows";
import { ForgeBrowserAside } from "./ForgeBrowserAside";
import "../accounts/connectChips.css";
import "./forges.css";

/** Projects keeps the pointer and other computers' own sign-ins (INF-1007 direction A).
 * This module also owns the shared host sign-in forms drawn by Integrations.
 */

/** The add chip's plus, shared with Settings -> Integrations' MCP server chip. */
export const plusIcon = (
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
export function forgeRowView(signIn: Pick<ForgeSignInView, "state" | "name">): {
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

/** Server sign-in setup on screen: the host it is for ("" for a new address) and the kind of server. */
type KeyForm = { host: string; server: ForgeServerView; method?: "key" };

/**
 * The host forms other than github.com, whose device-code flow the
 * Integrations tab draws directly.
 */
export function withoutIntegrationHost(view: ForgesView): ForgesView {
  const other = (host: string) => host !== INTEGRATIONS_SIGN_IN_HOST;
  return {
    ...view,
    signIns: view.signIns.filter((row) => other(row.host)),
    hosts: view.hosts.filter((row) => other(row.host)),
    flow: view.flow && other(view.flow.host) ? view.flow : null,
    ended: view.ended && other(view.ended.host) ? view.ended : null,
  };
}

export function ForgeSection() {
  return (
    <section data-forges="" style={{ marginBottom: "var(--space-6)" }}>
      <div className="fm-forges-box" data-forges-list="">
        <div className="fm-forges-pointer" data-integrations-pointer="">
          <span>{INTEGRATIONS_WORDS.pointer}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => useShellStore.setState({ settingsSection: "integrations" })}
          >
            {INTEGRATIONS_WORDS.open}
          </Button>
        </div>
        <DeviceForgeRows />
      </div>
    </section>
  );
}

/** Host chips and their original sign-in forms, now owned by Integrations. */
export function useForgeHostSignIn() {
  const [whole, setView] = useState<ForgesView>(EMPTY_VIEW);
  const view = withoutIntegrationHost(whole);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [keyForm, setKeyForm] = useState<KeyForm | null>(null);
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
    if (!pending || !loaded || pending === "github.com" || pending === "google") return;
    useShellStore.getState().clearPendingForgeSignIn();
    if (pending === "gitlab" || pending === "github-enterprise") {
      openKeyForm({
        host: pending === "gitlab" ? "gitlab.com" : "",
        server: pending === "gitlab" ? GITLAB : GITHUB_ENTERPRISE,
      });
      return;
    }
    const arrival = integrationHostArrival(pending);
    if (arrival) {
      openKeyForm({
        host: arrival.host,
        server: arrival.kind === "gitlab" ? GITLAB : GITHUB_ENTERPRISE,
      });
      return;
    }
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
        ended={view.ended}
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

  return {
    connect: (host: string) => {
      const known = [...view.hosts, ...view.signIns].find((entry) => entry.host === host);
      openKeyForm({
        host,
        server: known?.server ?? (host === "gitlab.com" ? GITLAB : GITHUB_ENTERPRISE),
      });
    },
    asideFor: (host: string) => (
      <>
        {flowUnderRow(host) && <SignInAside view={view} onRetry={signIn} />}
        {keyUnderRow(host) && keyAside}
      </>
    ),
    chips: (
      <>
        {chips.map((host) => (
          <HostChip
            key={host.host}
            host={host}
            busy={starting === host.host || view.flow?.host === host.host}
            onConnect={() => openKeyForm({ host: host.host, server: host.server ?? GITLAB })}
          />
        ))}
        {servers.map((server) => (
          <HostChip
            key={server.kind}
            host={{ host: "", name: server.name }}
            busy={false}
            onConnect={() => openKeyForm({ host: "", server })}
          />
        ))}
      </>
    ),
    foot: (
      <>
        {!keyForm && flowHost && !signedIn.has(flowHost) && (
          <SignInAside view={view} onRetry={signIn} />
        )}
        {keyForm && !signedIn.has(keyForm.host) && keyAside}
      </>
    ),
  };
}

export function HostChip({
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

/** The device-code aside: the code, the host's page, and how it ended. */
export function SignInAside({
  view,
  onRetry,
}: {
  view: ForgesView;
  onRetry: (host: string) => void;
}) {
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
