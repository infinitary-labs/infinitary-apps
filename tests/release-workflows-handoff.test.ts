import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  loadYamlFile,
  PUBLICATION_TOKEN,
  PUBLISHES,
  root,
  type ChannelStep as Step,
  signedChannel,
  UPLOADS,
  type ChannelWorkflow as Workflow,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";
import { standInGh } from "./helpers/standInGh";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** The signing job's handoff to the upload and publication jobs (release.yml). */

describe("the signed channel workflow", () => {
  const release = loadYamlFile(".github/workflows/release.yml") as Workflow;
  const verify = loadYamlFile(".github/workflows/verify.yml") as Workflow;
  const { jobOf, signingSteps, uploadSteps, publishSteps, steps, step } = signedChannel(
    release,
    verify,
  );

  // INF-1716, the captain's "After the disk-image check": the real Mac signs
  // through the checked disk image. INF-2498's plan, piece 2 (the captain's
  // hosted-parallel choice): a machine GitHub hosts uploads from the signing
  // job's handoff, only once that job succeeded, and one existing virtual Mac
  // then checks every copy and switches.
  it("uploads only after the signing job succeeded, on a hosted machine, then checks and switches in one virtual Mac", () => {
    const upload = jobOf(release, "upload");
    const publish = jobOf(release, "publish");
    const before = ["resolve", "notes", "verify", "linux", "phone", "release", "update"];
    expect(upload.needs).toEqual(before);
    expect(publish.needs).toEqual([...before, "upload"]);
    for (const dryRun of ["false", "true"]) {
      const contexts = { needs: { resolve: { outputs: { dry_run: dryRun } } }, vars: {} };
      expect(workflowString(upload["runs-on"] ?? "", contexts)).toBe("ubuntu-24.04");
      expect(workflowValue(publish["runs-on"] ?? "", contexts)).toBe("mini-mac-virtual");
    }
    // Every check passed, or was inherited, as a passing run leaves them.
    const checks = (required: string) => ({
      notes: { result: "success" },
      verify: { result: required === "true" ? "success" : "skipped" },
      linux: { result: "success" },
      phone: { result: "success" },
    });
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      for (const cancelled of [false, true]) {
        // INF-1900: an alpha publishes only after its update check passed on
        // both chips; a stable inherits its alpha's and skips it.
        for (const [required, update, publishes] of [
          ["true", "success", true],
          ["true", "failure", false],
          ["true", "skipped", false],
          ["false", "skipped", true],
          ["false", "success", false],
        ] as const) {
          const needs = {
            resolve: {
              result: "success",
              outputs: { verify_required: required },
            },
            ...checks(required),
            release: { result },
            update: { result: update },
          };
          const status = { success: result === "success", failure: false, always: true, cancelled };
          const label = `${result}${cancelled ? ", run cancelled" : ""}, verify ${required}, update ${update}`;
          const uploads = result === "success" && !cancelled && publishes;
          expect(workflowValue(upload.if ?? "", { needs }, status), label).toBe(uploads);
          expect(
            workflowValue(
              publish.if ?? "",
              { needs: { ...needs, upload: { result: uploads ? "success" : "skipped" } } },
              status,
            ),
            label,
          ).toBe(uploads);
        }
      }
    }
    // The update check runs on the signing job's handoff once it and every
    // check succeeded, only where verification is required.
    const update = jobOf(release, "update");
    expect(update.needs).toEqual(["resolve", "notes", "verify", "linux", "phone", "release"]);
    for (const required of ["true", "false"]) {
      for (const result of ["success", "failure", "skipped"]) {
        const needs = {
          resolve: {
            result: "success",
            outputs: { verify_required: required },
          },
          ...checks(required),
          release: { result },
        };
        expect(
          workflowValue(
            update.if ?? "",
            { needs },
            { success: result === "success", failure: false, always: true, cancelled: false },
          ),
        ).toBe(required === "true" && result === "success");
      }
    }
    // Their checkouts keep no credential, and each holds only the access its
    // moves need: the upload job writes the record, the virtual Mac only reads.
    for (const first of [uploadSteps[0], publishSteps[0]])
      expect(first).toMatchObject({
        uses: "actions/checkout@v4",
        with: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
          ref: "${{ needs.resolve.outputs.source_commit }}",
          "persist-credentials": false,
        },
      });
    expect(upload.permissions).toEqual({ contents: "write", actions: "read" });
    expect(publish.permissions).toEqual({ contents: "read", actions: "read" });
    // The virtual Mac uploads nothing: its only effects are the switches, and
    // each comes after every copy was fetched back and checked.
    const ids = publishSteps.map((candidate) => candidate.id ?? candidate.name ?? "");
    expect(publishSteps.filter((candidate) => UPLOADS.test(candidate.run ?? ""))).toEqual([]);
    expect(
      publishSteps.filter((candidate) => PUBLISHES.test(candidate.run ?? "")).map(({ id }) => id),
    ).toEqual(["tap", "old-tap", "feeds"]);
    const lastCheck = Math.max(...ids.flatMap((id, at) => (/fetch-back$/.test(id) ? [at] : [])));
    expect(lastCheck).toBeLessThan(ids.indexOf("tap"));
    // One upload of a version at a time, so two runs of it never read the
    // places at once; a rehearsal never waits behind a release.
    const group = (version: string, dryRun: string) =>
      workflowValue((upload as { concurrency?: { group: string } }).concurrency?.group ?? "", {
        needs: { resolve: { outputs: { version, dry_run: dryRun } } },
      });
    expect(group("0.6.2", "false")).toBe(group("0.6.2", "false"));
    expect(group("0.6.2", "false")).not.toBe(group("0.6.3", "false"));
    expect(group("0.6.2", "false")).not.toBe(group("0.6.2", "true"));
    expect(
      (upload as { concurrency?: Record<string, unknown> }).concurrency?.["cancel-in-progress"],
    ).toBe(false);
    // The handoff is stored as is, two artifacts per producer attempt - the
    // zip's, then the manifest's and disk image's (INF-3193) - and fetched by
    // the immutable ids the signing job recorded.
    for (const [id, name] of <const>[
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      ["handoff-zip-upload", "${{ steps.handoff-zip.outputs.name }}"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      ["handoff-upload", "${{ steps.handoff.outputs.name }}"],
    ])
      expect(step(id)).toMatchObject({
        uses: "actions/upload-artifact@v4",
        with: { name, "compression-level": 0, "if-no-files-found": "error" },
      });
    const fetch = uploadSteps.find((candidate) => candidate.name === "Fetch the checked files");
    expect(fetch).toMatchObject({
      uses: "actions/download-artifact@v4",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      with: { "artifact-ids": "${{ needs.release.outputs.handoff_id }}" },
    });
    expect(uploadSteps.indexOf(fetch as Step)).toBeLessThan(
      uploadSteps.indexOf(step("handoff-check")),
    );
    // Nothing that publishes or holds a publication credential comes before the validation.
    const checked = uploadSteps.indexOf(step("handoff-check"));
    for (const candidate of uploadSteps.slice(0, checked))
      expect(
        PUBLISHES.test(candidate.run ?? "") ||
          PUBLICATION_TOKEN.test(JSON.stringify(candidate.env ?? {})),
        candidate.name,
      ).toBe(false);
    const outputs = jobOf(release, "release").outputs ?? {};
    expect(outputs).toEqual({
      handoff_id:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        "${{ format('{0},{1}', steps.handoff-zip-upload.outputs.artifact-id, steps.handoff-upload.outputs.artifact-id) }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      handoff_zip_id: "${{ steps.handoff-zip-upload.outputs.artifact-id }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      handoff_name: "${{ steps.handoff.outputs.name }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      handoff_manifest: "${{ steps.handoff.outputs.manifest }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      sha256: "${{ steps.handoff.outputs.sha256 }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      direct: "${{ steps.handoff.outputs.direct }}",
    });
    // The signing job keeps its keychain cleanup on every exit, after its handoff.
    const cleanup = signingSteps.at(-1);
    expect(cleanup?.name).toBe("Remove the signing keychain");
    expect(cleanup?.if).toBe("always()");
    expect(signingSteps.indexOf(step("handoff-upload"))).toBeLessThan(signingSteps.length - 1);
  });

  /**
   * The handoff's two ends as Actions runs them: the signing job's step
   * writes the files and manifest, the artifact carries them unchanged, and
   * the publication job's step accepts them or refuses before any effect.
   * Readings from release run 40651382197, alpha 0.6.1-alpha.30, whose
   * Linux files the release's own renderer lays out on the publication side.
   * Where a case reads or writes the record, the release's own steps run
   * against a stand-in `gh` keeping it in a scratch folder.
   */
  describe("the handoff between the signing and publication jobs", () => {
    const version = "0.6.1-alpha.30";
    const source = "2e1588dc71ecc13f6695114b0c852049c4d3fe7c";
    const workflowSha = "28d2fcb16ddcd5bffe26db7587e084d212d253b6";
    const runId = "40651382197";
    const bytes = readFileSync(join(root, "packaging/build/icon.png"));
    const resolveOutputs = (overrides: Record<string, string> = {}) => ({
      channel: "alpha",
      dry_run: "false",
      source_commit: source,
      version,
      tag_name: `v${version}`,
      zip_name: `Infinitary-${version}-universal.zip`,
      old_cask: "true",
      prerelease: "true",
      public_tag: `infinitary-alpha-v${version}`,
      old_public_tag: `firstmate-3000-alpha-v${version}`,
      cask_token: "infinitary@alpha",
      ...overrides,
    });
    // The repository the run records in, as GITHUB_REPOSITORY names it.
    const recordRepository = "infinitary-labs/infinitary";
    // Stand-in keys: the disposable storage accepts only these.
    const secrets = {
      GITHUB_TOKEN: "stand-in",
      HOMEBREW_TAP_TOKEN: "stand-in-tap",
      OLD_TAP_TOKEN: "stand-in-old-tap",
      R2_ENDPOINT: "https://r2.example.test",
      R2_ACCESS_KEY_ID: "disposable",
      R2_SECRET_ACCESS_KEY: "disposable-not-a-secret",
    };
    const vars = { R2_BUCKET: "installers" };
    const run = (script: string, env: Record<string, string>) =>
      spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...env },
      });
    const outputsOf = (file: string) =>
      Object.fromEntries(
        readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
    const jobEnv = (id: string, resolve: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(jobOf(release, id).env ?? {}).map(([name, value]) => [
          name,
          workflowString(value, { needs: { resolve: { outputs: resolve } } }),
        ]),
      );
    const stepEnv = (found: Step, contexts: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(found.env ?? {}).map(([name, value]) => [
          name,
          workflowString(value, contexts),
        ]),
      );

    const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

    /**
     * The signing job's record read, then its two handoff steps, on a run's files;
     * their outputs and the job's. With a stand-in record the job's own read
     * runs against it; otherwise `adopted` stands for a retry whose record
     * keeps the bytes published first.
     */
    const produce = (options: {
      dryRun?: boolean;
      direct?: boolean;
      adopted?: boolean;
      attempt?: string;
      record?: ReturnType<typeof standInGh>;
    }) => {
      const { dryRun = false, direct = true, adopted = false, attempt = "1", record } = options;
      const temp = scratchDir("infinitary-handoff-signing-");
      const resolve = resolveOutputs({ dry_run: String(dryRun) });
      const env = jobEnv("release", resolve);
      mkdirSync(join(temp, "dist"));
      const distZip = join(temp, "dist", env.ZIP_NAME ?? "");
      writeFileSync(distZip, bytes);
      let read: { outputs: Record<string, string> } = { outputs: {} };
      if (record && !dryRun) {
        const output = join(temp, "recorded-output");
        writeFileSync(output, "");
        const result = run(step("recorded").run ?? "", {
          ...env,
          ...stepEnv(step("recorded"), { secrets }),
          PATH: `${record.bin}:${process.env.PATH}`,
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: recordRepository,
        });
        expect(result.status, result.stderr).toBe(0);
        read = { outputs: outputsOf(output) };
      } else if (adopted) {
        // A retry's record keeps the bytes published first, which differ from its rebuild.
        const published = join(temp, "recorded", env.ZIP_NAME ?? "");
        mkdirSync(dirname(published), { recursive: true });
        writeFileSync(published, Buffer.concat([bytes, Buffer.from("published first")]));
        read = { outputs: { zip: published, sha256: sha(published) } };
      }
      const recorded = read.outputs.zip ?? distZip;
      const builtDmg = dryRun || direct;
      const dmg = join(temp, "dmg", env.DMG_NAME ?? "");
      if (builtDmg) {
        mkdirSync(dirname(dmg));
        writeFileSync(dmg, Buffer.concat([bytes, Buffer.from("disk image")]));
      }
      const steps = {
        recorded: read,
        checksum: { outputs: { sha256: sha(distZip) } },
        dmg: { outputs: builtDmg ? { path: dmg } : {} },
        visibility: { outputs: dryRun ? {} : { direct: String(direct) } },
      };
      const contexts = {
        needs: { resolve: { outputs: resolve } },
        github: { run_id: runId, run_attempt: attempt, sha: workflowSha },
      };
      // The zip's artifact goes up first, then the manifest's (INF-3193).
      const ran = (id: string, stepOutputs: Record<string, unknown>) => {
        const output = join(temp, `${id}-output`);
        const result = run(step(id).run ?? "", {
          ...env,
          ...stepEnv(step(id), { ...contexts, steps: stepOutputs }),
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: output,
          dist_zip: distZip,
        });
        expect(result.status, result.stderr).toBe(0);
        return outputsOf(output);
      };
      const handoffZip = ran("handoff-zip", steps);
      const handoff = ran("handoff", { ...steps, "handoff-zip": { outputs: handoffZip } });
      const job = Object.fromEntries(
        Object.entries(jobOf(release, "release").outputs ?? {}).map(([name, value]) => [
          name,
          workflowString(value, {
            steps: {
              "handoff-zip": { outputs: handoffZip },
              "handoff-zip-upload": { outputs: { "artifact-id": "4710" } },
              handoff: { outputs: handoff },
              "handoff-upload": { outputs: { "artifact-id": "4711" } },
            },
          }),
        ]),
      );
      return { temp, handoffZip, handoff, job, resolve, recorded, distZip, dmg };
    };

    /** The artifact as the publication job fetches it, then its validation step. */
    const consume = (
      produced: ReturnType<typeof produce>,
      options: {
        alter?: (download: string) => void;
        resolve?: Record<string, string>;
        job?: Record<string, string>;
        github?: Record<string, string>;
      } = {},
    ) => {
      const temp = scratchDir("infinitary-handoff-publication-");
      const download = join(temp, "handoff-download");
      // Both artifacts by id into one folder, as merge-multiple lays them out.
      cpSync(produced.handoffZip.path ?? "", download, { recursive: true });
      cpSync(produced.handoff.path ?? "", download, { recursive: true });
      options.alter?.(download);
      const resolve = options.resolve ?? produced.resolve;
      const contexts = {
        needs: {
          resolve: { outputs: resolve },
          release: { outputs: { ...produced.job, ...options.job } },
        },
        github: { run_id: runId, run_attempt: "1", sha: workflowSha, ...options.github },
      };
      const output = join(temp, "output");
      const result = run(step("handoff-check").run ?? "", {
        ...jobEnv("upload", resolve),
        ...stepEnv(step("handoff-check"), contexts),
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
      });
      return { temp, result, outputs: existsSync(output) ? outputsOf(output) : {} };
    };
    const accepted = (consumed: ReturnType<typeof consume>) => {
      expect(consumed.result.status, consumed.result.stderr).toBe(0);
      return consumed.outputs;
    };
    const refused = (consumed: ReturnType<typeof consume>, reason: RegExp) => {
      expect(consumed.result.status).not.toBe(0);
      expect(consumed.result.stderr).toMatch(/Refusing the handoff: /);
      expect(consumed.result.stderr).toMatch(reason);
      // Nothing was laid out for publication to read.
      expect(consumed.outputs).toEqual({});
      expect(existsSync(join(consumed.temp, "handoff"))).toBe(false);
    };

    it("hands publication the record's zip and the checked image, byte for byte, and no Linux files", () => {
      const produced = produce({ adopted: true });
      expect(produced.job.handoff_id).toBe("4710,4711");
      expect(produced.job.handoff_zip_id).toBe("4710");
      expect(produced.job.handoff_name).toBe("release-handoff-1");
      expect(produced.job.direct).toBe("true");
      const outputs = accepted(consume(produced));
      // The previously published zip wins over the retry's rebuild.
      expect(readFileSync(outputs.zip ?? "")).toEqual(readFileSync(produced.recorded));
      expect(produced.job.sha256).toBe(sha(produced.recorded));
      expect(produced.job.sha256).not.toBe(sha(produced.distZip));
      expect(readFileSync(outputs.dmg ?? "")).toEqual(readFileSync(produced.dmg));
      // Only the allowlist travels: no app, workspace or environment. The
      // Linux files reach publication from the linux job, which may still
      // run while the signing job hands off (INF-2074).
      expect(readdirSync(produced.handoffZip.path ?? "")).toEqual(["zip"]);
      expect(readdirSync(produced.handoff.path ?? "").sort()).toEqual(["dmg", "manifest.json"]);
      expect(readFileSync(join(produced.handoff.path ?? "", "manifest.json"), "utf8")).not.toMatch(
        /secret|TOKEN|KEY/,
      );
    });

    it("hands no disk image without direct downloads, and a rehearsal's checked zip and image", () => {
      const homebrewOnly = accepted(consume(produce({ direct: false })));
      expect(homebrewOnly.dmg).toBe("");
      const rehearsal = produce({ dryRun: true });
      expect(rehearsal.job.direct).toBe("false");
      expect(accepted(consume(rehearsal)).dmg).toMatch(/mac-universal\.dmg$/);
    });

    /**
     * INF-3193 (the captain: "find signing steps that can overlap"): the disk
     * image starts in the background, so the zip's gate and upload run while
     * Apple notarizes it, and the step that waits for it passes or fails on
     * its outcome. The disk image's own scripts and Apple's tools are
     * stand-ins; the notarization stand-in holds until the test lets it go.
     */
    it("builds the disk image beside the zip's steps, and its waiting step reports how it ended", () => {
      const resolve = resolveOutputs();
      const env = jobEnv("release", resolve);
      const background = (verifyStatus: number) => {
        const temp = scratchDir("infinitary-handoff-dmg-");
        const work = join(temp, "source");
        const bin = join(temp, "bin");
        mkdirSync(join(work, "scripts"), { recursive: true });
        mkdirSync(bin);
        const gate = join(temp, "notarization-done");
        const tools: Record<string, string> = {
          [join(bin, "ditto")]: 'for last; do :; done; mkdir -p "$last"',
          [join(bin, "codesign")]: "exit 0",
          [join(bin, "xcrun")]:
            `if [[ "$1" == notarytool ]]; then while [[ ! -e "${gate}" ]]; do sleep 0.1; done; fi`,
          [join(work, "scripts", "build-mac-dmg.sh")]:
            'mkdir -p "$3" && echo image > "$3/$DMG_NAME"',
          [join(work, "scripts", "verify-mac-dmg.sh")]: `echo "checked $1"; exit ${verifyStatus}`,
        };
        for (const [path, body] of Object.entries(tools))
          writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
        const stepRun = (id: string, contexts: Record<string, unknown>) => {
          const output = join(temp, `${id}-output`);
          writeFileSync(output, "");
          const result = spawnSync(
            "bash",
            ["--noprofile", "--norc", "-e", "-c", step(id).run ?? ""],
            {
              cwd: work,
              encoding: "utf8",
              env: {
                PATH: `${bin}:${process.env.PATH}`,
                ...release.env,
                ...env,
                ...stepEnv(step(id), contexts),
                RUNNER_TEMP: temp,
                GITHUB_OUTPUT: output,
                dist_zip: join(temp, env.ZIP_NAME ?? ""),
              },
            },
          );
          return { result, outputs: outputsOf(output) };
        };
        const started = stepRun("dmg", { steps: {}, secrets: {} });
        expect(started.result.status, started.result.stderr).toBe(0);
        // The start returned while notarization still holds: nothing is built yet.
        expect(existsSync(join(temp, "dmg-job", "status"))).toBe(false);
        writeFileSync(gate, "");
        const done = stepRun("dmg-done", { steps: { dmg: { outputs: started.outputs } } });
        return { started, done, temp };
      };
      const passed = background(0);
      expect(passed.done.result.status, passed.done.result.stderr).toBe(0);
      expect(passed.done.result.stdout).toContain(`checked ${passed.started.outputs.path}`);
      expect(readFileSync(passed.started.outputs.path ?? "", "utf8")).toBe("image\n");
      expect(existsSync(`${passed.started.outputs.path}.sha256`)).toBe(true);
      const failed = background(3);
      expect(failed.done.result.status).not.toBe(0);
      expect(failed.done.result.stdout).toContain("checked");
      expect(failed.done.result.stderr).toMatch(/ended with status 3/);
    });

    it("lets a publication-only rerun reuse an earlier attempt's handoff, and refuses one from a later attempt", () => {
      const produced = produce({ attempt: "1" });
      expect(accepted(consume(produced, { github: { run_attempt: "2" } })).attempt).toBe("1");
      const rerun = produce({ attempt: "3" });
      expect(rerun.job.handoff_name).toBe("release-handoff-3");
      refused(consume(rerun, { github: { run_attempt: "2" } }), /attempt 3 is not of this run/);
      refused(consume(produced, { job: { handoff_name: "release-handoff-2" } }), /not attempt 1's/);
    });

    it.each([
      [
        "an altered zip",
        (dir: string) =>
          writeFileSync(join(dir, "zip", `Infinitary-${version}-universal.zip`), "altered"),
        /zip\/Infinitary-.* is not the file the signing job checked/,
      ],
      [
        "an altered image",
        (dir: string) =>
          writeFileSync(join(dir, "dmg", `Infinitary-${version}-mac-universal.dmg`), "altered"),
        /dmg\/.* is not the file/,
      ],
      [
        "a missing image",
        (dir: string) => rmSync(join(dir, "dmg", `Infinitary-${version}-mac-universal.dmg`)),
        /missing \["dmg\/Infinitary-.*-mac-universal\.dmg"\]/,
      ],
      [
        "an extra file",
        (dir: string) => writeFileSync(join(dir, "zip", "unlisted.zip"), "extra"),
        /extra \["zip\/unlisted\.zip"\]/,
      ],
      [
        "an edited manifest",
        (dir: string) =>
          writeFileSync(
            join(dir, "manifest.json"),
            readFileSync(join(dir, "manifest.json"), "utf8").replace(
              '"channel": "alpha"',
              '"channel": "stable"',
            ),
          ),
        /manifest is not the one the signing job recorded/,
      ],
    ])("refuses %s before any effect", (_name, alter, reason) => {
      refused(consume(produce({}), { alter }), reason);
    });

    it("refuses a handoff from another release, run or workflow revision", () => {
      const produced = produce({});
      refused(
        consume(produced, {
          resolve: resolveOutputs({
            version: "0.6.1-alpha.31",
            zip_name: "Infinitary-0.6.1-alpha.31-universal.zip",
          }),
        }),
        /its version is "0\.6\.1-alpha\.30"/,
      );
      refused(
        consume(produced, { resolve: resolveOutputs({ source_commit: "f".repeat(40) }) }),
        /its source is/,
      );
      refused(
        consume(produced, { resolve: resolveOutputs({ channel: "stable" }) }),
        /its channel is "alpha", not "stable"/,
      );
      refused(
        consume(produced, { resolve: resolveOutputs({ old_cask: "false" }) }),
        /its oldCask is true, not false/,
      );
      refused(consume(produced, { github: { run_id: "40651382198" } }), /its run is "40651382197"/);
      refused(consume(produced, { github: { sha: "e".repeat(40) } }), /its workflow is/);
      refused(consume(produced, { job: { direct: "false" } }), /its direct is true, not false/);
      refused(consume(produced, { job: { sha256: "0".repeat(64) } }), /its sha256 is/);
      refused(consume(produced, { job: { handoff_manifest: "" } }), /manifest is not the one/);
    });

    /**
     * The upload job's own steps after it accepted the handoff, in order, as
     * Actions runs them: each step whose condition holds, with the job's and
     * its own environment, until one fails or `until` ran. The linux job's
     * packages are laid out as their artifact download leaves them. The
     * record and both taps are a stand-in `gh`'s, and Cloudflare is the
     * disposable storage file the publication command's own test uses.
     */
    const uploadAfterChecks = (
      produced: ReturnType<typeof produce>,
      consumed: ReturnType<typeof consume>,
      places: ReturnType<typeof standInGh>,
      options: { until?: string; packages?: Record<string, Buffer | string> } = {},
    ) => {
      const temp = consumed.temp;
      const packages = join(temp, "linux-packages");
      mkdirSync(packages);
      for (const name of linuxPackages)
        writeFileSync(join(packages, name), options.packages?.[name] ?? bytes);
      const outputs: Record<string, Record<string, string>> = {
        "handoff-check": accepted(consumed),
      };
      const results: Record<string, ReturnType<typeof run>> = {};
      for (const candidate of uploadSteps) {
        const id = candidate.id;
        if (!id || !candidate.run || id === "handoff-check") continue;
        const contexts = {
          needs: { resolve: { outputs: produced.resolve }, release: { outputs: produced.job } },
          steps: Object.fromEntries(
            Object.entries(outputs).map(([name, value]) => [name, { outputs: value }]),
          ),
          secrets,
          vars,
        };
        if (candidate.if && workflowValue(candidate.if, contexts) !== true) continue;
        const output = join(temp, `${id}-output`);
        writeFileSync(output, "");
        results[id] = run(candidate.run, {
          ...release.env,
          ...jobEnv("upload", produced.resolve),
          ...stepEnv(candidate, contexts),
          PATH: `${places.bin}:${process.env.PATH}`,
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: recordRepository,
          NODE_OPTIONS: `--import=${pathToFileURL(join(root, "tests/helpers/releaseStoragePreload.mjs")).href}`,
          RELEASE_STORAGE_FIXTURE: storageOf(consumed),
        });
        outputs[id] = outputsOf(output);
        if (results[id].status !== 0 || id === options.until) break;
      }
      return { results, outputs };
    };
    const succeeded = (uploaded: ReturnType<typeof uploadAfterChecks>) => {
      for (const [id, result] of Object.entries(uploaded.results))
        expect(result.status, `${id}: ${result.stderr}`).toBe(0);
      return uploaded.outputs;
    };
    /** Cloudflare's objects, by key, as the disposable storage keeps them. */
    const storageOf = (consumed: ReturnType<typeof consume>) => join(consumed.temp, "storage.json");
    const cloudflare = (consumed: ReturnType<typeof consume>): Record<string, Buffer> =>
      existsSync(storageOf(consumed))
        ? Object.fromEntries(
            Object.entries(
              JSON.parse(readFileSync(storageOf(consumed), "utf8")) as Record<
                string,
                { bytes: string }
              >,
            ).map(([key, value]) => [key, Buffer.from(value.bytes, "base64")]),
          )
        : {};
    const seedCloudflare = (consumed: ReturnType<typeof consume>, files: Record<string, string>) =>
      writeFileSync(
        storageOf(consumed),
        JSON.stringify(
          Object.fromEntries(
            Object.entries(files).map(([name, text]) => [
              `releases/v${version}/${name}`,
              {
                bytes: Buffer.from(text).toString("base64"),
                etag: `"${createHash("sha256").update(text).digest("hex")}"`,
              },
            ]),
          ),
        ),
      );
    const tag = `v${version}`;
    const zipName = `Infinitary-${version}-universal.zip`;
    const dmgName = `Infinitary-${version}-mac-universal.dmg`;
    const tapTag = `infinitary-alpha-v${version}`;
    const oldTapTag = `firstmate-3000-alpha-v${version}`;
    const tapRepository = release.env.TAP_REPO ?? "";
    const oldTapRepository = release.env.OLD_TAP_REPO ?? "";
    const deb = `infinitary-${version}-linux-amd64.deb`;
    const linuxPackages = [
      deb,
      `infinitary-${version}-linux-x86_64.rpm`,
      `Infinitary-${version}-linux-x86_64.AppImage`,
    ];
    const shaOf = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
    /** Each published file's bytes on a place, its checksum sidecars aside. */
    const held = (files: Record<string, string | Buffer> | null) =>
      Object.fromEntries(
        Object.entries(files ?? {})
          .filter(([name]) => !name.endsWith(".sha256"))
          .map(([name, value]) => [name, shaOf(value)]),
      );
    const releaseFiles = (places: ReturnType<typeof standInGh>, repo: string, at: string) =>
      places.publishedBytes(repo, at);

    // INF-2074: the signing job reads the record and writes nothing; the
    // upload job, which starts only once every check passed, records.
    // INF-2498's plan, piece 2: it records the zip first, then uploads every
    // file to the record, Cloudflare and both taps at once.
    it("records the zip first, then puts every file on every place at once, only in the upload job", () => {
      const places = standInGh(source);
      const produced = produce({ record: places });
      // No release yet: the signing job read nothing and created nothing.
      expect(places.published(recordRepository, tag)).toBeNull();
      expect(places.calls().filter(([verb, sub]) => verb === "release" && sub !== "view")).toEqual(
        [],
      );
      expect(produced.recorded).toBe(produced.distZip);
      const consumed = consume(produced);
      const outputs = succeeded(uploadAfterChecks(produced, consumed, places));
      expect(outputs.private).toEqual({
        zip: consumed.outputs.zip,
        sha256: sha(produced.distZip),
        state: "uploaded",
      });
      // The list the virtual Mac checks every copy against.
      const files = JSON.parse(outputs.files?.files ?? "{}") as Record<string, string>;
      expect(Object.keys(files).slice(0, 2)).toEqual([zipName, dmgName]);
      expect(files[zipName]).toBe(produced.job.sha256);
      expect(files[dmgName]).toBe(sha(produced.dmg));
      expect(Object.keys(files)).toEqual(expect.arrayContaining([...linuxPackages, "SHA256SUMS"]));
      // Every place holds exactly those bytes: the record and Cloudflare the
      // disk image too, the taps the zip and the Linux files.
      const { [dmgName]: _image, ...tapFiles } = files;
      expect(held(releaseFiles(places, recordRepository, tag))).toEqual(files);
      expect(held(releaseFiles(places, tapRepository, tapTag))).toEqual(tapFiles);
      expect(held(releaseFiles(places, oldTapRepository, oldTapTag))).toEqual(tapFiles);
      const stored = cloudflare(consumed);
      for (const [name, sha256] of Object.entries(files)) {
        expect(shaOf(stored[`releases/v${version}/${name}`] ?? ""), name).toBe(sha256);
        expect(stored[`releases/v${version}/${name}.sha256`]?.toString()).toBe(
          `${sha256}  ${name}\n`,
        );
      }
      expect(places.published(recordRepository, tag)?.[`${zipName}.sha256`]).toBe(
        `${produced.job.sha256}  ${zipName}\n`,
      );
      // The record took the zip before any other place took anything.
      const uploads = places
        .calls()
        .filter(([verb, sub]) => verb === "release" && sub === "upload")
        .map((call) => `${call[call.indexOf("--repo") + 1]} ${call.at(-1)?.split("/").pop()}`);
      expect(uploads[0]).toBe(`${recordRepository} ${zipName}`);
      expect(outputs.upload?.places).toBe("record, tap, cloudflare, old_tap");
    });

    // The virtual Mac uploads nothing: it writes down the upload job's list,
    // whose zip must be the one the signing job checked, then downloads each
    // of the record's copies and checks it against its sidecar and that list.
    it("checks each copy the record holds against the upload job's list, on the virtual Mac", () => {
      const places = standInGh(source);
      const produced = produce({ record: places });
      const consumed = consume(produced);
      const listed = succeeded(uploadAfterChecks(produced, consumed, places)).files?.files ?? "";
      const files = JSON.parse(listed) as Record<string, string>;
      const temp = scratchDir("infinitary-handoff-checks-");
      const check = (id: string, upload: string, script = step(id).run ?? "") => {
        const contexts = {
          needs: {
            resolve: { outputs: produced.resolve },
            release: { outputs: produced.job },
            upload: { outputs: { files: upload } },
          },
          secrets,
          vars,
        };
        return run(script, {
          ...release.env,
          ...jobEnv("publish", produced.resolve),
          ...stepEnv(step(id), contexts),
          PATH: `${places.bin}:${process.env.PATH}`,
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: join(temp, `${id}-output`),
          GITHUB_REPOSITORY: recordRepository,
        });
      };
      const written = check("expected", listed);
      expect(written.status, written.stderr).toBe(0);
      expect(readFileSync(join(temp, "expected", "files.sha256"), "utf8")).toBe(
        Object.entries(files)
          .map(([name, sha256]) => `${sha256}  ${name}\n`)
          .join(""),
      );
      // A list whose zip is not the signed one is refused before any fetch.
      const swapped = JSON.stringify({ ...files, [zipName]: shaOf("another zip") });
      const refused = check("expected", swapped);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/not the [0-9a-f]{64} the signing job checked/);
      expect(check("expected", listed).status).toBe(0);
      // The fetch-back's download and checks, up to the app's own gates,
      // which need the signed app a Mac opens.
      const fetchBack = step("private-fetch-back").run ?? "";
      const downloads = fetchBack.slice(0, fetchBack.indexOf("EXTRACT_DIR="));
      const before = places.calls().length;
      const fetched = check("private-fetch-back", listed, downloads);
      expect(fetched.status, fetched.stderr).toBe(0);
      const back = join(temp, "recorded-verify");
      for (const [name, sha256] of Object.entries(files))
        expect(shaOf(readFileSync(join(back, name))), name).toBe(sha256);
      // It only downloaded: one call per listed file, each of it and its sidecar.
      expect(places.calls().slice(before)).toEqual(
        Object.keys(files).map((name) => [
          "release",
          "download",
          tag,
          "--repo",
          recordRepository,
          "--pattern",
          name,
          "--pattern",
          `${name}.sha256`,
          "--dir",
          back,
        ]),
      );
      // A copy that is not the uploaded file fails the check, even with a
      // sidecar that matches it.
      places.seed(recordRepository, tag, source, {
        [deb]: "swapped",
        [`${deb}.sha256`]: `${shaOf("swapped")}  ${deb}\n`,
      });
      const differs = check("private-fetch-back", listed, downloads);
      expect(differs.status).not.toBe(0);
      expect(differs.stderr).toMatch(
        new RegExp(`The record's ${deb.replaceAll(".", "\\.")} is not the file`),
      );
    });

    it("hands over and records the zip a retry's record already holds", () => {
      const places = standInGh(source);
      places.seed(recordRepository, tag, source, {
        [zipName]: "published first",
        [`${zipName}.sha256`]: `${shaOf("published first")}  ${zipName}\n`,
      });
      const produced = produce({ record: places });
      expect(readFileSync(produced.recorded, "utf8")).toBe("published first");
      expect(produced.job.sha256).toBe(sha(produced.recorded));
      const outputs = succeeded(uploadAfterChecks(produced, consume(produced), places));
      expect(outputs.private).toMatchObject({ sha256: produced.job.sha256, state: "identical" });
      expect(places.published(recordRepository, tag)?.[zipName]).toBe("published first");
      expect(releaseFiles(places, tapRepository, tapTag)?.[zipName]?.toString()).toBe(
        "published first",
      );
    });

    // Published bytes never change, wherever the last attempt stopped: a
    // disk image or Linux package any place holds is the one every place
    // gets, and the recipes beside it are rendered from it.
    it("keeps the disk image and Linux packages any place already holds on a retry", () => {
      const places = standInGh(source);
      places.seed(recordRepository, tag, source, {
        [zipName]: "published first",
        [`${zipName}.sha256`]: `${shaOf("published first")}  ${zipName}\n`,
        [deb]: "deb published first",
      });
      places.seed(tapRepository, tapTag, "f".repeat(40), { [deb]: "deb published first" });
      const produced = produce({ record: places });
      const consumed = consume(produced);
      // The last attempt put its disk image on Cloudflare only, then stopped.
      seedCloudflare(consumed, { [dmgName]: "image published first" });
      const outputs = succeeded(uploadAfterChecks(produced, consumed, places));
      const files = JSON.parse(outputs.files?.files ?? "{}") as Record<string, string>;
      expect(files[dmgName]).toBe(shaOf("image published first"));
      expect(files[deb]).toBe(shaOf("deb published first"));
      expect(files[zipName]).toBe(shaOf("published first"));
      expect(held(releaseFiles(places, recordRepository, tag))[dmgName]).toBe(files[dmgName]);
      for (const repo of [recordRepository, tapRepository, oldTapRepository]) {
        const at = repo === recordRepository ? tag : repo === tapRepository ? tapTag : oldTapTag;
        expect(held(releaseFiles(places, repo, at))[deb], repo).toBe(files[deb]);
        expect(releaseFiles(places, repo, at)?.SHA256SUMS?.toString(), repo).toContain(
          `${files[deb]}  ${deb}`,
        );
      }
      expect(shaOf(cloudflare(consumed)[`releases/v${version}/${deb}`] ?? "")).toBe(files[deb]);
    });

    it("refuses before any upload when two places hold different bytes", () => {
      const places = standInGh(source);
      places.seed(recordRepository, tag, source, { [deb]: "deb from one attempt" });
      places.seed(tapRepository, tapTag, "f".repeat(40), { [deb]: "deb from another" });
      const produced = produce({ record: places });
      const consumed = consume(produced);
      const uploaded = uploadAfterChecks(produced, consumed, places);
      expect(uploaded.results.adopt?.status).not.toBe(0);
      expect(uploaded.results.adopt?.stderr).toMatch(/Two places hold different bytes/);
      expect(uploaded.results.upload).toBeUndefined();
      // Only the record's zip went first; no other place took anything.
      expect(Object.keys(places.published(recordRepository, tag) ?? {}).sort()).toEqual(
        [deb, zipName, `${zipName}.sha256`].sort(),
      );
      expect(Object.keys(releaseFiles(places, tapRepository, tapTag) ?? {})).toEqual([deb]);
      expect(releaseFiles(places, oldTapRepository, oldTapTag)).toBeNull();
      expect(cloudflare(consumed)).toEqual({});
    });

    it("uploads nothing and reads no place in a dry run, and lists what a release would upload", () => {
      const places = standInGh(source);
      const produced = produce({ dryRun: true });
      const consumed = consume(produced);
      const uploaded = uploadAfterChecks(produced, consumed, places);
      const outputs = succeeded(uploaded);
      expect(Object.keys(uploaded.results)).toEqual(["linux-files", "files"]);
      expect(places.calls()).toEqual([]);
      expect(cloudflare(consumed)).toEqual({});
      const files = JSON.parse(outputs.files?.files ?? "{}") as Record<string, string>;
      expect(files[zipName]).toBe(produced.job.sha256);
      expect(files[dmgName]).toBe(sha(produced.dmg));
      expect(Object.keys(files)).toEqual(expect.arrayContaining([...linuxPackages, "SHA256SUMS"]));
    });

    it("refuses a record that changed after the signing job read it, before uploading anything", () => {
      const places = standInGh(source);
      const produced = produce({ record: places });
      const consumed = consume(produced);
      // Another run of this version records its own zip while this one is checked.
      const other = `${shaOf("another run")}  ${zipName}\n`;
      places.seed(recordRepository, tag, source, {
        [zipName]: "another run",
        [`${zipName}.sha256`]: other,
      });
      const uploaded = uploadAfterChecks(produced, consumed, places);
      expect(uploaded.results.private?.status).not.toBe(0);
      expect(uploaded.results.private?.stderr).toMatch(/The record changed since signing/);
      expect(uploaded.outputs.private).toEqual({});
      expect(uploaded.results.adopt).toBeUndefined();
      expect(places.published(recordRepository, tag)).toEqual({
        [zipName]: "another run",
        [`${zipName}.sha256`]: other,
      });
      expect(releaseFiles(places, tapRepository, tapTag)).toBeNull();
      expect(cloudflare(consumed)).toEqual({});
    });

    it("refuses to read a record whose tag names another commit", () => {
      const record = standInGh(source);
      record.seed(recordRepository, tag, "f".repeat(40), { [zipName]: "elsewhere" });
      const temp = scratchDir("infinitary-handoff-signing-");
      const resolve = resolveOutputs();
      const result = run(step("recorded").run ?? "", {
        ...jobEnv("release", resolve),
        ...stepEnv(step("recorded"), { secrets }),
        PATH: `${record.bin}:${process.env.PATH}`,
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: join(temp, "output"),
        GITHUB_REPOSITORY: recordRepository,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/names f{40}, not this release's source/);
    });
  });
});
