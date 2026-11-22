import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  checkReuseMetadata,
  checkReuseTree,
  type InstallerReusePlan,
  installerReusePlan,
  reuseInstallerFixtures,
} from "../scripts/installer-reuse";
import { hostEnv } from "../src/core/hostEnv";
import { runJobNames } from "./helpers/ciJobNames";
import { scratchDir } from "./helpers/scratchDirs";

// Captain's "Prepare reuse": keep the original build and all installed checks,
// without a new Apple submission. Metadata below comes from run 40141491758;
// tiny ZIPs exercise integrity/provenance, not signing or native installation.
const recordedPlan: InstallerReusePlan = {
  runId: 40141491758,
  artifactId: 12581267324,
  artifactSha256: "68591a83b6df7eec2bb98e75e751d1df6318817280c7b3a0740363f95e1f2b0a",
  sourceHead: "c7f9d964484a82d5cc7194c18ba4407af13e35b3",
  checkHead: "a7dbfd3cd324ef5e147f03278f685d86a65067e7",
  changedPaths: [
    "docs/alpha.md",
    "scripts/check-installed-updates.mjs",
    "tests/fixtures/installed-updates/downloadCache.ts",
    "tests/installed-update-fixtures.test.ts",
  ],
  sameApplication: true,
  applicability:
    "Only the fixture reset, tests and documentation changed; the signed application's original source record stays unchanged.",
};
function records(plan = recordedPlan, size = 3463146283) {
  return {
    run: {
      id: plan.runId,
      head_sha: plan.sourceHead,
      status: "completed",
      conclusion: "failure",
      run_attempt: 1,
    },
    artifact: {
      id: plan.artifactId,
      name: "signed-installer-fixtures",
      expired: false,
      digest: `sha256:${plan.artifactSha256}`,
      size_in_bytes: size,
      created_at: "2026-10-25T00:29:44Z",
      workflow_run: { id: plan.runId, head_sha: plan.sourceHead },
    },
    jobs: [
      {
        id: 121013997786,
        run_attempt: 1,
        name: "Verify signed installer and updater / Build signed verification copies",
        head_sha: plan.sourceHead,
        status: "completed",
        conclusion: "success",
        started_at: "2026-10-24T23:09:02Z",
        completed_at: "2026-10-25T00:31:54Z",
      },
    ] satisfies [unknown],
  };
}

it("accepts the successful signed build even though its installed checks failed", () => {
  const { run, artifact, jobs } = records();
  expect(checkReuseMetadata(recordedPlan, run, artifact, jobs).build.id).toBe(jobs[0].id);
  expect(() => installerReusePlan.parse({ ...recordedPlan, sameApplication: false })).toThrow();
});

// INF-2413: a signed build named trigger first, as verify.yml's installer-only
// request names it (docs/testing.md, "CI job names"), is the same original build.
it("finds the signed build by its trigger-first name", () => {
  const { run, artifact, jobs } = records();
  const build = runJobNames("verify.yml", {
    github: {
      event_name: "workflow_dispatch",
      repository: "infinitary-labs/infinitary-apps",
      ref: "refs/heads/main",
      sha: recordedPlan.sourceHead,
    },
    inputs: { installer_only: true },
  }).find((name) => name.endsWith("Build signed test copies (Mac)"));
  expect(build).toBe(
    "Manual request · Signed installer checks / Manual request · Build signed test copies (Mac)",
  );
  const renamed = [{ ...jobs[0], name: build as string }] satisfies [unknown];
  expect(checkReuseMetadata(recordedPlan, run, artifact, renamed).build.id).toBe(jobs[0].id);
  expect(() => checkReuseMetadata(recordedPlan, run, artifact, [...jobs, ...renamed])).toThrow(
    "exactly once",
  );
});

