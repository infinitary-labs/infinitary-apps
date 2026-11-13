import { ProtectedSecrets } from "../../src/core/secrets/protected";
import { SecretsSettings } from "../../src/core/secrets/settings";
import type { Card } from "../../src/shared/cards";
import { SECRETS_WORDS } from "../../src/shared/secrets";
import { type DisposableCustody, disposableCustody } from "./disposableCustody";
import { scratchDir } from "./scratchDirs";

type Raised = Omit<Card, "author" | "priority" | "status" | "createdAt">;

/**
 * Secrets for an integration's tests (docs/integrations.md, "Keys"): the
 * real controller, protected owner, saved decisions and journal over
 * disposable custody, with the person's system confirmation answered by a
 * switch. `answer` is the choice pressed on each exact-use card as it is
 * raised - Always allow this unless a test says otherwise - and undefined
 * leaves every card waiting for the test's own press.
 */
export function integrationKeys(options: { answer?: string | undefined } = {}) {
  const custody: DisposableCustody = disposableCustody();
  const dir = scratchDir("integration-keys-");
  const cards: Raised[] = [];
  let confirms = 0;
  let answer = "answer" in options ? options.answer : SECRETS_WORDS.always;
  let owner: ProtectedSecrets | undefined;
  const press = async (label: string, card: Raised | undefined = cards.at(-1)) => {
    const effect = card?.actions.find((action) => action.label === label)?.effect;
    if (effect?.kind !== "host" || effect.op !== "secrets-decision" || !effect.arg)
      throw new Error(`No Secrets choice labelled ${label}.`);
    await settings.decide(effect.arg);
  };
  const settings: SecretsSettings = new SecretsSettings({
    open: async (initialize) => {
      owner = await ProtectedSecrets.open({
        dir,
        custody,
        initialize,
        environment: () => ({}),
        authentication: {
          available: async () => true,
          confirm: async () => {
            confirms += 1;
            return true;
          },
        },
      });
      return owner;
    },
    raise: (card) => {
      cards.push(card);
      const label = answer;
      if (label && card.actions.some((action) => action.label === label))
        queueMicrotask(() => void press(label, card));
    },
    withdraw: () => {},
    changed: () => {},
  });
  return {
    keys: settings,
    custody,
    dir,
    cards,
    press,
    confirms: () => confirms,
    answer: (label: string | undefined) => {
      answer = label;
    },
    /** Every kept entry's metadata, the crew's hidden ones included; never a value. */
    entries: async () => {
      await settings.view();
      return owner ? owner.metadata() : [];
    },
  };
}
