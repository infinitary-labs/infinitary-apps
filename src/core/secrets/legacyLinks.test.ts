import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Card } from "@shared/cards";
import { SECRETS_RECOVERY_WORDS, SECRETS_WORDS } from "@shared/secrets";
import { describe, expect, it } from "vitest";
import legacy from "../../../tests/fixtures/secrets-legacy-links/home.json";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { SecretBroker } from "./brokers";
import { canonical, sha256 } from "./custody";
import { ProtectedSecrets } from "./protected";
import { openRecovery, type RecoveryFiles } from "./recoveryArchive";
import { SecretsSettings } from "./settings";

// Intent: the captain on INF-1109, "remove the discovery link concept
// altogether. it should just be global discovery", with its spec's limit: a
// home an earlier version sealed with project/computer links stays readable
// without rewriting its authenticated bytes, its links are ignored once the
// record authenticates, and recovery reads an earlier archive but writes only
// the new shape. The fixture is a real home and archive that earlier version
// wrote; custody and the person's confirmation are the disposable stand-ins.
const STAGING = "invented-staging-deploy-token";
const CALENDAR = "invented-planning-calendar-token";
const OBSOLETE = ["website", "mac-mini", "infinitary", "links"];

async function fixture() {
  const dir = scratchDir("secrets-legacy-links-");
  for (const [path, bytes] of Object.entries(legacy.home)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), Buffer.from(bytes, "base64"));
  }
  const custody = disposableCustody();
  for (const [slot, bytes] of Object.entries(legacy.custody))
    custody.slots.set(slot as "root" | "authority-head", Buffer.from(bytes, "base64"));
  const cards: Omit<Card, "author" | "priority" | "status" | "createdAt">[] = [];
  const delivered: string[] = [];
  const saved: RecoveryFiles[] = [];
  let restore: RecoveryFiles | undefined;
  const settings = new SecretsSettings({
    open: (initialize) =>
      ProtectedSecrets.open({
        dir,
        custody,
        initialize,
        environment: () => ({}),
        now: () => 1792900000000,
        authentication: { available: async () => true, confirm: async () => true },
      }),
    recovery: {
      chooseSave: async () => async (files) => {
        saved.push({ archive: Buffer.from(files.archive), key: Buffer.from(files.key) });
        return "saved";
      },
      chooseRestore: async () =>
        restore && { archive: Buffer.from(restore.archive), key: Buffer.from(restore.key) },
    },
    raise: (card) => {
      cards.push(card);
    },
    withdraw: () => {},
    changed: () => {},
    now: () => 1792900000000,
  });
  const broker: SecretBroker = {
    id: "deploy-check",
    prepare: async (input) => ({
      facts: {
        broker: "deploy-check",
        label: "Staging deploy check",
        destination: "https://deploy.example.test/status",
        operation: "Read the staging deployment status",
        inputDigest: sha256(canonical(input)),
        read: true,
        result: "Trusted consumer",
        secrets: { bearer: "staging-deploy" },
      },
      run: async (values) => {
        delivered.push(values.bearer?.toString() ?? "");
        return { completed: true };
      },
    }),
  };
  settings.registerBroker(broker);
  const allow = async () => {
    const action = cards.at(-1)?.actions.find((one) => one.label === SECRETS_WORDS.once);
    if (action?.effect?.kind !== "host" || !action.effect.arg) throw new Error("No Allow once.");
    await settings.decide(action.effect.arg);
  };
  const records = async (under = join(dir, "values")) => {
    const out: Record<string, string> = {};
    for (const name of await readdir(under, { recursive: true }))
      if (name.endsWith(".json")) out[name] = await readFile(join(under, name), "utf8");
    return out;
  };
  return {
    dir,
    settings,
    delivered,
    saved,
    allow,
    records,
    restoreFrom: (files: RecoveryFiles) => {
      restore = files;
    },
  };
}

const earlier = Object.fromEntries(
  Object.entries(legacy.home)
    .filter(([path]) => path.startsWith("values/"))
    .map(([path, bytes]) => [
      path.slice("values/".length),
      Buffer.from(bytes, "base64").toString(),
    ]),
);

