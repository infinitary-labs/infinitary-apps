import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appPathsFor, crewmateSessionsDir } from "../src/core/paths";
import { AccountVault } from "../src/core/pi/accountVault";
import { createFixtureRefresh } from "../src/core/quota/fixture";
import { SessionFollower } from "../src/core/storage/sessionReader";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./e2e/accountFixtures";
import { personalResourcesHome } from "./e2e/homeFixtures";
import { seedQuotaFixture } from "./e2e/quotaFixtures";
import { starterFor } from "./e2e/starters";
import { seedCrewTranscript } from "./e2e/transcriptFixtures";
import { scratchDir } from "./helpers/scratchDirs";

/** INF-2394 measure 4: moved fixtures must still satisfy the product's real readers. */
describe("owned journey fixture data", () => {
  it("keeps the account matrix, disabled rows, pins and provider credentials readable", () => {
    const userDataDir = scratchDir("infinitary-account-fixture-");
    const accounts = [
      {
        id: "acct_grok_off",
        providerId: "xai",
        kind: "api_key",
        label: "Old key",
        enabled: false,
        createdAt: Date.parse("2026-08-01T00:00:00Z"),
      },
      {
        id: "acct_grok1",
        providerId: "xai",
        kind: "api_key",
        label: "Personal",
        enabled: true,
        createdAt: Date.parse("2026-08-03T00:00:00Z"),
      },
    ];
    for (const account of accounts) {
      seedAccountStore(userDataDir, account.providerId, account.id);
      seedAccountAuth(userDataDir, account.providerId, account.id, {
        xai: { type: "api_key", key: "disposable-key" },
      });
    }
    seedAccountRegistry(userDataDir, accounts, { xai: "acct_grok1" });
    const paths = appPathsFor(userDataDir);
    const vault = AccountVault.create(paths);
    const reading = { accounts: vault.list(), pin: vault.pinnedAccount("xai") };
    expect(reading).toEqual({ accounts, pin: "acct_grok1" });
    const auth = join(paths.accountsDir, "xai", "acct_grok1", "auth.json");
    expect(JSON.parse(readFileSync(auth, "utf8"))).toEqual({
      xai: { type: "api_key", key: "disposable-key" },
    });
    expect(statSync(auth).mode & 0o777).toBe(0o600);
    if (process.env.INFINITARY_FIXTURE_EVIDENCE)
      writeFileSync(
        join(process.env.INFINITARY_FIXTURE_EVIDENCE, "account-fixture-reading.json"),
        JSON.stringify(reading, null, 2),
      );
  });

  it("feeds the quota fixture consumer both readings without changing their timestamps or model choice", async () => {
    const dir = join(scratchDir("infinitary-quota-fixture-"), "quota");
    const generatedAt = "2026-08-03T00:00:00Z";
    const snapshot = { generatedAt, providers: [] };
    const catalog = {
      generatedAt,
      models: [
        {
          provider: "grok",
          id: starterFor("xai", "medium"),
          label: "Mock Grok",
          effectivePercentRemaining: 80,
        },
      ],
    };
    seedQuotaFixture(dir, snapshot, catalog);
    const reading = await createFixtureRefresh(dir, () => Date.parse(generatedAt))();
    expect(reading.snapshot).toMatchObject(snapshot);
    expect(reading.catalog).toEqual(catalog);
    if (process.env.INFINITARY_FIXTURE_EVIDENCE)
      writeFileSync(
        join(process.env.INFINITARY_FIXTURE_EVIDENCE, "quota-fixture-reading.json"),
        JSON.stringify(reading, null, 2),
      );
  });

  it("places the crew transcript where the shared path owner and session reader expect it", () => {
    const userDataDir = scratchDir("infinitary-transcript-fixture-");
    const entries = [
      { type: "session", version: 3, id: "practice", cwd: "/work/practice" },
      {
        type: "message",
        timestamp: "2026-10-20T16:00:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "The plan is ready." }] },
      },
    ];
    const file = seedCrewTranscript(userDataDir, "practice", "practice.jsonl", entries);
    expect(file).toBe(
      join(crewmateSessionsDir(appPathsFor(userDataDir), "practice"), "practice.jsonl"),
    );
    const reading = new SessionFollower(file).read();
    expect(reading.entries).toEqual(entries);
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    if (process.env.INFINITARY_FIXTURE_EVIDENCE)
      writeFileSync(
        join(process.env.INFINITARY_FIXTURE_EVIDENCE, "session-fixture-reading.json"),
        JSON.stringify(reading, null, 2),
      );
  });

  it("keeps personal resources in their real home formats", () => {
    const home = scratchDir("infinitary-resource-fixture-");
    const marker = "Personal local tone marker: use short sentences.";
    const skillName = "personal-local-rivets";
    personalResourcesHome(marker, skillName)(home);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(marker);
    expect(readFileSync(join(home, ".agents", "skills", skillName, "SKILL.md"), "utf8")).toBe(
      `---\nname: ${skillName}\ndescription: Local rivet guidance.\n---\nCount rivets locally.\n`,
    );
  });
});
