import { FORGE_SECTION_WORDS, type ForgesView } from "@shared/forges";
import {
  INTEGRATION_EFFECT_WORDS,
  INTEGRATION_RULE_WORDS,
  INTEGRATIONS_SIGN_IN_HOST,
  INTEGRATIONS_WORDS,
  type IntegrationSettingsPatch,
  type IntegrationsView,
  type IntegrationView,
} from "@shared/integrations";
import { useCallback, useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Badge, Button, RowMenu, StatusDot, Switch } from "../design";
import "./integrations.css";
import { forgeRowView, HostChip, SignInAside } from "./ForgeSection";
import { LABEL_GAP, ROW_GAP, SettingError } from "./settingRows";
import "../accounts/connectChips.css";
import "./forges.css";

/**
 * Settings -> Integrations (docs/integrations.md; design skill
 * `components/integrations/IntegrationRow`): what the first mate and the
 * crew reach outside the person's projects, one row per connection signed
 * in as the person. A row's chevron opens its actions, each with what it
 * does and its rule, and a switch that turns it off; its menu checks the
 * sign-in now, pauses it, or signs out and removes it. The chips at the
 * foot connect a kind not yet connected.
 *
 * GitHub is the first kind, and its sign-in is the forge's device flow
 * (`docs/forge.md`): this tab starts it, shows the code, and follows the
 * `inf:forges` push for how it ends, as Settings -> Projects did before the
 * sign-in moved here (INF-775, the captain's q2). Every change here goes
 * through the same channels the first mate's `app_change` lines reach.
 */

const EMPTY: IntegrationsView = { integrations: [], addable: [] };
const NO_FORGES: ForgesView = { signIns: [], hosts: [], flow: null, ended: null };

export function IntegrationsTab() {
  const [view, setView] = useState<IntegrationsView>(EMPTY);
  const [forges, setForges] = useState<ForgesView>(NO_FORGES);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useShellStore((s) => s.pendingForgeSignIn);

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

  const signIn = useCallback(() => {
    setError(null);
    setStarting(true);
    void window.infinitary.forges
      .signIn(INTEGRATIONS_SIGN_IN_HOST)
      .catch(() => undefined)
      .finally(() => setStarting(false));
  }, []);

  // A card's "Sign in to GitHub" lands here with the sign-in to start, so
  // the code is on screen when the tab opens.
  useEffect(() => {
    if (pending !== INTEGRATIONS_SIGN_IN_HOST || !loaded) return;
    useShellStore.getState().clearPendingForgeSignIn();
    signIn();
  }, [pending, loaded, signIn]);

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
        {loaded && view.integrations.length === 0 && (
          <div className="fm-forges-quiet" data-integrations-quiet="">
            {INTEGRATIONS_WORDS.quiet}
          </div>
        )}
        {view.integrations.map((integration) => (
          <div key={integration.id}>
            <IntegrationRow
              integration={integration}
              open={open === integration.id}
              busy={starting}
              onToggle={() =>
                setOpen((current) => (current === integration.id ? null : integration.id))
              }
              onSignIn={signIn}
              onCheck={() => change(() => window.infinitary.integrations.check(integration.id))}
              onPause={(paused) => configure(integration.id, { paused })}
              onRemove={() => change(() => window.infinitary.integrations.remove(integration.id))}
            />
            {open === integration.id && (
              <IntegrationActions
                integration={integration}
                onAction={(name, enabled) =>
                  configure(integration.id, { actions: { [name]: enabled } })
                }
              />
            )}
            {integration.kind === "github" && aside}
          </div>
        ))}
        {view.addable.length > 0 && (
          <div className="fm-forges-add">
            <div className="fm-connect-chips" data-connect-chips="foot">
              {view.addable.map((kind) => (
                <span
                  key={kind.kind}
                  data-integration-add={kind.kind}
                  style={{ display: "contents" }}
                >
                  <HostChip
                    host={{ host: INTEGRATIONS_SIGN_IN_HOST, name: kind.name }}
                    busy={starting || forges.flow?.host === INTEGRATIONS_SIGN_IN_HOST}
                    onConnect={signIn}
                  />
                </span>
              ))}
            </div>
            {!github && aside}
          </div>
        )}
      </div>
    </section>
  );
}

/** "as octo · 2 actions"; a paused one says so first. */
export function integrationRowSub(integration: IntegrationView): string {
  const on = integration.actions.filter((action) => action.enabled).length;
  const actions = on === 1 ? "1 action" : `${on} actions`;
  const who = integration.account ? `as ${integration.account}` : null;
  return [integration.paused ? "paused" : null, who, actions].filter(Boolean).join(" · ");
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
  const row = forgeRowView({ name: integration.name, state: integration.health });
  return (
    <div
      className="fm-forges-row"
      data-integration-row={integration.id}
      data-integration-state={integration.health}
      // GitHub's row is the github.com sign-in's own row, marked as the forge rows are.
      {...(integration.kind === "github"
        ? { "data-forge-row": INTEGRATIONS_SIGN_IN_HOST, "data-forge-state": integration.health }
        : {})}
    >
      <span className="fm-forges-dot">
        <StatusDot
          tone={integration.paused ? "idle" : row.tone}
          label={integration.paused ? "paused" : row.label}
          nativeTitle={row.label !== "signed in" && row.label !== "sign in again"}
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
        {row.reauth ? (
          <span className="fm-forges-state" data-tone="danger">
            {FORGE_SECTION_WORDS.reauth}
          </span>
        ) : integration.paused ? (
          <Badge tone="outline">paused</Badge>
        ) : (
          <Badge tone="ok">signed in</Badge>
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
            { id: "remove", label: "Sign out and remove", tone: "danger", onSelect: onRemove },
          ]}
        />
      </span>
    </div>
  );
}

/** An open row's actions: what each does, its rule, and its switch. */
function IntegrationActions({
  integration,
  onAction,
}: {
  integration: IntegrationView;
  onAction: (name: string, enabled: boolean) => void;
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
          <span className="fm-forges-state" data-integration-rule={action.rule}>
            {INTEGRATION_RULE_WORDS[action.rule]}
          </span>
          <Switch
            checked={action.enabled}
            aria-label={`${action.label} on`}
            onChange={(enabled) => onAction(action.name, enabled)}
          />
        </li>
      ))}
    </ul>
  );
}
