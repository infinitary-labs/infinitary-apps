import type { CustomApiView } from "@shared/customApi";
import { useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, useRestLabel } from "../design";
import "./customApi.css";
import * as m from "@shared/i18n/messages.generated";

/** First setup's last question: which checked model Firstmate answers with. */
export function FirstmateChoice({ view, onDone }: { view: CustomApiView; onDone: () => void }) {
  const [provider, setProvider] = useState("");
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    void window.infinitary.accounts
      .list()
      .then((accounts) =>
        setProvider(accounts.find((account) => account.id === view.accountId)?.providerId ?? ""),
      )
      .catch(() => setError(m.accountsCustomApiReadFailed()));
  }, [view.accountId]);
  return (
    <section className="fm-custom-api fm-custom-form" data-custom-api-form data-custom-choose>
      <h3>{m.accountsCustomApiReady({ name: view.label })}</h3>
      <p>{m.accountsCustomApiChooseQuestion()}</p>
      <div className="fm-custom-choices">
        {view.models
          .filter((model) => model.checked)
          .map((model) => (
            <Button
              key={model.id}
              variant="secondary"
              size="sm"
              disabled={!provider || choosing}
              onClick={() => {
                setChoosing(true);
                void window.infinitary.settings
                  .setFirstmateModel({ provider, id: model.id })
                  .then(() => {
                    void useShellStore.getState().loadFirstRun();
                    onDone();
                  })
                  .catch((caught: unknown) => {
                    setChoosing(false);
                    setError(
                      caught instanceof Error ? caught.message : m.accountsCustomApiChooseFailed(),
                    );
                  });
              }}
            >
              {m.accountsCustomApiUseModel({ model: model.id })}
            </Button>
          ))}
      </div>
      <p className="fm-custom-hint">{m.accountsCustomApiCrewUseSettings()}</p>
      {error && (
        <p role="alert" className="fm-custom-field-error">
          {error}
        </p>
      )}
      <div className="fm-custom-foot">
        <span />
        <Button variant="ghost" size="sm" onClick={onDone}>
          {m.accountsCustomApiChooseLater()}
        </Button>
      </div>
    </section>
  );
}

export type FirstmateModel = { provider: string; id: string } | null;

/**
 * A connection's model chosen to run the first mate. One that cannot run it
 * yet stays a stop of its own, marked off (`aria-disabled`) rather than
 * disabled, with its reason on rest, the pointer's or the keyboard's focus,
 * and as its description; choosing it does nothing (docs/keyboard.md, "Facts
 * shown on rest").
 */
export function FirstmateRadio({
  model,
  chosen,
  off,
  onChoose,
}: {
  model: string;
  chosen: boolean;
  /** Why it cannot be chosen yet; absent while it can. */
  off: string | undefined;
  onChoose: () => void;
}) {
  const rest = useRestLabel(off, { fact: true });
  return (
    <label className="fm-custom-choice">
      <input
        type="radio"
        name="custom-api-firstmate"
        aria-label={m.accountsCustomApiUseForFirstMate({ model })}
        aria-description={off}
        aria-disabled={off === undefined ? undefined : "true"}
        checked={chosen}
        {...rest}
        onClick={(event) => {
          if (off !== undefined) event.preventDefault();
        }}
        onChange={() => {
          if (off === undefined) onChoose();
        }}
      />
      {m.accountsCustomApiFirstMate()}
    </label>
  );
}
