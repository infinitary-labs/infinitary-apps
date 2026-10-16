import { hostOfAddress } from "@shared/forge";
import {
  FORGE_BROWSER_WORDS,
  FORGE_SECTION_WORDS,
  type ForgeServerView,
  forgeAddressExample,
  forgeApplicationsPage,
  forgeBrowserRedirect,
} from "@shared/forges";
import { type FormEvent, useId, useState } from "react";
import { Button, Input } from "../design";

/** One public application per GitLab host; reuse the shared code aside once it starts. */
export function ForgeBrowserAside({
  address: initialAddress,
  applicationId: savedApplicationId,
  server,
  onDone,
  onKey,
  onCancel,
}: {
  address: string;
  applicationId?: string | undefined;
  server: ForgeServerView;
  onDone: () => void;
  onKey: (address: string) => void;
  onCancel: () => void;
}) {
  const [address, setAddress] = useState(initialAddress);
  const [applicationId, setApplicationId] = useState(savedApplicationId ?? "");
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState("");
  const ids = useId();
  const host = hostOfAddress(address);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!host || !applicationId.trim() || checking) return;
    setChecking(true);
    setProblem("");
    try {
      await window.infinitary.forges.signInWithBrowser({
        kind: server.kind,
        address,
        applicationId: applicationId.trim(),
      });
      onDone();
    } catch {
      setProblem(FORGE_BROWSER_WORDS.failed);
    } finally {
      setChecking(false);
    }
  };
  return (
    <form
      className="fm-connect-aside fm-forges-aside"
      data-forge-browser-form=""
      aria-label={`Browser sign-in to ${host ?? server.name}`}
      onSubmit={(event) => void submit(event)}
    >
      <div className="fm-forges-browser-intro">
        Sign in on {host ?? server.name} in your browser. Your sign-in stays on this computer.
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
            setProblem("");
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
            Open applications on {host ?? server.name} and choose <code>Add new application</code>.
          </li>
          <li>
            Name it <code>Infinitary</code>. Set <code>Redirect URI</code> to{" "}
            <code>{host ? forgeBrowserRedirect(host) : "your server’s /oauth/device page"}</code>.
            This code sign-in does not use a redirect.
          </li>
          <li>
            Turn off <code>Confidential</code> and select <code>api</code> and{" "}
            <code>write_repository</code>. These allow Infinitary to read your projects, push and
            merge changes.
          </li>
          <li>
            Save the application and paste its <code>Application ID</code> below, not its{" "}
            <code>Secret</code>.
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
          Open applications on {host ?? server.name}
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
          pendingLabel="Starting..."
          disabled={!host || !applicationId.trim()}
        >
          {FORGE_BROWSER_WORDS.start}
        </Button>
        <Button variant="secondary" size="sm" disabled={checking} onClick={() => onKey(address)}>
          {FORGE_BROWSER_WORDS.useKey}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
