import { formatDate } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import {
  GOOGLE_CLIENT_SETUP_PAGE,
  type IntegrationClientView,
  type IntegrationsView,
} from "@shared/integrations";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Button, SecretField, type SecretFieldHandle } from "../design";
import { useFileDrop } from "../design/core/FileControls";
import { messageOf } from "./automationParts";

/**
 * Setting up the person's own Google client (docs/integrations.md,
 * "Google"; design skill `components/integrations/IntegrationRow`): Google's Personal mode page opens in the browser, where the person makes
 * a Desktop app client, and the file Google gives for it is dropped, chosen
 * or pasted here. The file goes to the home whole, which keeps its secret
 * in Secrets and answers only whether a client is kept; the field clears
 * either way. Kept, the row goes on to Google's notice and sign-in.
 */
export function GoogleClientSetup({
  refused,
  onKept,
  onCancel,
}: {
  /** Google refused the client kept now: the setup says so first. */
  refused: boolean;
  onKept: (view: IntegrationsView) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const box = useRef<HTMLElement>(null);
  const field = useRef<SecretFieldHandle>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    box.current?.focus();
  }, []);

  const take = async (file: File | undefined) => {
    if (!file) return;
    setProblem("");
    // Google's client file is a few hundred bytes; a large file is not one, and is never read.
    if (file.size > 16 * 1024) {
      setProblem(m.integrationsGoogleClientFileNotJson());
      return;
    }
    const text = await file.text();
    if (field.current) field.current.value = text;
    setFilled(text.trim().length > 0);
    setChosen(file.name);
  };
  const drop = useFileDrop({
    onFiles: (files) => void take(files[0]),
    onPick: () => picker.current?.click(),
    pending: [],
    onCancel: () => {},
    status: chosen ? m.integrationsGoogleSetupChosen({ name: chosen }) : "",
    enabled: !keeping,
  });

  const keep = async (event: FormEvent) => {
    event.preventDefault();
    const file = field.current?.value ?? "";
    if (!file.trim() || keeping) return;
    setKeeping(true);
    setProblem("");
    try {
      const view = await window.infinitary.integrations.keepClient("google", file);
      onKept(view);
    } catch (caught) {
      setProblem(messageOf(caught));
    } finally {
      if (field.current) field.current.value = "";
      setFilled(false);
      setChosen(null);
      setKeeping(false);
    }
  };

  return (
    <div className="fm-connect-aside fm-forges-aside">
      <form
        ref={(node) => {
          box.current = node;
        }}
        tabIndex={-1}
        className="fm-integrations-notice"
        data-integration-setup="google"
        aria-labelledby={`${ids}-title`}
        onSubmit={(event) => void keep(event)}
      >
        <div id={`${ids}-title`} className="fm-integrations-notice-title">
          {m.integrationsGoogleSetupTitle()}
        </div>
        {refused && (
          <p className="fm-integrations-notice-lead" data-integration-setup-refused="">
            {m.integrationsGoogleStoppedDetail()}
          </p>
        )}
        <p className="fm-integrations-notice-lead">{m.integrationsGoogleSetupLead()}</p>
        <ol className="fm-integrations-setup-steps">
          <li>
            <p>{m.integrationsGoogleSetupStepPage()}</p>
            <div className="fm-forges-aside-actions">
              <Button
                variant="secondary"
                size="sm"
                data-integration-setup-page=""
                onClick={() => void window.infinitary.app.openExternal(GOOGLE_CLIENT_SETUP_PAGE)}
              >
                {m.integrationsGoogleSetupOpenPage()}
              </Button>
            </div>
          </li>
          <li>
            <p>{m.integrationsGoogleSetupStepFile()}</p>
            <div
              className="fm-integrations-setup-drop"
              data-integration-setup-drop=""
              data-over={drop.over ? "" : undefined}
              {...drop.handlers}
            >
              <span className="fm-integrations-setup-drop-words">
                {m.integrationsGoogleSetupDrop()}
              </span>
              <div className="fm-forges-field">
                <label htmlFor={`${ids}-file`}>{m.integrationsGoogleSetupField()}</label>
                <SecretField
                  id={`${ids}-file`}
                  handle={field}
                  mono
                  disabled={keeping}
                  onValue={(value) => {
                    setFilled(value.trim().length > 0);
                    setChosen(null);
                  }}
                />
              </div>
              <div className="fm-forges-aside-actions">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={keeping}
                  onClick={() => picker.current?.click()}
                >
                  {m.integrationsGoogleSetupChoose()}
                </Button>
                <input
                  ref={picker}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  tabIndex={-1}
                  onChange={(event) => {
                    void take(event.currentTarget.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
            </div>
          </li>
        </ol>
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-integration-setup-status=""
          className="fm-integrations-notice-closing fm-integrations-setup-status"
        >
          {chosen ? m.integrationsGoogleSetupChosen({ name: chosen }) : ""}
        </span>
        <span
          role="alert"
          data-integration-setup-problem=""
          className="fm-integrations-setup-problem"
        >
          {problem}
        </span>
        <p className="fm-integrations-notice-closing">{m.integrationsGoogleSetupStays()}</p>
        <div className="fm-forges-aside-actions">
          <Button
            type="submit"
            variant="primary"
            size="sm"
            pending={keeping}
            pendingLabel={m.integrationsGoogleSetupKeeping()}
            disabled={!filled}
          >
            {m.integrationsGoogleSetupKeep()}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {m.integrationsSignInCancel()}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** What the Google row says of its client, and its one next step, when that outranks its health. */
export type GoogleClientState = {
  /** The row's short state words, in place of its health's. */
  words: string;
  tone: "danger" | "warn";
  /** The line under the row that says why and what to do. */
  detail: string;
  /** The one next step: set the client up (again), or sign in with the one kept. */
  next: "set-up" | "set-up-again" | "sign-in";
};

/**
 * The Google row's state from its client facts (the seven states of INF-5549's
 * plan): a refused client first, then a refused sign-in as every row shows
 * it, then a sign-in on Infinitary's retiring client, then one that ends.
 * Undefined, the row shows its health as any sign-in row does.
 */
export function googleClientState(
  client: IntegrationClientView | undefined,
  health: string,
): GoogleClientState | undefined {
  if (!client) return undefined;
  if (client.refused)
    return {
      words: m.integrationsGoogleStopped(),
      tone: "danger",
      detail: m.integrationsGoogleStoppedDetail(),
      next: "set-up-again",
    };
  if (health === "needs_reauth") return undefined;
  if (client.retiring)
    return client.kept
      ? {
          words: m.integrationsGoogleRetiring(),
          tone: "warn",
          detail: m.integrationsGoogleReadyDetail(),
          next: "sign-in",
        }
      : {
          words: m.integrationsGoogleRetiring(),
          tone: "warn",
          detail: m.integrationsGoogleRetiringDetail(),
          next: "set-up",
        };
  if (client.endsAt !== undefined) {
    const date = formatDate(client.endsAt, { dateStyle: "medium" });
    return {
      words: m.integrationsGoogleStops({ date }),
      tone: "warn",
      detail: m.integrationsGoogleStopsDetail({ date }),
      next: "set-up-again",
    };
  }
  return undefined;
}

/** The words of a state's next step. */
export function googleNextWords(next: GoogleClientState["next"]): string {
  return next === "sign-in"
    ? m.integrationsGoogleSignIn()
    : next === "set-up"
      ? m.integrationsGoogleSetUp()
      : m.integrationsGoogleSetUpAgain();
}
