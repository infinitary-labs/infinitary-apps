import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { releaseSource } from "../src/core/update/releaseSource";
import { publicTagFor } from "../src/core/update/updateChannels";
import {
  loadYamlFile,
  PUBLICATION_TOKEN,
  PUBLISHES,
  read,
  recordedWorkflowCall,
  root,
  type ChannelStep as Step,
  signedChannel,
  verifyLinuxTests,
  type ChannelWorkflow as Workflow,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";

// INF-2267: portable workflow contracts keep the integration cohort and its isolation;
// native executable and bundle checks remain in the Mac-listed release-contract file.

// Preserve the original release-contract budget; discovery keeps its explicit budget.
vi.setConfig({ testTimeout: 10_000 });

/** What a release packages, publishes and rehearses (release.yml). */

describe("the signed channel workflow", () => {
  const release = loadYamlFile(".github/workflows/release.yml") as Workflow;
  const verify = loadYamlFile(".github/workflows/verify.yml") as Workflow;
  const { jobOf, signingSteps, uploadSteps, publishSteps, steps, step, lanes } = signedChannel(
    release,
    verify,
  );

  it("verifies, packages and publishes one source commit, signs while both lanes run, and starts at the build", () => {
    const resolve = jobOf(release, "resolve");
    // The resolver runs from the workflow's own commit, with every branch and
    // tag, and reads the candidate or the promoted alpha from git.
    expect(resolve.steps?.[0]).toMatchObject({
      uses: "actions/checkout@v4",
      with: { "fetch-depth": 0, "persist-credentials": false },
    });
    expect(resolve.steps?.[0]?.with?.ref).toBeUndefined();
    expect(resolve.steps?.find((candidate) => candidate.id === "resolve")?.run).toBe(
      "scripts/resolve-release.sh",
    );
    // The resolver reads the promoted alpha's run.
    expect(release.permissions.actions).toBe("read");
    const call = jobOf(release, "verify");
    const signing = jobOf(release, "release");
    expect(JSON.stringify(resolve)).not.toContain("secrets.");
    expect(call).toMatchObject({
      needs: ["resolve", "notes", "phone"],
      uses: "./.github/workflows/verify.yml",
      with: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        ref: "${{ needs.resolve.outputs.source_commit }}",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
        profile: "${{ needs.resolve.outputs.channel }}",
      },
    });
    // Nothing verify runs holds a secret.
    expect(call.secrets).toBeUndefined();
    expect(signing.needs).toEqual(["resolve", "notes", "phone"]);
    expect(jobOf(release, "publish").needs).toEqual(expect.arrayContaining(["verify", "linux"]));
    expect(steps[0]).toMatchObject({
      uses: "actions/checkout@v4",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      with: { ref: "${{ needs.resolve.outputs.source_commit }}" },
    });
    // Both profiles run the hosted Linux checks, which publication waits for.
    for (const profile of ["stable", "alpha"]) {
      expect(lanes(profile)).toContain("linux-checks");
      expect(verifyLinuxTests({ profile })).toHaveLength(8);
    }
    // The signing job repeats none of the checks the lanes beside it run:
    // after the install, and the live alpha's read of the tap, it builds.
    const commands = steps.flatMap((candidate) => (candidate.run ? [candidate] : []));
    for (const candidate of commands)
      expect(candidate.run, candidate.name).not.toMatch(
        /\bpnpm (typecheck|check|lint:adherence|test)\b/,
      );
    const afterInstall = commands
      .slice(
        commands.findIndex((candidate) => candidate.run === "pnpm install --frozen-lockfile") + 1,
      )
      .filter((candidate) => !["visibility", "capability"].includes(candidate.id ?? ""));
    expect(afterInstall[0]?.id).toBe("build");
    expect(afterInstall[0]?.run).toBe("pnpm build");
    const firstSecret = steps.findIndex((candidate) =>
      /secrets\.(MAC_DEVELOPER_ID|APP_STORE_CONNECT)/.test(JSON.stringify(candidate)),
    );
    expect(steps[firstSecret]?.name).toBe("Restore App Store Connect API key");
    expect(steps.indexOf(step("build"))).toBeLessThan(firstSecret);
    // Apple signing material stays in the signing job; the uploads and
    // publication hold none.
    for (const id of ["upload", "publish"])
      expect(JSON.stringify(jobOf(release, id)), id).not.toMatch(
        /secrets\.(MAC_DEVELOPER_ID|APP_STORE_CONNECT)|CSC_KEYCHAIN|keychain/,
      );
  });

  it("checks the release notes before anything verifies or signs, and packages exactly that catalog", () => {
    const notes = jobOf(release, "notes");
    const noteSteps = notes.steps ?? [];
    // Declarations only, with no secret and no install: node's type stripping.
    expect(JSON.stringify(notes)).not.toContain("secrets.");
    // The captain asked for release notes to wait until the phone check passes.
    expect(notes.needs).toEqual(["resolve", "phone"]);
    expect(notes.if).not.toContain("always()");
    expect(noteSteps[0]).toMatchObject({
      uses: "actions/checkout@v4",
      with: { "fetch-depth": 0 },
    });
    const check = noteSteps.find(
      (candidate) => candidate.name === "Check the notes cover this release",
    );
    // INF-2259 preserves reviewed manual candidates and stable promotion,
    // while the exact-main route uses the workflow's current notes tooling.
    const input = release.on.workflow_dispatch?.inputs?.candidate;
    expect(input).toMatchObject({ type: "string", required: false });
    const source = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      env: hostEnv(),
      encoding: "utf8",
    }).trim();
    const version = (JSON.parse(read("package.json")) as { version: string }).version;
    const readings = JSON.parse(read("tests/fixtures/verify-runs/2026-10-27.json")) as {
      runs: { conclusion: string; html_url: string }[];
    };
    const proofUrl = readings.runs.find((run) => run.conclusion === "success")!.html_url;
    for (const mode of ["reviewed", "verified-main", "promoted"] as const) {
      const promoted = mode === "promoted";
      const channel = promoted ? "stable" : "alpha";
      const releaseVersion = promoted ? version.split("-")[0]! : version;
      const from = promoted ? publicTagFor(version)! : "";
      const context = {
        needs: {
          resolve: {
            outputs: {
              channel,
              dry_run: "false",
              source_commit: source,
              version: releaseVersion,
              promoted_from: from,
              main_run: mode === "verified-main" ? proofUrl : "",
            },
          },
        },
        inputs: { candidate: mode === "reviewed" ? source : "" },
      };
      const env = Object.fromEntries(
        Object.entries(check!.env!).map(([name, value]) => [name, workflowString(value, context)]),
      );
      expect(env.CANDIDATE).toBe(promoted ? "" : source);
      expect(recordedWorkflowCall(check!.run!, env)).toEqual([
        "node",
        mode === "reviewed"
          ? "scripts/release-notes.ts"
          : ".release-tooling/scripts/release-notes.ts",
        "check",
        "--source",
        source,
        "--channel",
        channel,
        "--version",
        releaseVersion,
        ...(promoted ? ["--promoted-from", from] : [`--${mode}`, source]),
        "--repo",
        ".",
      ]);
    }
    // Neither verification nor signing starts without it.
    expect(jobOf(release, "verify").needs).toContain("notes");
    expect(jobOf(release, "release").needs).toContain("notes");
    // A failed phone check stops the Linux packages and desktop checks too (INF-3059).
    expect(jobOf(release, "verify").needs).toContain("phone");
    expect(jobOf(release, "linux").needs).toContain("phone");
    // The signing job packages the notes job's catalog and verifies the
    // packaged copy's identity before notarizing, signing-gate checks or launch.
    const order = steps.map((candidate) => candidate.id ?? candidate.name);
    const place = order.indexOf("Place the release notes catalog");
    expect(place).toBeGreaterThan(order.indexOf("build"));
    expect(place).toBeLessThan(order.indexOf("package"));
    expect(order.indexOf("packaged-notes")).toBeGreaterThan(order.indexOf("package"));
    expect(order.indexOf("packaged-notes")).toBeLessThan(order.indexOf("signed-app"));
    expect(step("packaged-notes").run).toContain("verify-package");
    expect(step("packaged-notes").run).toContain("Contents/Resources/release-notes.json");
    // The hero pictures travel with the catalog: generated into one folder,
    // kept as one artifact, and placed where electron-builder ships them.
    const generate = noteSteps.find(
      (candidate) => candidate.name === "Generate the offline catalog",
    );
    expect(generate?.run).toContain('--out "$RUNNER_TEMP/release-notes/release-notes.json"');
    const keep = noteSteps.find((candidate) => candidate.name === "Keep the catalog for packaging");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    expect(keep?.with?.path).toBe("${{ runner.temp }}/release-notes/");
    const placed = steps.find((candidate) => candidate.name === "Place the release notes catalog");
    expect(placed?.run).toContain("packaging/generated/release-notes.json");
    expect(placed?.run).toContain("packaging/generated/release-notes/pictures");
  });

  // The captain's checked fix (INF-2674, "Split a release's notes job into its two parts, run side by side"):
  // the coverage check and the catalog each walk the full history, so they run as parallel parts.
  it("runs the notes check and the catalog as two parts side by side, each step on its own part", () => {
    const notes = jobOf(release, "notes");
    expect(notes.strategy?.matrix).toEqual({ part: ["check", "catalog"] });
    // Neither part waits for the other: no step of one needs the other's output.
    const steps = notes.steps ?? [];
    const partOf = (name: string) => steps.find((candidate) => candidate.name === name)?.if ?? "";
    expect(partOf("Check the notes cover this release")).toContain("matrix.part == 'check'");
    for (const name of [
      "Generate the offline catalog",
      "Write the picked highlights",
      "Keep the catalog for packaging",
    ]) {
      expect(partOf(name), name).toContain("matrix.part == 'catalog'");
    }
    // Both parts walk the history themselves and name themselves apart.
    expect(steps[0]).toMatchObject({ with: { "fetch-depth": 0 } });
    const names = ["check", "catalog"].map((part) =>
      workflowString((notes as { name?: string }).name as string, {
        needs: { resolve: { outputs: { trigger: "Requested alpha" } } },
        matrix: { part },
      }),
    );
    expect(new Set(names).size).toBe(2);
  });

  it("writes a stable's picked highlights with the workflow's own tooling, after the alpha's catalog and before it is kept", () => {
    const input = release.on.workflow_dispatch?.inputs?.highlights;
    expect(input).toMatchObject({ type: "string", required: false });
    const resolveStep = (jobOf(release, "resolve").steps ?? []).find(
      (candidate) => candidate.id === "resolve",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    expect(resolveStep?.env?.HIGHLIGHTS).toBe("${{ inputs.highlights }}");
    const noteSteps = jobOf(release, "notes").steps ?? [];
    const order = noteSteps.map((candidate) => candidate.name);
    const tooling = noteSteps.find(
      (candidate) => candidate.name === "Check out the workflow's own notes tooling",
    );
    const write = noteSteps.find((candidate) => candidate.name === "Write the picked highlights");
    // The promoted alpha's commit may predate the pick, so it comes from the
    // workflow's own commit, beside the source checkout.
    expect(tooling).toMatchObject({
      uses: "actions/checkout@v4",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      with: { ref: "${{ github.sha }}", path: ".release-tooling" },
    });
    expect(write?.run).toContain(
      'node .release-tooling/scripts/release-notes.ts stable-highlights --repo . --catalog "$CATALOG" --picks "$HIGHLIGHTS"',
    );
    // The alpha's own check then proves its app reads the result.
    expect(write?.run).toMatch(
      /\nnode scripts\/release-notes\.ts verify-package --catalog "\$CATALOG"/,
    );
    expect(order.indexOf("Write the picked highlights")).toBeGreaterThan(
      order.indexOf("Generate the offline catalog"),
    );
    expect(order.indexOf("Write the picked highlights")).toBeLessThan(
      order.indexOf("Keep the catalog for packaging"),
    );
    // Both run only for picks; without them the catalog is the alpha's as generated.
    for (const step of [tooling, write])
      for (const [highlights, runs] of [
        ["lead-change,second-change,third-change", true],
        ["", false],
      ] as const)
        expect(
          workflowValue(step?.if ?? "", {
            needs: { resolve: { outputs: { highlights } } },
            matrix: { part: "catalog" },
          }),
        ).toBe(runs);
  });

  it("never cancels a real release, and gives a rehearsal its own group", () => {
    const group = (inputs: Record<string, unknown>, runId: string) =>
      workflowString(release.concurrency.group, {
        inputs,
        github: { ref_name: "main", run_id: runId },
      });
    const cancels = (inputs: Record<string, unknown>) =>
      workflowValue(release.concurrency["cancel-in-progress"], { inputs });
    // Real releases: a stable promotion and an alpha's candidate, both requested from main.
    const candidate = "c".repeat(40);
    for (const [inputs, runId] of [
      [{ channel: "stable", promote: "1.2.3-alpha.13", dry_run: false }, "101"],
      [{ channel: "alpha", candidate, dry_run: false }, "102"],
    ] as const) {
      expect(group(inputs, runId)).toBe(`release-${runId}`);
      expect(cancels(inputs)).toBe(false);
    }
    // Rehearsals: one group per channel and what it builds, a newer one replacing an older.
    expect(group({ channel: "alpha", dry_run: true }, "103")).toBe("release-dry-run-alpha-main");
    expect(group({ channel: "alpha", candidate, dry_run: true }, "104")).toBe(
      `release-dry-run-alpha-${candidate}`,
    );
    expect(group({ channel: "stable", promote: "1.2.3-alpha.13", dry_run: true }, "105")).toBe(
      "release-dry-run-stable-1.2.3-alpha.13",
    );
    expect(cancels({ channel: "alpha", dry_run: true })).toBe(true);
    // Verify inside a release belongs to that run; a request's own group is
    // tests/workflow-request-groups.test.ts's (INF-3380).
    const verifyGroup = (workflow: string, inputs: Record<string, unknown>) =>
      workflowString(verify.concurrency.group, {
        github: { workflow, ref: "refs/heads/main", run_id: "77", run_attempt: "1" },
        inputs,
      });
    const verifyCancels = (workflow: string) =>
      workflowValue(verify.concurrency["cancel-in-progress"], { github: { workflow } });
    expect(verifyGroup("release", { ref: "c".repeat(40), profile: "alpha" })).toBe("verify-77-1");
    expect(verifyCancels("release")).toBe(false);
  });

  // INF-2259 preserves manual defaults and adds optional exact-main recovery.
  // INF-3738: an automatic alpha is a dispatch from main's check too, naming
  // its run, since GitHub starts no completion trigger for the queue's merges.
  it("retains manual release inputs beside the automatic alpha's main run", () => {
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(release.on.workflow_dispatch?.inputs ?? {})).toEqual([
      "channel",
      "candidate",
      "verified_main_run",
      "promote",
      "highlights",
      "dry_run",
      "main_run",
      "main_run_number",
    ]);
    for (const input of [
      "candidate",
      "verified_main_run",
      "promote",
      "highlights",
      "main_run",
      "main_run_number",
    ])
      expect(release.on.workflow_dispatch?.inputs?.[input]).toMatchObject({
        type: "string",
        required: false,
      });
    expect(release.on.workflow_dispatch?.inputs?.channel).toMatchObject({
      type: "choice",
      options: ["stable", "alpha"],
      default: "stable",
    });
    expect(release.on.workflow_dispatch?.inputs?.dry_run).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(verify.on.workflow_call?.inputs?.profile?.default).toBe("stable");
    expect(verify.on.workflow_dispatch?.inputs?.profile).toMatchObject({ default: "stable" });
  });

  /**
   * The steps of a passing run of a channel, live or rehearsed, in order:
   * the signing job's, then the upload job's and the publication job's when
   * each starts after them.
   */
  const ranSteps = (channel: string, dryRun: boolean, oldCask = false, direct = true) => {
    const needs = {
      resolve: {
        result: "success",
        outputs: {
          channel,
          dry_run: String(dryRun),
          old_cask: String(oldCask),
          release_repository: releaseSource.repository,
          verify_required: "true",
        },
      },
      notes: { result: "success" },
      verify: { result: "success" },
      linux: { result: "success" },
      phone: { result: "success" },
      // The signing job hands on what its visibility step chose.
      release: { result: "success", outputs: { direct: String(dryRun ? false : direct) } },
      update: { result: "success" },
    };
    const ran = (jobSteps: Step[]) =>
      jobSteps.filter(
        (candidate) =>
          candidate.if === undefined ||
          workflowValue(candidate.if, {
            needs,
            github: { repository: releaseSource.repository },
            steps: Object.fromEntries(
              jobSteps.flatMap((each) =>
                each.id
                  ? [[each.id, { outcome: "success", outputs: { direct: String(direct) } }]]
                  : [],
              ),
            ),
          }) === true,
      );
    const uploads = workflowValue(jobOf(release, "upload").if ?? "", { needs }) === true;
    const publishes =
      uploads &&
      workflowValue(jobOf(release, "publish").if ?? "", {
        needs: { ...needs, upload: { result: "success" } },
      }) === true;
    return [
      ...ran(signingSteps),
      ...(uploads ? ran(uploadSteps) : []),
      ...(publishes ? ran(publishSteps) : []),
    ];
  };

  it.each(["stable", "alpha"])("rehearses %s's whole profile and publishes nothing", (channel) => {
    const ran = ranSteps(channel, true);
    for (const candidate of ran) {
      expect(candidate.run ?? "", candidate.name).not.toMatch(PUBLISHES);
      if (candidate.id !== "feed-rehearsal")
        expect(JSON.stringify(candidate.env ?? {}), candidate.name).not.toMatch(PUBLICATION_TOKEN);
    }
    expect(ran.map((candidate) => candidate.id ?? candidate.name)).toEqual(
      expect.arrayContaining([
        "build",
        "package",
        "signed-app",
        "launch",
        "data-folder",
        "notarize",
        "zip",
        "checksum",
        "dmg",
        "handoff",
        "handoff-upload",
        "handoff-check",
        "linux-files",
        "files",
        "Summarize the uploads",
        "expected",
        "rehearsal-files",
        "tap-rehearsal",
        "old-tap-rehearsal",
        "feed-rehearsal",
        "Keep the rehearsed release metadata",
        "Summarize",
        "Summarize the publication",
      ]),
    );
    // A rehearsal uploads nothing and reads no place.
    const ids = ran.map((candidate) => candidate.id ?? candidate.name);
    for (const id of ["private", "adopt", "upload"]) expect(ids).not.toContain(id);
    expect(ids.filter((id) => /fetch-back$/.test(id ?? ""))).toEqual([]);
    // A rehearsal's feeds are written from the checked image it handed over,
    // once the virtual Mac checked it against what the upload job listed.
    expect(step("feed-rehearsal").env).toMatchObject({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      DIST_ZIP: "${{ steps.rehearsal-files.outputs.zip }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
      DIST_DMG: "${{ steps.rehearsal-files.outputs.dmg }}",
    });
    expect(ids.indexOf("rehearsal-files")).toBeLessThan(ids.indexOf("tap-rehearsal"));
    // The feed rehearsal may read a not-yet-public repository, but cannot publish.
    expect(step("feed-rehearsal").run).toContain("scripts/publish-feeds.sh rehearsal");
    // electron-builder never publishes on its own either.
    expect(step("package").run).toContain("--publish never");
  });

  it.each(["stable", "alpha"])(
    "publishes %s through both Homebrew and direct feeds only after their downloads verify",
    (channel) => {
      // INF-1613: exercise both configured storage and the approved Homebrew/Linux-only fallback.
      for (const direct of [false, true]) {
        const ran = ranSteps(channel, false, false, direct).map(
          (candidate) => candidate.id ?? candidate.name,
        );
        // INF-2498's plan, piece 2: the record takes the zip first, every
        // place is read, then every place is uploaded to at once; the virtual
        // Mac fetches back and checks every copy before any switch.
        const publication = [
          "private",
          "adopt",
          "upload",
          "files",
          "expected",
          "private-fetch-back",
          ...(direct ? ["public-fetch-back"] : []),
          "homebrew-fetch-back",
          "tap",
          ...(direct ? ["feeds"] : []),
        ];
        expect(
          ran.filter((id) => publication.includes(id ?? "") || /fetch-back$/.test(id ?? "")),
        ).toEqual(publication);
        expect(ran.indexOf("visibility")).toBeLessThan(ran.indexOf("developer_id_cert"));
        // INF-2074: the signing job reads the record before its image and
        // records nothing; the upload job records after every check.
        expect(ran.indexOf("recorded")).toBeGreaterThan(ran.indexOf("checksum"));
        expect(ran.indexOf("private")).toBeGreaterThan(ran.indexOf("linux-files"));
        if (direct) {
          expect(ran.indexOf("dmg")).toBeGreaterThan(ran.indexOf("recorded"));
          expect(ran.indexOf("dmg")).toBeLessThan(ran.indexOf("adopt"));
        } else {
          expect(ran).not.toContain("dmg");
        }
        for (const rehearsal of ["rehearsal-files", "tap-rehearsal", "feed-rehearsal"])
          expect(ran).not.toContain(rehearsal);
        // The signing job ends after the image and its handoff; the upload
        // job starts by validating that handoff, before any effect.
        expect(ran.indexOf("handoff")).toBeGreaterThan(ran.indexOf(direct ? "dmg" : "recorded"));
        expect(ran.indexOf("handoff-check")).toBeGreaterThan(ran.indexOf("handoff-upload"));
        expect(ran.indexOf("handoff-check")).toBeLessThan(ran.indexOf("private"));
      }
      expect(JSON.stringify(step("public-fetch-back").env ?? {})).not.toContain("secrets.");
      // Every place gets the record's zip and the disk image the places
      // already hold, or this attempt's; the virtual Mac checks each copy
      // against the upload job's list and the signing job's zip.
      expect(step("upload").env?.ZIP).toBe("${{ steps.private.outputs.zip }}");
      expect(step("upload").env?.DMG).toBe("${{ steps.adopt.outputs.dmg }}");
      expect(step("expected").env?.FILES).toBe("${{ needs.upload.outputs.files }}");
      expect(step("expected").env?.ZIP_SHA256).toBe("${{ needs.release.outputs.sha256 }}");
      expect(
        steps
          .filter(
            (candidate) =>
              PUBLISHES.test(candidate.run ?? "") ||
              PUBLICATION_TOKEN.test(JSON.stringify(candidate.env ?? {})),
          )
          .map((candidate) => candidate.id),
      ).toEqual([
        "visibility",
        "recorded",
        "private",
        "adopt",
        "upload",
        "private-fetch-back",
        "tap",
        "old-tap",
        "feeds",
      ]);
    },
  );

  it.each(["stable", "alpha"])(
    "keeps %s old-cask publication gated by explicit channel activation",
    (channel) => {
      // Revised INF-643: retain both paths, including the already-activated old-cask bridge.
      const inactive = ranSteps(channel, false, false).map((step) => step.id);
      const active = ranSteps(channel, false, true).map((step) => step.id);
      for (const id of ["old-public-fetch-back", "old-tap"]) {
        expect(inactive).not.toContain(id);
        expect(active).toContain(id);
      }
      expect(active.indexOf("old-public-fetch-back")).toBeGreaterThan(active.indexOf("upload"));
      expect(active.indexOf("old-tap")).toBeGreaterThan(active.indexOf("old-public-fetch-back"));
      expect(active.indexOf("old-tap")).toBeGreaterThan(active.indexOf("tap"));
      for (const id of ["homebrew-fetch-back", "old-public-fetch-back"])
        expect(JSON.stringify(step(id).env)).not.toContain("secrets.");
      expect(step("tap").env?.DOWNLOAD_URL).toBe("${{ needs.resolve.outputs.download_url }}");
      expect(step("old-tap").env?.DOWNLOAD_URL).toBe(
        "${{ needs.resolve.outputs.old_download_url }}",
      );
    },
  );

  it("packages the logical version as the app's metadata and its numeric core as both bundle fields", () => {
    const packaging = step("package").run ?? "";
    expect(packaging).toContain('-c.extraMetadata.version="$VERSION"');
    expect(packaging).toContain('-c.mac.bundleShortVersion="$BUNDLE_VERSION"');
    expect(packaging).toContain('-c.mac.bundleVersion="$BUNDLE_VERSION"');
    // Every launch gate holds the app to the logical version: the gate reads
    // both fields as its numeric core and asks the running app for the rest.
    const launches = steps.flatMap((candidate) =>
      [...(candidate.run ?? "").matchAll(/scripts\/check-app-launch\.sh "[^"]+" "([^"]+)"/g)].map(
        (match) => match[1],
      ),
    );
    const launchStages = [
      "launch",
      "zip",
      "private-fetch-back",
      "public-fetch-back",
      "homebrew-fetch-back",
    ];
    expect(launches).toEqual(launchStages.map(() => "$VERSION"));
    for (const id of launchStages) expect(step(id).run).toContain("scripts/check-app-launch.sh");
  });

  it("launches the app only through the workflow's own launch gate, after packaging", () => {
    // INF-1768: a stable checks out an older alpha's commit, whose scripts
    // call the gate beside them, so a repair to the gate reaches that
    // release only when the workflow puts its own copy there first.
    const gate = ["scripts/check-app-launch.sh", "scripts/app-runtime-version.mjs"];
    const launches = (candidate: Step) =>
      /(^|\s)scripts\/(check-app-launch|verify-mac-dmg)\.sh /m.test(candidate.run ?? "");
    // A rehearsal's publication job fetches the Linux packages through the
    // workflow's own package check too (INF-2879; tests/linux-package-sums.test.ts).
    const packageCheck = [".github/actions/linux-packages/", "scripts/linux-package-sums.ts"];
    // The signing job's package step reads Electron's zips through the
    // workflow's own reader, which that older commit may predate, after the
    // alpha run 42464772458 failed on a 504 from GitHub's release server
    // (tests/ensure-electron-installed.test.ts runs the step).
    const zipsReader = ".github/actions/electron-download/zips.mjs";
    // Both of its notarizations, the app's and the disk image's, go through
    // the workflow's own scripts/notarize.ts, which recovers from a dropped
    // connection to Apple, after the alpha run 43170881035 lost its disk
    // image's upload to a connect timeout (tests/installer-notarize.test.ts).
    const notarizer = "scripts/notarize.ts";
    // The publish job's install restores Electron's and git's downloads
    // through the workflow's own action as well, which an older alpha's
    // commit may predate (docs/testing.md, "Downloads from GitHub's release
    // server").
    const downloads = [".github/actions/electron-download/"];
    // Its keyless fetch-backs go through the workflow's own fetcher, which an
    // older alpha's commit predates (INF-3224; tests/release-workflows-handoff.test.ts).
    const fetcher = "scripts/fetch-without-credential.sh";
    for (const [job, jobSteps, tooling] of [
      ["release", signingSteps, [...gate, notarizer, zipsReader]],
      ["publish", publishSteps, [...gate, ...packageCheck, ...downloads, fetcher]],
    ] as const) {
      const fetched = jobSteps.findIndex(
        (candidate) => candidate.with?.path === ".release-tooling",
      );
      expect(jobSteps[fetched]?.uses, job).toBe("actions/checkout@v4");
      expect(jobSteps[fetched]?.with?.ref, job).toBe("${{ github.sha }}");
      expect(String(jobSteps[fetched]?.with?.["sparse-checkout"]).trim().split("\n"), job).toEqual(
        tooling,
      );
      const placed = jobSteps.findIndex(
        (candidate) =>
          candidate.run ===
          `cp ${gate.map((file) => `.release-tooling/${file}`).join(" ")} scripts/`,
      );
      expect(placed, job).toBeGreaterThan(fetched);
      // Both run in every profile, before the job's first launch.
      expect([jobSteps[fetched]?.if, jobSteps[placed]?.if], job).toEqual([undefined, undefined]);
      expect(jobSteps.findIndex(launches), job).toBeGreaterThan(placed);
    }
    // The app it launches is the source's, packaged before the gate moves in,
    // with the workflow's own zips reader checked out before it packages.
    const packaged = signingSteps.findIndex((candidate) => candidate.id === "package");
    expect(signingSteps.findIndex((candidate) => candidate.id === "launch-gate")).toBeGreaterThan(
      packaged,
    );
    expect(signingSteps[packaged]?.run).toContain(`node .release-tooling/${zipsReader} `);
    expect(
      signingSteps.findIndex((candidate) => candidate.with?.path === ".release-tooling"),
    ).toBeLessThan(packaged);
    const notarizes = signingSteps.filter((candidate) =>
      /notarytool|stapler/.test(candidate.run ?? ""),
    );
    expect(notarizes.map((candidate) => candidate.id)).toEqual([]);
    for (const id of ["notarize", "dmg"])
      expect(signingSteps.find((candidate) => candidate.id === id)?.run, id).toContain(
        `node .release-tooling/${notarizer} `,
      );
  });
});
