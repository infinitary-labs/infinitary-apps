import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Outbox } from "@core/connection/outbox";
import type { Core } from "@core/index";
import { bringCardId } from "@core/secrets/bringCard";
import { SECRET_BRING_CARD_WORDS } from "@shared/secretBring";

/** The invented values the stand-in tools hold; none may reach the phone in any frame. */
const TOKEN = {
  name: "STAGING_TOKEN",
  as: "Staging token",
  value: "av_invented_phone_bring_token",
};
const DB = { name: "DB_PASSWORD", value: "av_invented_phone_bring_database" };
const KEPT_BEFORE = "av_invented_phone_bring_kept_before";
const READ = { name: "API_KEY", value: "env_invented_phone_bring_read" };
const MARKERS = [TOKEN.value, DB.value, KEPT_BEFORE, READ.value].flatMap((value) => [
  value,
  Buffer.from(value).toString("base64"),
]);

/**
 * INF-7282's approved plan, part 1 (the captain: "let's plan how to allow phone to approve this"): the computer's side
 * of the phone's bring part (ios/Infinitary/InfinitaryUITests/PhoneJourney+CardsSecretBring.swift). The home's task
 * asks the real SecretBrings to bring two names from a stand-in tool that prints invented values as `/usr/bin/env -0`
 * does, the second already kept so its row arrives unticked, and to read a .env file that names nothing until Read it.
 * Every frame the home writes to a phone passes a tap that counts the ones holding an invented value, as text or
 * base64; the part's completion is that count staying zero while Secrets keeps only what the phone ticked.
 */
export async function phoneSecretBringCommand(
  core: Core,
  task: string,
  root: string,
  route: string,
): Promise<unknown> {
  const read = ROUTES[route];
  if (!read) return undefined;
  // Made on the part's first bring request, before any bring, so the tap sees every frame a value could be in.
  const controls = homes.get(core) ?? phoneSecretBringControls(core, task, root);
  homes.set(core, controls);
  return controls[read]();
}

const ROUTES: Record<string, "bring" | "read" | "state"> = {
  "POST secrets-bring": "bring",
  "POST secrets-bring-read": "read",
  "GET secrets-bring-state": "state",
};
const homes = new WeakMap<Core, ReturnType<typeof phoneSecretBringControls>>();

function phoneSecretBringControls(core: Core, task: string, root: string) {
  let framesWithValue = 0;
  const send = Outbox.prototype.send;
  // Counted where a whole frame is still one string: the socket below sees it in pieces a value could straddle.
  Outbox.prototype.send = function (this: Outbox, text: string, done?: (error?: Error) => void) {
    if (MARKERS.some((marker) => text.includes(marker))) framesWithValue += 1;
    return send.call(this, text, done);
  };
  const folder = join(root, "bring-project");
  const brings = () => core.services.secretBrings.commandFor(task);
  const cards = async () =>
    (await core.dispatch("inf:cards:list", [])).filter((card) =>
      card.id.startsWith(bringCardId(task, "")),
    );
  /** The ids of the buttons the phone names its choices by: Bring into Secrets or Read it, and Don't bring. */
  const buttons = async (id: string) => {
    const card = (await cards()).find((one) => one.id === bringCardId(task, id));
    return {
      go: card?.actions.find((action) => !action.declines)?.id ?? null,
      dontBring: card?.actions.find((action) => action.declines)?.id ?? null,
    };
  };
  return {
    /** A bring of two names from the stand-in tool; Secrets keeps the second already. */
    async bring() {
      mkdirSync(folder, { recursive: true });
      const project = realpathSync(folder);
      const tool = join(project, "av");
      writeFileSync(
        tool,
        `#!/bin/sh\nprintf 'PATH=/usr/bin\\0${TOKEN.name}=${TOKEN.value}\\0${DB.name}=${DB.value}\\0'\n`,
      );
      chmodSync(tool, 0o755);
      // As the captain kept it in Settings → Secrets earlier.
      await core.services.secrets.put({
        label: DB.name,
        environment: "",
        value: KEPT_BEFORE,
        expectedVersion: 0,
        expectedRevision: null,
      });
      const started = await brings().bring(
        {
          id: "phone-bring",
          reason: "Move the staging keys out of Automic Vault",
          from: {
            tool: "Automic Vault",
            source: { run: [tool, "inject", "staging"], folder: project },
            reads: "env0",
            secrets: [{ name: TOKEN.name, as: TOKEN.as, place: "Staging" }, { name: DB.name }],
          },
        },
        project,
      );
      return {
        state: started.state,
        title: SECRET_BRING_CARD_WORDS.title(2, "Automic Vault"),
        // Shown only to a view that draws no tick rows; the phone draws them now.
        elsewhere: SECRET_BRING_CARD_WORDS.elsewhere,
        ...(await buttons("phone-bring")),
      };
    },
    /** A .env file read first: its card offers Read it, then the names it found. */
    async read() {
      mkdirSync(folder, { recursive: true });
      const env = join(realpathSync(folder), ".env");
      writeFileSync(env, `${READ.name}=${READ.value}\n`);
      const started = await brings().bring({
        id: "phone-read",
        reason: "Keep the project's .env keys in Secrets",
        from: { tool: ".env file", source: { file: env }, reads: "lines" },
      });
      return {
        state: started.state,
        title: SECRET_BRING_CARD_WORDS.title(null, ".env file"),
        found: SECRET_BRING_CARD_WORDS.title(1, ".env file"),
        dontBringLabel: SECRET_BRING_CARD_WORDS.dontBring,
        ...(await buttons("phone-read")),
      };
    },
    /** How each bring stands, what Secrets keeps (names, places and versions), the open bring cards, and the tap. */
    async state() {
      const view = await core.services.secrets.view();
      const status = async (id: string) => (await brings().bringStatus(id)) ?? null;
      return {
        bring: await status("phone-bring"),
        read: await status("phone-read"),
        entries: view.entries
          .map(({ label, environment, version }) => ({
            label,
            environment: environment ?? "",
            version,
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        cards: (await cards()).map(({ title }) => title),
        framesWithValue,
      };
    },
  };
}
