import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";
import { lintFixtureOwners } from "./lint/e2eFixtureOwners";

/** INF-2394 measure 4: the lint finds home preparation and saved-state seeds before their one-off migration. */
function fixture(source: string, owner = "") {
  const dir = scratchDir("infinitary-fixture-owner-lint-");
  const file = join(dir, "journey.spec.ts");
  writeFileSync(file, source);
  writeFileSync(join(dir, "owner.ts"), owner);
  return { file, owner: join(dir, "owner.ts") };
}

const gitHome = `import { writeFileSync as write } from "node:fs";
const home = scratchDir("fm-gitlab-home-");
const config = join(home, ".gitconfig");
write(config, '[url "local.git"]\\n\\tinsteadOf = https://gitlab.com/octo/project.git\\n');`;

// The raw forms come from add-project, personal-resources and model-lists journeys.
describe("fixture ownership (INF-2394 measure 4)", () => {
  it("refuses an aliased home writer and asynchronous user-data destination, not reads or payload paths", () => {
    const { file } = fixture(`${gitHome}
fs.promises.writeFile(join(app.userDataDir, "accounts", "registry.json"), registry);
readFileSync(config);
writeFileSync(script, 'join(home, ".gitconfig")');`);
    expect(lintFixtureOwners([file]).map(({ line }) => line)).toEqual([4, 5]);
  });

  it("keeps same-named destination variables in different functions separate", () => {
    const { file } = fixture(`
function seed(homeDir: string) { const file = join(homeDir, "AGENTS.md"); writeFileSync(file, marker); }
function evidence() { const file = test.info().outputPath("requests.json"); writeFileSync(file, requests); }
`);
    expect(lintFixtureOwners([file]).map(({ line }) => line)).toEqual([2]);
  });

  it("follows copy destinations and both rename destinations, never the copied source", () => {
    const { file } = fixture(`
copyFileSync(join(homeDir, "AGENTS.md"), evidence);
copyFileSync(evidence, join(homeDir, "AGENTS.md"));
renameSync(join(homeDir, "AGENTS.md"), elsewhere);
renameSync(elsewhere, join(homeDir, "AGENTS.md"));
cpSync(evidence, join(homeDir, ".agents"), { recursive: true });
symlinkSync(evidence, join(homeDir, "AGENTS.md"));
`);
    expect(lintFixtureOwners([file]).map(({ line }) => line)).toEqual([3, 4, 5, 6, 7]);
  });

  it("refuses inline and local preparation, accepting imported declared owners and factories", () => {
    const { file, owner } = fixture(
      `
import { signedInHome, homeWithResources } from "./owner";
launchApp({ prepareHome: (home) => seed(home) });
launchApp({ prepareHome: localHome });
launchApp({ prepareHome: signedInHome });
launchApp({ prepareHome: homeWithResources(marker) });
const prepareHome = localHome;
launchApp({ prepareHome });
launchApp({ "prepareHome": localHome });
launchApp({ prepareHome(home) { seed(home); } });
`,
      `/**\n * @journey-area src/core/claude/\n */\nexport function signedInHome(homeDir: string) { writeFileSync(join(homeDir, ".claude.json"), identity); }`,
    );
    expect(lintFixtureOwners([file, owner]).map(({ line }) => line)).toEqual([3, 4, 8, 9, 10]);
    writeFileSync(owner, readFileSync(owner, "utf8").replace("@journey-area", "undeclared-area"));
    expect(lintFixtureOwners([file]).map(({ line }) => line)).toEqual([3, 4, 5, 6, 8, 9, 10]);
  });

  it("requires exported seed helpers to name their product reader, including nested helper folders", () => {
    const { owner } = fixture(
      "",
      `export function seedAccounts(userDataDir: string) { writeFileSync(join(userDataDir, "accounts", "registry.json"), registry); }`,
    );
    expect(lintFixtureOwners([owner])).toHaveLength(2);
    const nested = join(scratchDir("infinitary-owned-fixtures-"), "fixtures");
    mkdirSync(nested);
    const declared = join(nested, "accounts.ts");
    writeFileSync(
      declared,
      `/**\n * @journey-area src/core/auth/\n */\n${readFileSync(owner, "utf8")}`,
    );
    expect(lintFixtureOwners([declared])).toEqual([]);
  });

  // INF-2455: the raw forms come from the subscriptions-instruments, task-model-why and
  // allowance-pending-on-connect journeys before they moved to seedQuotaFixture.
  it("refuses a quota snapshot written by hand in a scratch folder, not other scratch files", () => {
    const { file } = fixture(`
const fixtureDir = scratchDir("infinitary-quota-fixture-");
writeFileSync(join(fixtureDir, "snapshot.json"), JSON.stringify(buildQuotaFixture(Date.now())));
const snapshot = join(fixtureDir, "snapshot.json");
writeFileSync(snapshot, JSON.stringify({ generatedAt, providers: [] }));
writeFileSync(test.info().outputPath("snapshot.json.txt"), log);
writeFileSync(join(fixtureDir, "notes.md"), "snapshot.json");
seedQuotaFixture(fixtureDir, { generatedAt, providers: [] });
`);
    expect(lintFixtureOwners([file]).map(({ line }) => line)).toEqual([3, 5]);
  });

  it("permits only adjacent reasoned mutation/input declarations, not empty or file-wide waivers", () => {
    const { file } = fixture(`
// e2e-fixture: mutation -- reproduce another writer replacing the saved format
writeFileSync(join(userDataDir, "saved-data-format.json"), '{"schemaVersion":1,"revision":2}');
writeFileSync(join(userDataDir, "saved-data-format.json"), '{}');
// e2e-fixture: input -- the captain's uncommitted work is the journey's input
writeFileSync(join(userDataDir, "crew", "project", "notes.md"), "Keep this work.");
// e2e-fixture: mutation --
writeFileSync(join(homeDir, ".gitconfig"), "");
// e2e-fixture: mutation -- prove labels survive missing window caches
for (const name of ["Local Storage", "Session Storage"])
  rmSync(join(fixture.userDataDir, name), { recursive: true, force: true });
`);
    expect(lintFixtureOwners([file]).map(({ line }) => line)).toEqual([4, 8, 11]);
  });
});
