import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { evaluateRules, ProtectedAuthority, type Rule } from "./authority";
import { RootKeys, sha256 } from "./custody";

// Intent: INF-1085's saved settings (new policy Ask; Never overrides Ask, then
// Allow; every required secret evaluated) and INF-1105's protected rules: an
// agent-written, edited or rolled-back authority record grants nothing.
const DEPLOY = sha256("operation: /bin/sh scripts/deploy-staging.sh");
const MIGRATE = sha256("operation: /usr/bin/env node scripts/migrate.mjs");

describe("rule evaluation", () => {
  const rules: Rule[] = [
    { id: "allow-deploy", effect: "allow", secret: "staging-deploy", operation: DEPLOY },
    { id: "allow-db", effect: "allow", secret: "staging-db", operation: DEPLOY },
    { id: "ask-db-migrate", effect: "ask", secret: "staging-db", operation: MIGRATE },
    { id: "allow-db-migrate", effect: "allow", secret: "staging-db", operation: MIGRATE },
    { id: "never-prod", effect: "never", secret: "prod-deploy" },
    { id: "allow-prod", effect: "allow", secret: "prod-deploy", operation: DEPLOY },
  ];

  it("allows only when every secret has a matching Allow", () => {
    expect(evaluateRules(rules, ["staging-db", "staging-deploy"], DEPLOY)).toEqual({
      effect: "allow",
      matched: ["allow-db", "allow-deploy"],
    });
    expect(evaluateRules(rules, ["staging-deploy", "staging-api"], DEPLOY).effect).toBe("ask");
    expect(evaluateRules(rules, ["staging-deploy"], MIGRATE)).toEqual({
      effect: "ask",
      matched: [],
    });
  });

  it("puts Never before Ask and Ask before Allow", () => {
    expect(evaluateRules(rules, ["staging-deploy", "prod-deploy"], DEPLOY)).toEqual({
      effect: "never",
      matched: ["allow-deploy", "never-prod"],
    });
    expect(evaluateRules(rules, ["staging-db"], MIGRATE)).toEqual({
      effect: "ask",
      matched: ["ask-db-migrate"],
    });
  });
});

async function owner(dir: string, custody = disposableCustody()) {
  const keys = await RootKeys.open(custody, { initialize: true, hasRecords: false });
  if (typeof keys === "string") throw new Error(keys);
  return { keys, custody, load: () => ProtectedAuthority.load(dir, keys, custody) };
}

async function loaded(load: () => ReturnType<typeof ProtectedAuthority.load>) {
  const authority = await load();
  if (typeof authority === "string") throw new Error(authority);
  return authority;
}

const allowDeploy: Rule = {
  id: "allow-deploy",
  effect: "allow",
  secret: "staging-deploy",
  operation: DEPLOY,
};

describe("protected authority record", () => {
  it("refuses an edited record, an older valid one and one written without a head", async () => {
    const dir = scratchDir("secrets-authority-");
    const { load } = await owner(dir);
    const authority = await loaded(load);
    expect(
      await authority.save(authority.proposal({ rules: [allowDeploy], devices: [] }).authority),
    ).toBe("stored");
    const file = join(dir, "authority.json");
    copyFileSync(file, `${file}.revision-1`);
    expect(await authority.save(authority.proposal({ rules: [], devices: [] }).authority)).toBe(
      "stored",
    );
    expect((await loaded(load)).evaluate(["staging-deploy"], DEPLOY).effect).toBe("ask");

    // Rolled back: a genuine earlier revision, put back by a same-user program.
    copyFileSync(`${file}.revision-1`, file);
    expect(await load()).toBe("tampered");

    // Edited: the current record with an Allow added and the old check left in place.
    const fresh = scratchDir("secrets-authority-");
    const second = await owner(fresh);
    await loaded(second.load);
    const record = JSON.parse(readFileSync(join(fresh, "authority.json"), "utf8"));
    record.authority.rules.push(allowDeploy);
    writeFileSync(join(fresh, "authority.json"), JSON.stringify(record));
    expect(await second.load()).toBe("tampered");

    // Written by an agent into an owner that never stored a head.
    const planted = scratchDir("secrets-authority-");
    writeFileSync(join(planted, "authority.json"), JSON.stringify(record));
    expect(await (await owner(planted)).load()).toBe("tampered");
  });

  it("refuses an Allow that names no operation", async () => {
    const dir = scratchDir("secrets-authority-");
    const authority = await loaded((await owner(dir)).load);
    const wildcard = { id: "allow-any", effect: "allow" as const, secret: "staging-deploy" };
    expect(
      await authority.save(authority.proposal({ rules: [wildcard], devices: [] }).authority),
    ).toBe("invalid");
  });

  it("finishes a save interrupted after its head moved, and drops one interrupted before", async () => {
    const dir = scratchDir("secrets-authority-");
    const { load, custody } = await owner(dir);
    const authority = await loaded(load);
    const file = join(dir, "authority.json");
    copyFileSync(file, `${file}.revision-0`);
    await authority.save(authority.proposal({ rules: [allowDeploy], devices: [] }).authority);
    // The head moved to revision 1; the rename to the current name never happened.
    renameSync(file, join(dir, "authority.next.json"));
    renameSync(`${file}.revision-0`, file);
    const resumed = await loaded(load);
    expect(resumed.authority.revision).toBe(1);
    expect(existsSync(join(dir, "authority.next.json"))).toBe(false);

    custody.state = "unavailable";
    expect(await resumed.save(resumed.proposal({ rules: [], devices: [] }).authority)).toBe(
      "unavailable",
    );
    custody.state = "open";
    expect((await loaded(load)).authority.revision).toBe(1);
    expect(existsSync(join(dir, "authority.next.json"))).toBe(false);
  });
});
