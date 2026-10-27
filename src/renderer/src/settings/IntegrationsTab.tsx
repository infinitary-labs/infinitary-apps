import type { AutomationList, AutomationRule } from "@shared/automation";
import { FORGE_SECTION_WORDS, type ForgesView } from "@shared/forges";
import {
  INBOX_WORDS,
  INTEGRATION_EFFECT_WORDS,
  INTEGRATION_KIND_NAMES,
  INTEGRATION_NOTICES,
  INTEGRATION_RULE_WORDS,
  INTEGRATION_SECRET_WORDS,
  INTEGRATIONS_BROWSER_SIGN_IN_WORDS,
  INTEGRATIONS_MCP_WORDS,
  INTEGRATIONS_SIGN_IN_HOST,
  INTEGRATIONS_WORDS,
  type IntegrationDoorView,
  type IntegrationKind,
  type IntegrationNotice,
  type IntegrationSettingsPatch,
  type IntegrationSignInConsent,
  type IntegrationsView,
  type IntegrationView,
  integrationRenameWords,
  NOTICE_ACCEPTED,
} from "@shared/integrations";
import type { KeptOutsideData } from "@shared/savedOutsideData";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { useCopyCode } from "../accounts/CopyCode";
import { useShellStore } from "../app/store";
import { Badge, Button, Input, RowMenu, StatusDot, type StatusDotTone, Switch } from "../design";
import "./integrations.css";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import { forgeRowView, HostChip, plusIcon, SignInAside, useForgeHostSignIn } from "./ForgeSection";
import { OutsideDataRow } from "./OutsideDataRow";
import {
  LABEL_GAP,
  ROW_GAP,
  SECTION_GAP,
  SectionLabel,
  SettingError,
  SettingRow,
} from "./settingRows";
import "../accounts/connectChips.css";
import "./forges.css";

/**
 * Settings -> Integrations (docs/integrations.md; design skill
 * `components/integrations/IntegrationRow`): what the first mate and the
 * crew reach outside the person's projects, one row per connection signed
 * in as the person. A row's chevron opens its actions, each with what it
 * does and its rule, and a switch that turns it off; its menu checks the
 * sign-in now, pauses it, or signs out and removes it. The chips at the
 * foot connect a kind not yet connected, and add an MCP server: its form
 * takes a name and what the server runs, connects, and opens the new row
 * on the tools the server listed (INF-781, the captain's q7: trust the
 * server's list and show it after).
 *
 * GitHub is the first kind, and its sign-in is the forge's device flow
 * (`docs/forge.md`): this tab starts it, shows the code, and follows the
 * `inf:forges` push for how it ends, as Settings -> Projects did before the
 * sign-in moved here (INF-775, the captain's q2). Google signs in in the
 * person's browser (`integrations.signIn`), after its notice: what
 * Infinitary uses from Gmail and Calendar and where it goes, which the
 * person accepts before anything is asked of Google (INF-949). While the
 * app waits for the browser to come back, an aside says so, opens the page
 * again or cancels, and the new row opens once it is back. The Infinitary
 * Inbox, Infinitary's own integration, has its own box under the
 * connections (the captain's reply on INF-1214, moved by INF-1474): what
 * it is and a switch, off until the person turns it on
 * (docs/integrations.md, "The inbox"); on, it shows the line a program
 * runs to send a note, a link for the short name, and whether a rule tells
 * the first mate, which turning the inbox on first adds and turns on (the
 * captain's word on INF-1214). The switch is the inbox's pause, and its
 * delete is in the Data section (INF-1567, the captain's direction C). The
 * Data section at the foot holds the deletes of what the first mate and
 * crew read, Delete Gmail and Calendar content whether or not Google is
 * connected, and the inbox's notes while it is kept (the captain:
 * "maybe all data deletion stuff gets put into another "Data" section at
 * the bottom of the integrations tab"). Every change here goes through the
 * same channels the first mate's `app_change` lines reach.
 */

const EMPTY: IntegrationsView = { integrations: [], addable: [] };
const NO_FORGES: ForgesView = { signIns: [], hosts: [], flow: null, ended: null };

