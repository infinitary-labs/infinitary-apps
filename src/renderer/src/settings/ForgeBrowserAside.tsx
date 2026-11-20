import { hereAs } from "@shared/deviceNames";
import { hostOfAddress } from "@shared/forge";
import {
  FORGE_BROWSER_WORDS,
  FORGE_SECTION_WORDS,
  type ForgeBrowserSignIn,
  type ForgeServerView,
  type ForgesView,
  forgeAddressExample,
  forgeApplicationsPage,
  forgeBrowserRedirect,
  forgeStartProblemText,
} from "@shared/forges";
import * as m from "@shared/i18n/messages.generated";
import { type FormEvent, Fragment, type ReactNode, useId, useState } from "react";
import { Button, Input } from "../design";
import { useHereAs } from "../devices/useFirstMatePlace";

/** One public application per GitLab host; reuse the shared code aside once it starts. */
export function ForgeBrowserAside({
  address: initialAddress,
  applicationId: savedApplicationId,
  server,
  ended,
  onDone,
  onKey,
  onCancel,
  computer,
}: {
  address: string;
  applicationId?: string | undefined;
  server: ForgeServerView;
  /** How the last sign-in ended; a failed start names the host's reason. */
  ended: ForgesView["ended"];
  onDone: () => void;
  onKey: (address: string) => void;
  onCancel: () => void;
  /**
   * A computer that runs work the sign-in runs on and is kept on instead of
   * this one: its name in the words, and its own order to start the code.
   */
  computer?: { who: string; start: (input: ForgeBrowserSignIn) => Promise<unknown> };
}) {
  const [address, setAddress] = useState(initialAddress);
  const [applicationId, setApplicationId] = useState(savedApplicationId ?? "");
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const ids = useId();
  const hereAsThis = useHereAs();
  const here = computer ? (text: string) => hereAs(text, computer.who) : hereAsThis;
  const host = hostOfAddress(address);
  // The reason rides the view's push, which may land just before or after the refusal.
  const problem = !failed
    ? ""
    : host && ended?.host === host && ended.end === "failed"
      ? forgeStartProblemText(ended.problem, host)
      : FORGE_BROWSER_WORDS.failed;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!host || !applicationId.trim() || checking) return;
    setChecking(true);
    setFailed(false);
    try {
      const input = { kind: server.kind, address, applicationId: applicationId.trim() };
      await (computer ? computer.start(input) : window.infinitary.forges.signInWithBrowser(input));
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  };
  return (
    <form
      className="fm-connect-aside fm-forges-aside"
      data-forge-browser-form=""
      aria-label={m.settingsForgeBrowserLabel({ host: host ?? server.name })}
      onSubmit={(event) => void submit(event)}
    >
      <div className="fm-forges-browser-intro">
        {m.settingsForgeBrowserIntro({ host: host ?? server.name })}{" "}
        {here(m.settingsForgeBrowserStays())}
      </div>
      <div className="fm-forges-field">
        <label htmlFor={`${ids}-address`}>{FORGE_SECTION_WORDS.address}</label>
        <Input
          mono
          id={`${ids}-address`}
          value={address}
          placeholder={forgeAddressExample(server.kind)}
          autoComplete="off"
          spellCheck={false}
          autoFocus={!initialAddress}
          disabled={checking}
          onChange={(event) => {
            if (hostOfAddress(event.target.value) !== host) setApplicationId("");
            setAddress(event.target.value);
            setFailed(false);
          }}
        />
      </div>
      <details
        className="fm-forges-registration"
        open={!savedApplicationId || host !== hostOfAddress(initialAddress) || undefined}
      >
        <summary>{FORGE_BROWSER_WORDS.register}</summary>
        <ol>
          <li>
            {withCode(m.settingsForgeBrowserStepOpen, {
              host: host ?? server.name,
              // GitLab's own button, in the words GitLab shows in that language.
              add: <code>{m.settingsForgeBrowserGitlabAdd()}</code>,
            })}
          </li>
          <li>
            {withCode(m.settingsForgeBrowserStepName, {
              // i18n-exempt: the application's name, a product name
              name: <code>Infinitary</code>,
              field: <code>{m.settingsForgeBrowserGitlabRedirect()}</code>,
              redirect: (
                <code>
                  {host ? forgeBrowserRedirect(host) : m.settingsForgeBrowserRedirectFallback()}
                </code>
              ),
            })}
          </li>
          <li>
            {withCode(m.settingsForgeBrowserStepScopes, {
              confidential: <code>{m.settingsForgeBrowserGitlabConfidential()}</code>,
              // i18n-exempt: GitLab's scope names, as GitLab names them
              api: <code>api</code>,
              // i18n-exempt: GitLab's scope names, as GitLab names them
              write: <code>write_repository</code>,
            })}
          </li>
          <li>
            {withCode(m.settingsForgeBrowserStepGrant, {
              grant: <code>{FORGE_BROWSER_WORDS.deviceGrant}</code>,
            })}
          </li>
          <li>
            {withCode(m.settingsForgeBrowserStepSave, {
              id: <code>{m.settingsForgeBrowserGitlabApplicationId()}</code>,
              secret: <code>{m.settingsForgeBrowserGitlabSecret()}</code>,
            })}
          </li>
        </ol>
        <Button
          variant="secondary"
          size="sm"
          disabled={!host || checking}
          onClick={() =>
            host && void window.infinitary.app.openExternal(forgeApplicationsPage(host))
          }
        >
          {m.settingsForgeBrowserOpenApplications({ host: host ?? server.name })}
        </Button>
      </details>
      <div className="fm-forges-field">
        <label htmlFor={`${ids}-application`}>{FORGE_BROWSER_WORDS.applicationId}</label>
        <Input
          mono
          id={`${ids}-application`}
          value={applicationId}
          autoComplete="off"
          spellCheck={false}
          autoFocus={!!initialAddress}
          disabled={checking}
          onChange={(event) => setApplicationId(event.target.value)}
        />
      </div>
      <div className="fm-forges-browser-help">{FORGE_BROWSER_WORDS.requires}</div>
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="fm-forges-browser-problem"
      >
        {problem}
      </span>
      <div className="fm-forges-aside-actions">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          pending={checking}
          pendingLabel={m.settingsForgeStarting()}
          disabled={!host || !applicationId.trim()}
        >
          {FORGE_BROWSER_WORDS.start}
        </Button>
        <Button variant="secondary" size="sm" disabled={checking} onClick={() => onKey(address)}>
          {FORGE_BROWSER_WORDS.useKey}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {m.settingsForgeCancel()}
        </Button>
      </div>
    </form>
  );
}

/**
 * A message whose blanks are drawn as parts of their own, such as code: each
 * blank is filled with a marker, and the worded text is split around them.
 */
function withCode<K extends string>(
  word: (fills: Record<K, string>) => string,
  parts: Record<K, ReactNode>,
): ReactNode[] {
  const keys = Object.keys(parts) as K[];
  const marks = Object.fromEntries(keys.map((key) => [key, `\u0000${key}\u0000`])) as Record<
    K,
    string
  >;
  return word(marks)
    .split("\u0000")
    .map((piece, index) =>
      index % 2 === 1 ? <Fragment key={piece}>{parts[piece as K]}</Fragment> : piece,
    );
}