it.each(["expired", "other-run", "changed-digest", "failed-build", "outside-build"] as const)(
  "refuses %s provenance before any download",
  (kind) => {
    const { run, artifact, jobs } = records();
    if (kind === "expired") artifact.expired = true;
    if (kind === "other-run") artifact.workflow_run.id++;
    if (kind === "changed-digest") artifact.digest = `sha256:${"0".repeat(64)}`;
    if (kind === "failed-build") jobs[0].conclusion = "failure";
    if (kind === "outside-build") artifact.created_at = "2026-10-24T23:08:26Z";
    expect(() => checkReuseMetadata(recordedPlan, run, artifact, jobs)).toThrow();
  },
);

const env = () => ({ ...hostEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
function repository() {
  const scratch = scratchDir("inf-installer-reuse-");
  const root = join(scratch, "source");
  mkdirSync(join(root, "tests/fixtures/installed-updates"), { recursive: true });
  writeFileSync(
    join(root, "tests/fixtures/installed-updates/versions.json"),
    readFileSync("tests/fixtures/installed-updates/versions.json"),
  );
  writeFileSync(join(root, "application.ts"), readFileSync("src/core/update/updateChecker.ts"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env: env(), encoding: "utf8" }).trim();
  git("init", "-q");
  const save = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--no-gpg-sign",
      "-qm",
      "test: record reuse fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const sourceHead = save();
  writeFileSync(join(root, "test-setup.mjs"), readFileSync("scripts/check-installed-updates.mjs"));
  const checkHead = save();
  return {
    scratch,
    root,
    save,
    plan: { ...recordedPlan, sourceHead, checkHead, changedPaths: ["test-setup.mjs"] },
  };
}

it("binds the compatibility declaration to the clean checked tree and every changed path", () => {
  const f = repository();
  expect(() => checkReuseTree(f.plan, f.root, env())).not.toThrow();
  expect(() => checkReuseTree({ ...f.plan, changedPaths: [] }, f.root, env())).toThrow(
    "Every source difference",
  );
  expect(() => checkReuseTree({ ...f.plan, checkHead: f.plan.sourceHead }, f.root, env())).toThrow(
    "another checked version",
  );
  writeFileSync(join(f.root, "application.ts"), readFileSync("src/core/update/macUpdates.ts"));
  expect(() => checkReuseTree(f.plan, f.root, env())).toThrow("clean checked tree");
  const changedHead = f.save();
  expect(() => checkReuseTree({ ...f.plan, checkHead: changedHead }, f.root, env())).toThrow(
    "Every source difference",
  );
});

function archive(f: ReturnType<typeof repository>, mode: string) {
  const path = join(f.scratch, "artifact.zip");
  // Python writes real ZIP64-compatible archives, using the actual fixture roles
  // and the self-map commit field produced by generate-self-source.mjs.
  execFileSync(
    "/usr/bin/python3",
    [
      "-c",
      `
import hashlib, io, json, pathlib, sys, zipfile
output, versions_path, source, mode, content = sys.argv[1:]
versions = json.loads(pathlib.Path(versions_path).read_text())
files = {}
for version in versions.values():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as app:
        app.writestr("Infinitary.app/Contents/Resources/self-map.json", json.dumps({"commit": "0" * 40 if mode == "wrong-source" else source}))
        app.writestr("Infinitary.app/Contents/Resources/fixture", pathlib.Path(content).read_bytes())
    files["Infinitary-" + version + "-universal.zip"] = buffer.getvalue()
for version in [versions["alphaBefore"], versions["promotedStable"]]:
    files["Infinitary-" + version + "-mac-universal.dmg"] = pathlib.Path(content).read_bytes()
digests = {name: {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "sha512": __import__("base64").b64encode(hashlib.sha512(data).digest()).decode()} for name, data in files.items()}
if mode == "changed-file":
    files["Infinitary-" + versions["alphaBefore"] + "-universal.zip"] += b"changed bytes"
files["digests.json"] = json.dumps(digests).encode()
files["versions.json"] = json.dumps(versions).encode()
with zipfile.ZipFile(output, "w", allowZip64=True) as outer:
    for name, data in files.items(): outer.writestr(name, data)
    if mode == "traversal": outer.writestr("../escape", b"must not be written")
    if mode == "duplicate": outer.writestr("versions.json", files["versions.json"])
`,
      path,
      join(f.root, "tests/fixtures/installed-updates/versions.json"),
      f.plan.sourceHead,
      mode,
      join(process.cwd(), "packaging/build/dmg-background.svg"),
    ],
    { env: env(), stdio: "pipe" },
  );
  return readFileSync(path);
}

async function exercise(mode: string) {
  const f = repository();
  const bytes = archive(f, mode);
  f.plan.artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  const { run, artifact, jobs } = records(f.plan, bytes.length);
  if (mode === "later-run-attempt") run.run_attempt = 2;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "fixture-download.invalid") {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      const received = Buffer.from(bytes);
      if (mode === "corrupt-transfer") received.writeUInt8(received.readUInt8(0) ^ 1, 0);
      return new Response(
        mode === "overlong-transfer" ? Buffer.concat([received, Buffer.from([0])]) : received,
      );
    }
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-read-token");
    if (url.pathname.endsWith("/zip"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://fixture-download.invalid/archive" },
      });
    if (url.pathname.endsWith("/jobs")) return Response.json({ jobs, total_count: jobs.length });
    if (url.pathname.includes("/artifacts/")) return Response.json(artifact);
    return Response.json(run);
  });
  const folder = join(f.scratch, "fixtures");
  if (mode === "existing-download") writeFileSync(`${folder}.zip`, bytes);
  const evidence = join(f.scratch, "evidence");
  const result = reuseInstallerFixtures({
    plan: f.plan,
    root: f.root,
    folder,
    evidence,
    repository: "infinitary-labs/infinitary",
    api: "https://api.github.com",
    token: "fixture-read-token",
    env: env(),
    fetcher,
  });
  return { f, folder, evidence, result };
}