export function IntegrationsTab() {
  const [view, setView] = useState<IntegrationsView>(EMPTY);
  const [forges, setForges] = useState<ForgesView>(NO_FORGES);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [adding, setAdding] = useState(false);
  const addChip = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  /** The kind whose sign-in waits for the person's browser. */
  const [browser, setBrowser] = useState<IntegrationKind | null>(null);
  const browserRun = useRef(0);
  /** The kind whose notice is open, and what had the focus when it opened. */
  const [notice, setNotice] = useState<IntegrationKind | null>(null);
  const noticeFrom = useRef<HTMLElement | null>(null);
  const hostSignIn = useForgeHostSignIn();
  const pending = useShellStore((s) => s.pendingForgeSignIn);
  // The words from outside this build keeps for a while, deleted in the Data section below.
  const [kept, setKept] = useState<readonly KeptOutsideData[]>([]);
  // The rules on the inbox, so its box says whether one tells the first mate; null until read.
  const [inboxRules, setInboxRules] = useState<AutomationRule[] | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([window.infinitary.integrations.list(), window.infinitary.forges.list()]).then(
      ([next, nextForges]) => {
        if (!live) return;
        setView(next);
        setForges(nextForges);
        setLoaded(true);
      },
    );
    const offIntegrations = window.infinitary.integrations.onChange(setView);
    const offForges = window.infinitary.forges.onChange(setForges);
    return () => {
      live = false;
      offIntegrations();
      offForges();
    };
  }, []);

  useEffect(
    () =>
      appReadExecutor().subscribe(
        "automation.list",
        {},
        {
          onValue: (value) => {
            const list = value as AutomationList;
            // Unreadable is not empty: the box says nothing it cannot tell.
            if (list.state !== "ready") return;
            setInboxRules(
              list.rules.filter(
                (rule) => rule.spec.kind === "event" && rule.spec.integration === "inbox",
              ),
            );
          },
          onError: () => {},
        },
      ),
    [],
  );

  useEffect(() => {
    let live = true;
    void window.infinitary.retention
      .scope()
      .then(({ kept }) => {
        if (live) setKept(kept ?? []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const signIn = useCallback(() => {
    setError(null);
    setStarting(true);
    void window.infinitary.forges
      .signIn(INTEGRATIONS_SIGN_IN_HOST)
      .catch(() => undefined)
      .finally(() => setStarting(false));
  }, []);

  // A sign-in in the browser: a second one ends the first, whose answer is
  // then nobody's, and so does Cancel.
  const signInInBrowser = useCallback(
    (kind: IntegrationKind, consent?: IntegrationSignInConsent) => {
      const run = ++browserRun.current;
      setError(null);
      setBrowser(kind);
      window.infinitary.integrations
        .signIn(kind, consent)
        .then(({ id, view: next }) => {
          if (browserRun.current !== run) return;
          setBrowser(null);
          setView(next);
          setOpen(id);
        })
        .catch((caught: unknown) => {
          if (browserRun.current !== run) return;
          setBrowser(null);
          setError(caught instanceof Error ? caught.message : String(caught));
        });
    },
    [],
  );
  // A kind with a notice shows it first (INF-949): its page opens only on
  // the notice's accept, and Cancel, or leaving the tab, asks nothing.
  const startBrowserSignIn = useCallback(
    (kind: IntegrationKind) => {
      if (!INTEGRATION_NOTICES[kind]) {
        signInInBrowser(kind);
        return;
      }
      setError(null);
      noticeFrom.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setNotice(kind);
    },
    [signInInBrowser],
  );
  const acceptNotice = (kind: IntegrationKind) => {
    setNotice(null);
    signInInBrowser(kind, NOTICE_ACCEPTED);
  };
  const cancelNotice = () => {
    setNotice(null);
    noticeFrom.current?.focus();
  };
  // The page again, for the sign-in waiting now: a kind with a notice waits
  // only once its notice was accepted, so the accept still stands.
  const signInAgain = (kind: IntegrationKind) =>
    signInInBrowser(kind, INTEGRATION_NOTICES[kind] ? NOTICE_ACCEPTED : undefined);
  const cancelBrowser = () => {
    browserRun.current++;
    setBrowser(null);
    void window.infinitary.integrations.cancelSignIn().then(setView);
  };

  // A card's "Sign in to GitHub" lands here with the sign-in to start, so
  // the code is on screen when the tab opens; a card's Google sign-in opens
  // Google's notice, and its accept opens Google's page.
  useEffect(() => {
    if (!loaded || (pending !== "github.com" && pending !== "google")) return;
    if (pending === INTEGRATIONS_SIGN_IN_HOST) {
      useShellStore.getState().clearPendingForgeSignIn();
      signIn();
      return;
    }
    useShellStore.getState().clearPendingForgeSignIn();
    const kind =
      view.addable.find((entry) => entry.kind === pending)?.kind ??
      view.integrations.find((row) => row.kind === pending)?.kind;
    if (kind) startBrowserSignIn(kind);
  }, [pending, loaded, signIn, view, startBrowserSignIn]);

  // The inbox has nothing to wait for: it is on when the answer comes back.
  const turnOnInbox = () => {
    setError(null);
    window.infinitary.integrations
      .signIn("inbox")
      .then(({ view: next }) => setView(next))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  };
  const change = (run: () => Promise<IntegrationsView>) => {
    setError(null);
    run()
      .then(setView)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  };
  const configure = (id: string, patch: IntegrationSettingsPatch) =>
    change(() => window.infinitary.integrations.configure(id, patch));

  const github = forges.signIns.find((row) => row.host === INTEGRATIONS_SIGN_IN_HOST);
  const flowHere = (forges.flow ?? forges.ended)?.host === INTEGRATIONS_SIGN_IN_HOST;
  const aside = flowHere && (
    <SignInAside
      view={{
        ...forges,
        hosts: [{ host: INTEGRATIONS_SIGN_IN_HOST, name: "GitHub" }, ...forges.hosts],
      }}
      onRetry={signIn}
    />
  );
  const browserAside = browser && (
    <div className="fm-connect-aside fm-forges-aside" data-integration-signing-in={browser}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
        {INTEGRATIONS_BROWSER_SIGN_IN_WORDS.waiting(INTEGRATION_KIND_NAMES[browser])}
      </div>
      <div className="fm-forges-aside-actions">
        <Button variant="secondary" size="sm" onClick={() => signInAgain(browser)}>
          {INTEGRATIONS_BROWSER_SIGN_IN_WORDS.again}
        </Button>
        <Button variant="ghost" size="sm" onClick={cancelBrowser}>
          {INTEGRATIONS_BROWSER_SIGN_IN_WORDS.cancel}
        </Button>
      </div>
    </div>
  );
  const noticeWords = notice && INTEGRATION_NOTICES[notice];
  const noticeAside = notice && noticeWords && (
    <IntegrationNoticeAside
      kind={notice}
      notice={noticeWords}
      onAccept={() => acceptNotice(notice)}
      onCancel={cancelNotice}
    />
  );

  const inbox = view.integrations.find((integration) => integration.kind === "inbox");
  const connected = view.integrations.filter((integration) => integration.kind !== "inbox");

  return (
    <section
      data-integrations=""
      style={{ display: "flex", flexDirection: "column", gap: ROW_GAP }}
    >
      <div>
        <div style={{ fontSize: "var(--text-md)", color: "var(--fg-1)", fontWeight: 500 }}>
          {INTEGRATIONS_WORDS.title}
        </div>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", marginTop: LABEL_GAP }}>
          {INTEGRATIONS_WORDS.intro}
        </div>
      </div>
      <SettingError error={error} />
      <div className="fm-forges-box" data-integrations-list="">
        {loaded && connected.length === 0 && (
          <div className="fm-forges-quiet" data-integrations-quiet="">
            {INTEGRATIONS_WORDS.quiet}
          </div>
        )}
        {connected.map((integration) => (
          <div key={integration.id}>
            <IntegrationRow
              integration={integration}
              open={open === integration.id}
              busy={integration.kind === "github" ? starting : browser === integration.kind}
              onToggle={() =>
                setOpen((current) => (current === integration.id ? null : integration.id))
              }
              onSignIn={
                integration.kind === "github"
                  ? signIn
                  : integration.host
                    ? () => hostSignIn.connect(integration.host ?? "")
                    : () => startBrowserSignIn(integration.kind)
              }
              onCheck={() => change(() => window.infinitary.integrations.check(integration.id))}
              onPause={(paused) => configure(integration.id, { paused })}
              onRemove={() => change(() => window.infinitary.integrations.remove(integration.id))}
            />
            {integration.renamed && (
              <p className="fm-integrations-renamed" data-integration-renamed={integration.id}>
                {integrationRenameWords(integration.renamed)}
              </p>
            )}
            {open === integration.id && (
              <IntegrationActions
                integration={integration}
                onRule={(name, allowed) =>
                  change(() => window.infinitary.integrations.rule(integration.id, name, allowed))
                }
                onAction={(name, enabled) =>
                  configure(integration.id, { actions: { [name]: enabled } })
                }
              />
            )}
            {open === integration.id && integration.secrets && (
              <IntegrationKeys
                integration={integration}
                onSave={(slot, value) =>
                  change(() => window.infinitary.integrations.secret(integration.id, slot, value))
                }
              />
            )}
            {integration.host && hostSignIn.asideFor(integration.host)}
            {integration.kind === "github" && aside}
            {notice === integration.kind && noticeAside}
            {browser === integration.kind && browserAside}
          </div>
        ))}
        {view.addable.length > 0 && (
          <div className="fm-forges-add">
            <div className="fm-connect-chips" data-connect-chips="foot">
              {view.addable
                .filter(
                  (entry) =>
                    entry.kind !== "gitlab" &&
                    entry.kind !== "github-enterprise" &&
                    entry.kind !== "inbox",
                )
                .map((kind) => (
                  <span
                    key={kind.kind}
                    data-integration-add={kind.kind}
                    style={{ display: "contents" }}
                  >
                    {kind.kind === "mcp" ? (
                      <button
                        ref={addChip}
                        type="button"
                        className="fm-connect-chip"
                        aria-label={INTEGRATIONS_MCP_WORDS.title}
                        aria-expanded={adding}
                        onClick={() => {
                          setError(null);
                          setAdding(true);
                        }}
                      >
                        {plusIcon}
                        <span>{INTEGRATIONS_MCP_WORDS.add}</span>
                      </button>
                    ) : kind.kind === "github" ? (
                      <HostChip
                        host={{ host: INTEGRATIONS_SIGN_IN_HOST, name: kind.name }}
                        busy={starting || forges.flow?.host === INTEGRATIONS_SIGN_IN_HOST}
                        onConnect={signIn}
                      />
                    ) : (
                      <HostChip
                        host={{ host: kind.kind, name: kind.name }}
                        busy={browser === kind.kind}
                        onConnect={() => startBrowserSignIn(kind.kind)}
                      />
                    )}
                  </span>
                ))}
              {hostSignIn.chips}
            </div>
            {adding && (
              <McpAddForm
                onAdded={(id) => {
                  setAdding(false);
                  setOpen(id);
                }}
                onCancel={() => {
                  setAdding(false);
                  addChip.current?.focus();
                }}
              />
            )}
            {hostSignIn.foot}
            {!github && aside}
            {notice && !view.integrations.some((row) => row.kind === notice) && noticeAside}
            {browser && !view.integrations.some((row) => row.kind === browser) && browserAside}
          </div>
        )}
      </div>
      <InboxSection
        inbox={inbox}
        rules={inboxRules}
        loaded={loaded}
        onTurn={(on) => {
          // The switch is the inbox's pause once it is kept (INF-1567).
          if (inbox) configure(inbox.id, { paused: !on });
          else if (on) turnOnInbox();
        }}
        onLink={() => change(() => window.infinitary.integrations.linkInbox())}
      />
      {(kept.length > 0 || inbox) && (
        // A section is 32 above, and the tab's column already spaces each child by 12.
        <div data-integrations-data="" style={{ marginTop: `calc(${SECTION_GAP} - ${ROW_GAP})` }}>
          <SectionLabel>{INTEGRATIONS_WORDS.data}</SectionLabel>
          <OutsideDataRow kept={kept} />
          {inbox && (
            <InboxDeleteRow
              onDelete={() =>
                window.infinitary.integrations.remove(inbox.id).then((next) => setView(next))
              }
            />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A kind's notice before its sign-in (INF-949; design skill
 * `components/integrations/IntegrationRow`): what it uses and where it
 * goes, then Accept, which starts the sign-in, beside Cancel, which asks
 * nothing. It takes the focus when it opens, so it is read from the top
 * and Tab reaches Accept; it never closes by itself.
 */
function IntegrationNoticeAside({
  kind,
  notice,
  onAccept,
  onCancel,
}: {
  kind: IntegrationKind;
  notice: IntegrationNotice;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div className="fm-connect-aside fm-forges-aside">
      <section
        ref={box}
        tabIndex={-1}
        className="fm-integrations-notice"
        data-integration-notice={kind}
        aria-labelledby={`${ids}-title`}
      >
        <div id={`${ids}-title`} className="fm-integrations-notice-title">
          {notice.title}
        </div>
        <p className="fm-integrations-notice-lead">{notice.lead}</p>
        {notice.groups.map((group, index) => (
          <div key={group.heading} className="fm-integrations-notice-group">
            <div id={`${ids}-${index}`} className="fm-integrations-notice-head">
              {group.heading}
            </div>
            <ul aria-labelledby={`${ids}-${index}`}>
              {group.items.map((item) => (
                <li key={item.text}>
                  {item.name && <span className="fm-integrations-notice-name">{item.name}</span>}
                  {item.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="fm-integrations-notice-closing">{notice.closing}</p>
        <div className="fm-forges-aside-actions">
          <Button variant="primary" size="sm" onClick={onAccept}>
            {notice.accept}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {notice.cancel}
          </Button>
        </div>
      </section>
    </div>
  );
}

/**
 * "as octo · 2 actions", or what an MCP server runs: "npx -y @scope/notes ·
 * 3 actions"; a paused one says so first.
 */
export function integrationRowSub(integration: IntegrationView): string {
  const on = integration.actions.filter((action) => action.enabled).length;
  const actions = on === 1 ? "1 action" : `${on} actions`;
  const who = integration.account ? `as ${integration.account}` : null;
  return [
    integration.paused ? "paused" : null,
    integration.host && integration.host !== "gitlab.com"
      ? INTEGRATION_KIND_NAMES[integration.kind]
      : null,
    who,
    integration.runs,
    actions,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A row's dot and its words: a sign-in's for a kind that signs in, a connection's for an MCP server. */
function integrationRowView(integration: IntegrationView): {
  tone: StatusDotTone;
  label: string;
  reauth: boolean;
  badge: string;
  problem: string | null;
} {
  if (integration.kind !== "mcp") {
    const row = forgeRowView({ name: integration.name, state: integration.health });
    return {
      ...row,
      badge: "signed in",
      problem: row.reauth ? FORGE_SECTION_WORDS.reauth : null,
    };
  }
  const problem = integration.health === "unavailable" ? "could not reach it" : null;
  return {
    tone:
      integration.health === "ok" ? "ok" : integration.health === "unavailable" ? "danger" : "ring",
    label: problem ?? INTEGRATIONS_MCP_WORDS.connected,
    reauth: false,
    badge: INTEGRATIONS_MCP_WORDS.connected,
    problem,
  };
}

function IntegrationRow({
  integration,
  open,
  busy,
  onToggle,
  onSignIn,
  onCheck,
  onPause,
  onRemove,
}: {
  integration: IntegrationView;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onSignIn: () => void;
  onCheck: () => void;
  onPause: (paused: boolean) => void;
  onRemove: () => void;
}) {
  const row = integrationRowView(integration);
  return (
    <div
      className="fm-forges-row"
      data-integration-row={integration.id}
      data-integration-state={integration.health}
      // GitHub's row is the github.com sign-in's own row, marked as the forge rows are.
      {...(integration.kind === "github" || integration.host
        ? {
            "data-forge-row": integration.host ?? INTEGRATIONS_SIGN_IN_HOST,
            "data-forge-state": integration.health,
          }
        : {})}
    >
      <span className="fm-forges-dot">
        <StatusDot
          tone={integration.paused ? "idle" : row.tone}
          label={integration.paused ? "paused" : row.label}
          nativeTitle={row.label !== row.badge && !row.reauth && row.problem === null}
          focusable
        />
      </span>
      <button
        type="button"
        className="fm-integrations-toggle"
        data-integration-toggle={integration.id}
        aria-expanded={open}
        aria-label={`${integration.name}, ${open ? "expanded" : "collapsed"}`}
        onClick={onToggle}
      >
        <span className="fm-forges-name">{integration.name}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ transform: open ? "rotate(180deg)" : "none" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <span className="fm-forges-who">
        {row.problem ? (
          <span className="fm-forges-state" data-tone="danger">
            {row.problem}
          </span>
        ) : integration.paused ? (
          <Badge tone="outline">paused</Badge>
        ) : (
          <Badge tone="ok">{row.badge}</Badge>
        )}
        <span className="fm-forges-sub">{integrationRowSub(integration)}</span>
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
          label={`${integration.name} actions`}
          items={[
            { id: "check", label: "Check now", onSelect: onCheck },
            integration.paused
              ? { id: "resume", label: "Resume", onSelect: () => onPause(false) }
              : {
                  id: "pause",
                  label: "Pause",
                  detail: "Nobody reaches it until you resume it",
                  onSelect: () => onPause(true),
                },
            { separator: true },
            {
              id: "remove",
              label:
                integration.kind === "mcp" ? INTEGRATIONS_MCP_WORDS.remove : "Sign out and remove",
              tone: "danger",
              onSelect: onRemove,
            },
          ]}
        />
      </span>
    </div>
  );
}

/**
 * An open row's actions: what each does, its rule, and its switch; then
 * what it can tell - an MCP server's "A resource changed" - which a rule
 * in Automation listens to.
 */
function IntegrationActions({
  integration,
  onAction,
  onRule,
}: {
  integration: IntegrationView;
  onAction: (name: string, enabled: boolean) => void;
  onRule: (name: string, allowed: boolean) => void;
}) {
  return (
    <ul
      className="fm-integrations-actions"
      aria-label={`${integration.name} actions`}
      data-integration-actions={integration.id}
    >
      {integration.actions.map((action) => (
        <li key={action.name} data-integration-action={action.name}>
          <span className="fm-integrations-action-label">{action.label}</span>
          <Badge tone="outline">{INTEGRATION_EFFECT_WORDS[action.effect]}</Badge>
          <Button
            variant="ghost"
            size="sm"
            className="fm-forges-state fm-integration-rule"
            data-integration-rule={action.rule}
            aria-label={`${action.label}: ${INTEGRATION_RULE_WORDS[action.rule]}`}
            off={!action.enabled}
            note={
              action.enabled
                ? "Choose Asks you or Always allowed"
                : "Turn the action on to change its approval"
            }
            onClick={() => action.enabled && onRule(action.name, action.rule !== "allow")}
          >
            {INTEGRATION_RULE_WORDS[action.rule]}
          </Button>
          <Switch
            checked={action.enabled}
            aria-label={`${action.label} on`}
            onChange={(enabled) => onAction(action.name, enabled)}
          />
        </li>
      ))}
      {integration.events?.map((event) => (
        <li key={`event-${event.name}`} data-integration-event={event.name}>
          <span className="fm-integrations-action-label">{event.label}</span>
          <Badge tone="outline">{INTEGRATIONS_MCP_WORDS.events}</Badge>
          <span />
          <span />
        </li>
      ))}
    </ul>
  );
}

/**
 * The Infinitary Inbox's own box (docs/integrations.md, "The inbox"; the
 * captain's reply on INF-1214: "it should be its own section, and default
 * it's off, and we tell the user what it is, and that they can turn it
 * on"): its name, what it is and a switch, then, while it is on, the line
 * to copy, one note, and whether a rule tells the first mate. The switch is
 * the connection's pause (INF-1567, direction C): off, the notes and the key
 * stay and scripts get an error.
 */
function InboxSection({
  inbox,
  rules,
  loaded,
  onTurn,
  onLink,
}: {
  inbox: IntegrationView | undefined;
  rules: readonly AutomationRule[] | null;
  loaded: boolean;
  onTurn: (on: boolean) => void;
  onLink: () => void;
}) {
  const on = inbox !== undefined && !inbox.paused;
  return (
    <div className="fm-forges-box fm-integrations-inbox" data-inbox-section={on ? "on" : "off"}>
      <div className="fm-integrations-inbox-head">
        <div>
          <div className="fm-integrations-inbox-title">{INBOX_WORDS.title}</div>
          <p className="fm-integrations-door-lead">{INBOX_WORDS.intro}</p>
        </div>
        <Switch checked={on} disabled={!loaded} aria-label={INBOX_WORDS.toggle} onChange={onTurn} />
      </div>
      {loaded && !on && (
        <p className="fm-integrations-door-note" data-inbox-off={inbox ? "kept" : "new"}>
          {inbox ? `${INBOX_WORDS.offKept} ${INBOX_WORDS.off}` : INBOX_WORDS.off}
        </p>
      )}
      {on && inbox.door && <InboxDoorPanel door={inbox.door} rules={rules} onLink={onLink} />}
    </div>
  );
}

/**
 * Whether a rule tells the first mate of a note (INF-1567, the captain's
 * q4: "the box then never says told at once when it is false"): a
 * turned-on rule listens; else one paused in Automation, named; else none.
 */
function inboxRuleLine(rules: readonly AutomationRule[]): {
  state: "told" | "paused" | "none";
  words: string;
} {
  if (rules.some((rule) => rule.state === "enabled" && rule.stopped === undefined))
    return { state: "told", words: INBOX_WORDS.told };
  const paused = rules.find((rule) => rule.state === "paused");
  if (paused)
    return { state: "paused", words: INBOX_WORDS.rulePaused(paused.name ?? INBOX_WORDS.ruleName) };
  return { state: "none", words: INBOX_WORDS.noRule };
}

/**
 * The inbox's open part (docs/integrations.md, "The inbox"; INF-1474, the
 * captain's wording B, shown whole on their reply to INF-1475): the line a
 * program runs, in full and copied with one press, and one note; then the
 * short name's link where the folder takes one or already holds it (the
 * captain's q4: nothing where it cannot be made); then whether a rule
 * tells the first mate, and what off does (INF-1567).
 */
function InboxDoorPanel({
  door,
  rules,
  onLink,
}: {
  door: IntegrationDoorView;
  rules: readonly AutomationRule[] | null;
  onLink: () => void;
}) {
  const { state, copy, status } = useCopyCode(door.line, true);
  const { link } = door;
  const rule = rules && inboxRuleLine(rules);
  return (
    <div className="fm-integrations-door" data-inbox-door={link.state}>
      <div className="fm-integrations-door-line">
        <code data-inbox-line="">{door.line}</code>
        <span>
          <Button
            variant="secondary"
            size="sm"
            pending={state === "copying"}
            pendingLabel="Copying..."
            onClick={() => void copy()}
          >
            {INBOX_WORDS.copy}
          </Button>
          {status}
        </span>
      </div>
      <p className="fm-integrations-door-note" data-inbox-example-note="">
        {INBOX_WORDS.exampleNote}
      </p>
      {(link.state === "linked" || link.state === "offered") && (
        <div className="fm-integrations-door-link" data-inbox-link={link.state}>
          <span>
            {link.state === "linked"
              ? INBOX_WORDS.linked(link.path)
              : INBOX_WORDS.offered(link.path.slice(0, link.path.lastIndexOf("/")))}
          </span>
          {link.state === "offered" && (
            <Button variant="secondary" size="sm" onClick={onLink}>
              {INBOX_WORDS.link}
            </Button>
          )}
        </div>
      )}
      <p className="fm-integrations-door-lead" data-inbox-rule={rule?.state ?? "unread"}>
        {rule ? `${rule.words} ` : ""}
        {INBOX_WORDS.offKeeps}
      </p>
    </div>
  );
}

/**
 * The inbox's delete, in the Data section (INF-1567, direction C): every
 * note the person's scripts sent and the inbox's key go, and the inbox is
 * off. Armed on the first press and run on the second, as the Gmail and
 * Calendar content's delete is.
 */
function InboxDeleteRow({ onDelete }: { onDelete: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    if (deleting) return;
    if (!armed) {
      setArmed(true);
      return;
    }
    setDeleting(true);
    setError(null);
    onDelete()
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => {
        setDeleting(false);
        setArmed(false);
      });
  };
  return (
    <SettingRow
      id="delete-inbox-notes"
      title={INBOX_WORDS.deleteTitle}
      description={INBOX_WORDS.deleteLead}
      error={error}
      control={
        <Button
          variant={armed ? "danger" : "ghost"}
          size="sm"
          onClick={remove}
          pending={deleting}
          pendingLabel={INBOX_WORDS.pending}
        >
          {armed ? INBOX_WORDS.confirm : INBOX_WORDS.delete}
        </Button>
      }
    />
  );
}

/**
 * An open row's keys (docs/integrations.md, "Keys"): each slot its kind
 * declares, whether a value is kept, and a write-only field. The field
 * starts empty every time, and no call this component makes ever returns
 * a kept value.
 */
function IntegrationKeys({
  integration,
  onSave,
}: {
  integration: IntegrationView;
  onSave: (slot: string, value: string | null) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const words = INTEGRATION_SECRET_WORDS;
  return (
    <div className="fm-integrations-keys" data-integration-keys={integration.id}>
      <div className="fm-integrations-keys-head">{words.heading}</div>
      <ul aria-label={`${integration.name} ${words.heading.toLowerCase()}`}>
        {(integration.secrets ?? []).map((slot) => {
          const draft = drafts[slot.name] ?? "";
          const save = () => {
            if (!draft.trim()) return;
            onSave(slot.name, draft);
            setDrafts((all) => ({ ...all, [slot.name]: "" }));
          };
          return (
            <li key={slot.name} data-integration-key={slot.name} data-kept={slot.kept}>
              <span className="fm-integrations-action-label">{slot.label}</span>
              <span className="fm-forges-state" data-tone={slot.kept ? undefined : "danger"}>
                {slot.kept ? words.kept : words.missing}
              </span>
              <form
                className="fm-integrations-key-entry"
                onSubmit={(event) => {
                  event.preventDefault();
                  save();
                }}
              >
                <Input
                  type="password"
                  mono
                  autoComplete="off"
                  aria-label={slot.label}
                  placeholder={words.placeholder}
                  value={draft}
                  onChange={(event) =>
                    setDrafts((all) => ({ ...all, [slot.name]: event.target.value }))
                  }
                />
                <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={save}>
                  {slot.kept ? words.replace : words.save}
                </Button>
                {slot.kept && (
                  <Button variant="ghost" size="sm" onClick={() => onSave(slot.name, null)}>
                    {words.remove}
                  </Button>
                )}
              </form>
            </li>
          );
        })}
      </ul>
      <p className="fm-integrations-keys-note">{words.stays}</p>
    </div>
  );
}

/**
 * The form that adds an MCP server: its name and what it runs. Connect
 * hands both to the core, which starts the server, reads its tools and
 * answers the new row - or says, in the status line, why it could not.
 */
function McpAddForm({
  onAdded,
  onCancel,
}: {
  onAdded: (id: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [runs, setRuns] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState("");
  const ids = useId();
  const ready = name.trim() !== "" && runs.trim() !== "";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || connecting) return;
    setConnecting(true);
    setProblem("");
    try {
      const { id } = await window.infinitary.integrations.addMcp({ name, runs });
      onAdded(id);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConnecting(false);
    }
  };
  return (
    <form
      className="fm-connect-aside fm-forges-aside"
      data-integration-mcp-form=""
      aria-label={INTEGRATIONS_MCP_WORDS.title}
      onSubmit={(event) => void submit(event)}
    >
      <div className="fm-forges-field">
        <label htmlFor={`${ids}-name`}>{INTEGRATIONS_MCP_WORDS.name}</label>
        <Input
          id={`${ids}-name`}
          value={name}
          placeholder={INTEGRATIONS_MCP_WORDS.namePlaceholder}
          autoComplete="off"
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="fm-forges-field">
        <label htmlFor={`${ids}-runs`}>{INTEGRATIONS_MCP_WORDS.runs}</label>
        <Input
          mono
          id={`${ids}-runs`}
          value={runs}
          placeholder={INTEGRATIONS_MCP_WORDS.runsPlaceholder}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${ids}-hint`}
          onChange={(event) => setRuns(event.target.value)}
        />
      </div>
      <div id={`${ids}-hint`} style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {INTEGRATIONS_MCP_WORDS.runsHint}
      </div>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-integration-mcp-problem=""
        style={{ display: "block", fontSize: "var(--text-sm)", color: "var(--danger)" }}
      >
        {problem}
      </span>
      <div className="fm-forges-aside-actions">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          pending={connecting}
          pendingLabel={INTEGRATIONS_MCP_WORDS.connecting}
          disabled={!ready}
        >
          {INTEGRATIONS_MCP_WORDS.connect}
        </Button>
        <Button variant="ghost" size="sm" disabled={connecting} onClick={onCancel}>
          {INTEGRATIONS_MCP_WORDS.cancel}
        </Button>
      </div>
    </form>
  );
}