describe("a Secrets home sealed with discovery links", () => {
  it("stays readable and unrewritten, and every crewmate lists it without its links", async () => {
    const f = await fixture();
    // The earlier records do carry links, inside their authenticated bytes.
    expect(Object.values(earlier).some((record) => record.includes('"links"'))).toBe(true);

    const view = await f.settings.view();
    expect(view.availability).toBe("available");
    expect(
      view.entries.map(({ ref, label, version, revision }) => [ref, label, version, revision]),
    ).toEqual(
      legacy.earlierView.map(({ ref, label, version, revision }) => [
        ref,
        label,
        version,
        revision,
      ]),
    );
    for (const entry of view.entries) expect(Object.keys(entry)).not.toContain("links");
    const listed = [
      {
        ref: "planning-calendar",
        label: "Planning calendar",
        version: "1",
        environment: "Personal",
      },
      {
        ref: "staging-deploy",
        label: "Staging deploy token",
        version: "1",
        environment: "Staging",
      },
    ];
    expect(await f.settings.commandFor({ task: "website-task" }).list()).toEqual(listed);
    expect(await f.settings.commandFor({ task: "another-project-task" }).list()).toEqual(listed);
    const shown = JSON.stringify(view) + JSON.stringify(listed);
    for (const word of [...OBSOLETE, STAGING, CALENDAR]) expect(shown).not.toContain(word);

    // An exact use still opens the earlier record and delivers only its value, after approval.
    const receipt = await f.settings.broker({
      id: "legacy-read",
      reason: "Check the staging deployment",
      broker: "deploy-check",
      input: { environment: "staging" },
    });
    expect(receipt.state).toBe("waiting");
    expect(f.delivered).toEqual([]);
    await f.allow();
    expect(f.delivered).toEqual([STAGING]);
    expect(await f.records()).toEqual(earlier);

    // A recovery export carries the values and writes no links.
    expect((await f.settings.action({ kind: "backup-recovery" })).message).toBe(
      SECRETS_RECOVERY_WORDS.save.saved,
    );
    const [exported] = f.saved;
    if (!exported) throw new Error("No recovery export.");
    const contents = openRecovery(exported.archive, exported.key);
    expect(contents?.values.map((value) => Object.keys(value).sort())).toEqual([
      ["discoverable", "environment", "label", "ref", "value"],
      ["discoverable", "environment", "label", "ref", "value"],
    ]);

    // Replacing a value writes the new shape; the other earlier record keeps its bytes.
    const calendar = view.entries.find((entry) => entry.ref === "planning-calendar");
    if (!calendar) throw new Error("No earlier calendar entry.");
    const replaced = await f.settings.put({
      ref: calendar.ref,
      label: calendar.label,
      value: `${CALENDAR}-renewed`,
      expectedVersion: calendar.version,
      expectedRevision: calendar.revision,
      environment: calendar.environment,
    });
    expect(replaced.message).toBe(SECRETS_WORDS.saved);
    const after = await f.records();
    const changed = Object.keys(after).filter((name) => after[name] !== earlier[name]);
    expect(changed).toHaveLength(1);
    expect(JSON.parse(after[changed[0] as string] as string).entry).not.toHaveProperty("links");
  });

  it("restores an archive an earlier version exported with links, staging only the new shape", async () => {
    const f = await fixture();
    const archived = {
      archive: Buffer.from(legacy.recovery.archive, "base64"),
      key: Buffer.from(legacy.recovery.key, "base64"),
    };
    const opened = openRecovery(Buffer.from(archived.archive), Buffer.from(archived.key));
    expect(
      opened?.values.map(({ ref, label, environment, value }) => [
        ref,
        label,
        environment,
        Buffer.from(value, "base64").toString(),
      ]),
    ).toEqual([
      ["planning-calendar", "Planning calendar", "Personal", CALENDAR],
      ["staging-deploy", "Staging deploy token", "Staging", STAGING],
    ]);
    for (const value of opened?.values ?? []) expect(Object.keys(value)).not.toContain("links");

    f.restoreFrom(archived);
    expect((await f.settings.action({ kind: "restore-recovery" })).message).toBe(
      SECRETS_RECOVERY_WORDS.restore.restored,
    );
    const restored = Object.fromEntries(
      Object.entries(await f.records(join(f.dir, "recovered"))).filter(([name]) =>
        name.includes("/values/"),
      ),
    );
    expect(Object.keys(restored)).toHaveLength(2);
    for (const record of Object.values(restored)) {
      expect(JSON.parse(record).entry).not.toHaveProperty("links");
      for (const word of OBSOLETE.slice(0, 3)) expect(record).not.toContain(word);
    }
    expect(await f.settings.commandFor({ task: "website-task" }).list()).toEqual([
      {
        ref: "planning-calendar",
        label: "Planning calendar",
        version: "1",
        environment: "Personal",
      },
      {
        ref: "staging-deploy",
        label: "Staging deploy token",
        version: "1",
        environment: "Staging",
      },
    ]);
    await f.settings.broker({
      id: "restored-read",
      reason: "Check the staging deployment",
      broker: "deploy-check",
      input: { environment: "staging" },
    });
    await f.allow();
    expect(f.delivered).toEqual([STAGING]);
  });
});