it("streams and verifies the artifact, preserves its source, and records the newer check separately", async () => {
  const { f, folder, evidence, result } = await exercise("later-run-attempt");
  await result;
  const proof = JSON.parse(readFileSync(join(evidence, "reuse-provenance.json"), "utf8"));
  expect(proof).toMatchObject({
    sourceHead: f.plan.sourceHead,
    checkHead: f.plan.checkHead,
    originalAttempt: 1,
    readRunAttempt: 2,
    archiveDigestChecked: true,
    fixtureDigestsChecked: true,
    embeddedSourceChecked: true,
  });
  expect(existsSync(`${folder}.zip`)).toBe(false);
  expect(existsSync(join(folder, "versions.json"))).toBe(true);
  console.log(
    "Reuse: archive and every fixture digest verified; original embedded source retained; check source recorded separately.",
  );
});

it.each([
  "corrupt-transfer",
  "overlong-transfer",
  "traversal",
  "duplicate",
  "wrong-source",
  "changed-file",
])("refuses %s instead of running installed checks or rebuilding", async (mode) => {
  const { f, folder, evidence, result } = await exercise(mode);
  await expect(result).rejects.toThrow();
  expect(existsSync(join(evidence, "reuse-provenance.json"))).toBe(false);
  expect(existsSync(join(f.scratch, "escape"))).toBe(false);
  expect(existsSync(`${folder}.zip`)).toBe(false);
});

it("refuses an existing download without overwriting or deleting its bytes", async () => {
  const { f, folder, evidence, result } = await exercise("existing-download");
  await expect(result).rejects.toThrow("EEXIST");
  expect(
    createHash("sha256")
      .update(readFileSync(`${folder}.zip`))
      .digest("hex"),
  ).toBe(f.plan.artifactSha256);
  expect(existsSync(join(evidence, "reuse-provenance.json"))).toBe(false);
});
