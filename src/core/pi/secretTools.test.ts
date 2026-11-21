import type { Card } from "@shared/cards";
import { SECRET_ASK_CARD_WORDS } from "@shared/secrets";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ProtectedSecrets } from "../secrets/protected";
import { SecretsSettings } from "../secrets/settings";
import { createSecretTools } from "./secretTools";

// Intent: INF-4239, direction A, for the first mate: it asks by name, place
// and reason through its own tool; the ask raises Infinitary's card, which the
// turn counts as its answer, and an ask that names no secret is refused in
// words it can act on. INF-5516 with the captain's write-in: the first mate
// may lay out how to get it, and a how-to the card cannot take is refused in
// words saying why, with nothing asked. The Secrets controller is real, over
// disposable custody.
function tool() {
  const custody = disposableCustody();
  const dir = scratchDir("secret-tool-");
  const cards: Omit<Card, "author" | "priority" | "status" | "createdAt">[] = [];
  const settings = new SecretsSettings({
    open: (initialize) =>
      ProtectedSecrets.open({
        dir,
        custody,
        initialize,
        environment: () => ({}),
        now: () => 1000,
        authentication: { available: async () => true, confirm: async () => true },
      }),
    raise: (card) => {
      cards.push(card);
    },
    withdraw: () => {},
    changed: () => {},
  });
  const raised: string[] = [];
  const [ask] = createSecretTools(
    {
      ask: (input) => settings.askToKeep(null, input),
      cancel: (id) => settings.cancelAsk(null, id),
    },
    (id) => raised.push(id),
  );
  if (!ask) throw new Error("No ask tool.");
  return { ask, cards, raised };
}

describe("the first mate's ask_secret", () => {
  it("raises Infinitary's card for the first mate and counts it as the turn's answer", async () => {
    const t = tool();
    const out = await t.ask.run({
      id: "stripe",
      reason: "The checkout task needs the test key",
      secrets: [{ name: "Stripe test key", place: "Test" }],
    });
    expect(JSON.parse(out.text)).toEqual({ ask: "stripe", state: "waiting" });
    expect(t.raised).toEqual(["stripe"]);
    expect(t.cards.at(-1)?.title).toBe(SECRET_ASK_CARD_WORDS.title(["Stripe test key"], false));
    expect(t.cards.at(-1)?.body).toContain(SECRET_ASK_CARD_WORDS.asked(null));
    expect(t.cards.at(-1)?.taskId).toBeUndefined();
    expect(JSON.parse((await t.ask.run({ id: "stripe", cancel: true })).text)).toEqual({
      ask: "stripe",
      cancelled: true,
    });
  });

  it("refuses an ask with no secret in words naming what it needs", async () => {
    const t = tool();
    const out = await t.ask.run({ id: "empty", reason: "Needs a key", secrets: [] });
    expect(out.text).toMatch(/^Refused: /);
    expect(t.cards).toEqual([]);
    expect(t.raised).toEqual([]);
  });

  it("draws the first mate's how-to under its words, and refuses one holding a script", async () => {
    const t = tool();
    const secrets = [{ name: "Bitbucket API token" }];
    const how =
      '<ol><li>Open <a href="https://bitbucket.org/account/settings/api-tokens/">bitbucket.org/account/settings/api-tokens</a>.</li><li>Tick <code>read:repository:bitbucket</code>.</li></ol>';
    const refused = await t.ask.run({
      id: "bad",
      reason: "Review pull requests",
      secrets,
      how: `${how}<script>alert(1)</script>`,
    });
    expect(refused.text).toMatch(/^Refused: /);
    expect(refused.text).toContain("<script>");
    expect(t.cards).toEqual([]);
    const out = await t.ask.run({ id: "bitbucket", reason: "Review pull requests", secrets, how });
    expect(JSON.parse(out.text)).toEqual({ ask: "bitbucket", state: "waiting" });
    const body = t.cards.at(-1)?.body ?? "";
    expect(body).toContain(SECRET_ASK_CARD_WORDS.how(false));
    expect(body).toContain(SECRET_ASK_CARD_WORDS.by(null));
    expect(body).toContain("<code>read:repository:bitbucket</code>");
  });
});
