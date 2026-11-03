import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { data, Evaluator, Lexer, Parser } from "@actions/expressions";
import { describe, expect, it } from "vitest";
import {
  type AppleRead,
  appleCredentials,
  appleReader,
  buildNumber,
  checkReady,
  findPhoneApp,
  PHONE,
  readBuild,
  releaseVersion,
  resolveRelease,
  waitForBuild,
} from "../scripts/phone-release";
import { workflowString, workflowValue } from "./helpers/releaseWorkflows";

// INF-64 piece 3 / INF-80: a supplied version reaches TestFlight only after the
// phone gates; bad inputs, unreadable Apple state and failed uploads never mean delivery.
const releaseEnv = {
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "54d835d17f2baa056c3899f7ad93f20e96756b1a",
  GITHUB_RUN_NUMBER: "42",
  GITHUB_RUN_ATTEMPT: "1",
  PHONE_VERSION: "0.1.0",
};
const app = {
  type: "apps",
  id: "1234567890",
  attributes: { name: "Infinitary", bundleId: PHONE.bundle },
};
const bundle = { type: "bundleIds", id: "AB123CDE45", attributes: { identifier: PHONE.bundle } };
const group = {
  type: "betaGroups",
  id: "group-1",
  attributes: { isInternalGroup: true, hasAccessToAllBuilds: true },
};
const tester = { type: "betaTesters", id: "tester-1", attributes: { state: "ACCEPTED" } };
function readiness(
  overrides: Partial<Record<"apps" | "bundleIds" | "betaGroups" | "betaTesters", unknown[]>> = {},
): AppleRead {
  return async (path) => {
    const kind = path.split("?")[0]?.split("/").at(-1) ?? "";
    const lists = {
      apps: [app],
      bundleIds: [bundle],
      betaGroups: [group],
      betaTesters: [tester],
      ...overrides,
    };
    return { data: lists[kind as keyof typeof lists] as never[] };
  };
}
function buildPage(
  processingState = "VALID",
  internalBuildState = "IN_BETA_TESTING",
  version = releaseEnv.PHONE_VERSION,
) {
  return {
    data: [
      {
        type: "builds",
        id: "build-42",
        attributes: { version: "42.2", processingState, expired: false },
        relationships: {
          preReleaseVersion: { data: { type: "preReleaseVersions", id: "pre-1" } },
          buildBetaDetail: { data: { type: "buildBetaDetails", id: "beta-1" } },
        },
      },
    ],
    included: [
      { type: "preReleaseVersions", id: "pre-1", attributes: { version, platform: "IOS" } },
      { type: "buildBetaDetails", id: "beta-1", attributes: { internalBuildState } },
    ],
  };
}

describe("the accepted flat phone icon", () => {
  it("packages a 1024px RGB image with no alpha channel, rather than the padded desktop icon", () => {
    const folder = "ios/Infinitary/InfinitaryApp/Assets.xcassets/AppIcon.appiconset";
    const catalog = JSON.parse(readFileSync(`${folder}/Contents.json`, "utf8"));
    const icon = readFileSync(`${folder}/${catalog.images[0].filename}`);
    expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([icon.readUInt32BE(16), icon.readUInt32BE(20), icon[24], icon[25]]).toEqual([
      1024, 1024, 8, 2,
    ]);
    const compressed: Buffer[] = [];
    for (let offset = 8; offset < icon.length; ) {
      const size = icon.readUInt32BE(offset);
      const kind = icon.subarray(offset + 4, offset + 8).toString();
      expect(kind).not.toBe("tRNS");
      if (kind === "IDAT") compressed.push(icon.subarray(offset + 8, offset + 8 + size));
      offset += size + 12;
    }
    expect(inflateSync(Buffer.concat(compressed))).toHaveLength(1024 * (1 + 1024 * 3));
  });
});

describe("versioned phone delivery", () => {
  it("keeps the requested phone version apart from the Mac version and fixes the build on the first attempt", () => {
    expect(resolveRelease(releaseEnv)).toEqual({
      version: "0.1.0",
      build_number: "42.1",
      source_commit: releaseEnv.GITHUB_SHA,
      mode: "release",
    });
    expect(
      resolveRelease({ ...releaseEnv, GITHUB_RUN_ATTEMPT: "2", CHECK_BUILD: "41.1" }),
    ).toMatchObject({
      build_number: "41.1",
      mode: "status",
    });
    expect(releaseVersion("12.34.56")).toBe("12.34.56");
    expect(buildNumber("9999.99")).toBe("9999.99");
  });
  it.each([
    "",
    "v1.2.3",
    "1.2",
    "1.2.3-alpha.1",
    "01.2.3",
    "1.2.3\n",
    "1.2.3; echo unsafe",
    "-1.2.3",
  ])("refuses version %j before using release credentials", (value) => {
    expect(() => releaseVersion(value)).toThrow();
  });
  it.each(["0.1", "10000.1", "1.100", "01.1", "1.0", "1.1\n"])(
    "refuses build %j rather than making an invalid Apple build",
    (value) => {
      expect(() => buildNumber(value)).toThrow();
    },
  );
  it("refuses unmerged branches, other events and an unspecified source", () => {
    for (const env of [
      { GITHUB_REF: "refs/heads/topic" },
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_SHA: "main" },
      { GITHUB_RUN_ATTEMPT: "2" },
    ]) {
      expect(() => resolveRelease({ ...releaseEnv, ...env })).toThrow();
    }
  });
});

describe("Apple readiness and receipt readings", () => {
  it("requires the exact Infinitary record and a populated, automatic internal group", async () => {
    expect(await checkReady(readiness())).toEqual({ app: app.id, readyGroups: 1 });
    await expect(findPhoneApp(readiness({ apps: [] }))).rejects.toThrow("Create the Infinitary");
    await expect(
      findPhoneApp(
        readiness({ apps: [{ ...app, attributes: { ...app.attributes, name: "Other app" } }] }),
      ),
    ).rejects.toThrow("Rename");
    await expect(checkReady(readiness({ bundleIds: [] }))).rejects.toThrow("Register");
    for (const changed of [
      { betaGroups: [{ ...group, attributes: { ...group.attributes, isInternalGroup: false } }] },
      {
        betaGroups: [
          { ...group, attributes: { ...group.attributes, hasAccessToAllBuilds: false } },
        ],
      },
      { betaTesters: [] },
      { betaTesters: [{ ...tester, attributes: { state: "REVOKED" } }] },
    ])
      await expect(checkReady(readiness(changed))).rejects.toThrow("add yourself");
  });
  it("selects exact identifiers from Apple's prefix matches and still refuses missing or ambiguous records", async () => {
    // INF-227 F5: Apple can return extension/development identifiers before the app itself.
    const otherApp = {
      ...app,
      id: "1234567891",
      attributes: { name: "Infinitary Development", bundleId: `${PHONE.bundle}.dev` },
    };
    const otherBundle = {
      ...bundle,
      id: "AB123CDE46",
      attributes: { identifier: `${PHONE.bundle}.dev` },
    };
    expect(
      await checkReady(readiness({ apps: [otherApp, app], bundleIds: [otherBundle, bundle] })),
    ).toEqual({ app: app.id, readyGroups: 1 });
    await expect(findPhoneApp(readiness({ apps: [otherApp] }))).rejects.toThrow(
      "Create the Infinitary",
    );
    await expect(checkReady(readiness({ bundleIds: [otherBundle] }))).rejects.toThrow("Register");
    await expect(
      findPhoneApp(readiness({ apps: [app, { ...app, id: otherApp.id }] })),
    ).rejects.toThrow("Create the Infinitary");
    await expect(
      checkReady(readiness({ bundleIds: [bundle, { ...bundle, id: otherBundle.id }] })),
    ).rejects.toThrow("Register");
  });
  // Apple: https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/
  // Invitation email waits for a build. Requiring acceptance here deadlocks a first delivery.
  it.each(["NOT_INVITED", "INVITED", "ACCEPTED", "INSTALLED"])(
    "allows the first upload with a configured tester in state %s",
    async (state) => {
      const ready = await checkReady(
        readiness({ betaTesters: [{ ...tester, attributes: { state } }] }),
      );
      expect(ready.readyGroups).toBe(1);
    },
  );
  it("reads subsequent tester pages instead of treating the first invitation as the whole group", async () => {
    const base = readiness();
    const read: AppleRead = (path) => {
      if (path.includes("betaTesters"))
        return Promise.resolve({
          data: [],
          links: { next: "https://api.appstoreconnect.apple.com/v1/testers-page-two" },
        });
      if (path.includes("testers-page-two")) return Promise.resolve({ data: [tester] });
      return base(path);
    };
    expect((await checkReady(read)).readyGroups).toBe(1);
  });
  it("waits for the exact version and build to reach internal testing, not just upload or processing", async () => {
    const pages = [
      { data: [] },
      buildPage("PROCESSING"),
      buildPage("VALID", "READY_FOR_BETA_TESTING"),
      buildPage(),
    ];
    const reads: string[] = [];
    let pauses = 0;
    const result = await waitForBuild(
      async (path) => {
        reads.push(path);
        const page = pages.shift();
        if (!page) throw new Error("Unexpected extra Apple read");
        return page;
      },
      app.id,
      "0.1.0",
      "42.2",
      async () => {
        pauses++;
      },
      4,
    );
    expect(result.state).toBe("ready");
    expect(pauses).toBe(3);
    expect(
      reads.every(
        (path) => path.includes("filter[app]=1234567890") && path.includes("filter[version]=42.2"),
      ),
    ).toBe(true);
    expect(
      (
        await readBuild(
          async () => buildPage("VALID", "IN_BETA_TESTING", "0.2.0"),
          app.id,
          "0.1.0",
          "42.2",
        )
      ).state,
    ).not.toBe("ready");
  });
  it("keeps uncertain upload outcomes distinct from failure and refuses unknown or rejected Apple states", async () => {
    await expect(
      waitForBuild(
        async () => ({ data: [] }),
        app.id,
        "0.1.0",
        "42.2",
        async () => {},
        1,
      ),
    ).rejects.toThrow("check_build 42.2");
    for (const page of [
      buildPage("FAILED"),
      buildPage("INVALID"),
      buildPage("SURPRISE"),
      buildPage("VALID", "MISSING_EXPORT_COMPLIANCE"),
      buildPage("VALID", "SURPRISE"),
    ]) {
      await expect(readBuild(async () => page, app.id, "0.1.0", "42.2")).rejects.toThrow();
    }
    const incomplete = buildPage();
    incomplete.included = [];
    await expect(readBuild(async () => incomplete, app.id, "0.1.0", "42.2")).rejects.toThrow(
      "version identity",
    );
    const expired = buildPage();
    const first = expired.data[0];
    if (!first) throw new Error("Missing build fixture");
    first.attributes.expired = true;
    await expect(readBuild(async () => expired, app.id, "0.1.0", "42.2")).rejects.toThrow(
      "expired",
    );
  });
  it("signs bounded, read-only Apple requests without disclosing the key or following another host", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const env = {
      APP_STORE_CONNECT_KEY_ID: "A1B2C3D4E5",
      APP_STORE_CONNECT_ISSUER_ID: "11111111-2222-3333-4444-555555555555",
      APP_STORE_CONNECT_API_KEY: Buffer.from(
        privateKey.export({ format: "pem", type: "pkcs8" }),
      ).toString("base64"),
    };
    let calls = 0;
    const read = appleReader(env, (async (input, init) => {
      calls++;
      expect(String(input)).toBe("https://api.appstoreconnect.apple.com/v1/apps");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      const bearer = new Headers(init?.headers).get("Authorization") ?? "";
      const [header, payload, signature] = bearer.slice("Bearer ".length).split(".");
      expect(
        verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature ?? "", "base64url"),
        ),
      ).toBe(true);
      const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
      // Apple's ordinary API-token lifetime limit, not our chosen shorter lifetime.
      expect(claims.exp).toBeGreaterThan(claims.iat);
      expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);
      expect(claims.aud).toBe("appstoreconnect-v1");
      return new Response(JSON.stringify({ data: [app] }));
    }) as typeof fetch);
    expect((await read("/v1/apps")).data).toEqual([app]);
    await expect(read("https://another.example/v1/apps")).rejects.toThrow("pagination");
    expect(calls).toBe(1);
    expect(() => appleCredentials({ ...env, APP_STORE_CONNECT_API_KEY: "not a key" })).toThrow(
      "base64-encoded",
    );
    const refused = appleReader(
      env,
      (async () =>
        new Response("a server error containing private details", { status: 403 })) as typeof fetch,
    );
    await expect(refused("/v1/apps")).rejects.toThrow("HTTP 403");
  });
});

// Workflow expressions are exercised with the same reader as the release contracts.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
const workflow = yaml.load(readFileSync(".github/workflows/ios-release.yml", "utf8"));
function eligible(
  expression: string | undefined,
  contexts: Record<string, unknown>,
  success = true,
  cancelled = false,
) {
  const status = { success, cancelled, failure: !success, always: true };
  const functions = Object.entries(status).map(([name, value]) => ({
    name,
    minArgs: 0,
    maxArgs: 0,
    call: () => new data.BooleanData(value),
  }));
  // GitHub inserts success() unless a condition names a status function.
  const raw = (expression ?? "success()").replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const condition = /\b(success|failure|cancelled|always)\(/.test(raw)
    ? raw
    : `success() && (${raw})`;
  const ast = new Parser(
    new Lexer(condition).lex().tokens,
    Object.keys(contexts),
    functions,
  ).parse();
  return (
    new Evaluator(
      ast,
      JSON.parse(JSON.stringify(contexts), data.reviver),
      new Map(functions.map((fn) => [fn.name, fn])),
    )
      .evaluate()
      .coerceString() === "true"
  );
}

describe("the dispatched workflow's gate", () => {
  it("runs no host signing after either unsigned device fails or is cancelled (INF-2202)", () => {
    const job = workflow.jobs.testflight;
    expect(job.needs).toEqual(["resolve", "phone"]);
    const upload = job.steps.find((step: { id?: string }) => step.id === "upload");
    const executeGate = (phone: string, failed?: string) => {
      const needs = {
        resolve: { result: "success", outputs: { mode: "release" } },
        phone: { result: phone },
      };
      if (
        !eligible(
          job.if,
          { needs },
          job.needs.every((id: keyof typeof needs) => needs[id].result === "success"),
        )
      )
        return [];
      const ran: string[] = [];
      const steps: Record<string, { outcome: string }> = {};
      let success = true;
      for (const step of job.steps.filter((item: { id?: string }) => item.id)) {
        if (!eligible(step.if, { steps }, success)) {
          steps[step.id] = { outcome: "skipped" };
          continue;
        }
        ran.push(step.id);
        const outcome = step.id === failed ? "failure" : "success";
        steps[step.id] = { outcome };
        if (outcome === "failure" && !step["continue-on-error"]) success = false;
      }
      return ran;
    };
    expect(executeGate("success")).toEqual(["release_request", "upload"]);
    // Either device fails the combined phone job; no failed, skipped, pending or cancelled check signs.
    for (const result of ["failure", "cancelled", "skipped", "pending"])
      expect(executeGate(result)).toEqual([]);
    expect(executeGate("success", "release_request")).toEqual(["release_request"]);
    const setup = job.steps.findIndex(
      (step: { uses?: string }) => step.uses === "actions/setup-node@v4",
    );
    const guard = job.steps.findIndex((step: { id?: string }) => step.id === "release_request");
    expect(guard).toBe(setup + 1);
    expect(job.steps[guard].run).toBe(
      workflow.jobs.resolve.steps.find((step: { id?: string }) => step.id === "resolve").run,
    );
    expect(job["continue-on-error"]).toBeUndefined();
    expect(upload["continue-on-error"]).toBeUndefined();
  });
  it("checks the same resolved source in the unsigned workflow without passing signing access (INF-2202)", () => {
    const call = workflow.jobs.phone;
    expect(call.needs).toBe("resolve");
    expect(call.uses).toBe("./.github/workflows/phone.yml");
    expect(call.secrets).toBeUndefined();
    expect(call.environment).toBeUndefined();
    expect(call.permissions).toEqual({
      actions: "write",
      contents: "read",
      "pull-requests": "read",
    });
    const phone = yaml.load(readFileSync(call.uses, "utf8"));
    // A real merged source; a later main ref must not change the checked or signed tree.
    const source = "3835224557b6764d4455b13c1cee359fbb09b5f1";
    const needs = {
      resolve: { result: "success", outputs: { mode: "release", source_commit: source } },
    };
    const inputs = Object.fromEntries(
      Object.entries(call.with).map(([key, value]) => [
        key,
        workflowValue(String(value), { needs }),
      ]),
    );
    // INF-2430's plan, piece 1: the call also runs its Linux job on GitHub's hosted machines.
    expect(inputs).toEqual({ source_commit: source, hosted: true });
    expect(phone.on.workflow_call.inputs.source_commit.type).toBe("string");
    const contexts = {
      inputs,
      github: { sha: source, event_name: "workflow_dispatch", ref: "refs/heads/main" },
      env: {},
      steps: {},
    };
    for (const id of ["cancel-replaced", "native-phone", "phone-repeat-2", "phone-repeat-3"])
      for (const step of phone.jobs[id].steps.filter(
        (step: { uses?: string }) => step.uses === "actions/checkout@v4",
      ))
        expect(workflowString(step.with.ref, contexts)).toBe(source);
    for (const step of workflow.jobs.testflight.steps.filter(
      (step: { uses?: string }) => step.uses === "actions/checkout@v4",
    ))
      expect(workflowString(step.with.ref, { needs })).toBe(source);
    const native = phone.jobs["native-phone"];
    expect(eligible(native.if, contexts)).toBe(true);
    const selection = native.steps.find((step: { id?: string }) => step.id === "request-select");
    expect(eligible(selection.if, contexts)).toBe(false);
    const scope = native.steps.find((step: { id?: string }) => step.id === "scope");
    expect(workflowValue(scope.env.GATE, contexts)).toBe(true);
    const gate = native.steps.find((step: { id?: string }) => step.id === "both");
    expect(
      eligible(gate.if, { ...contexts, steps: { scope: { outputs: { gate: "true" } } } }),
    ).toBe(true);
    expect(workflowString(gate.env.PHONE_PARTS, contexts)).toBe("");
    expect(workflowString(gate.env.INFINITARY_PHONE_STOP_EARLY, contexts)).toBe("0");
    expect(
      workflowValue(workflow.jobs.testflight["runs-on"], {
        vars: { MAC_QUEUES: '{"testflight":"mini-mac-testflight","phone":"mini-mac-phone"}' },
      }),
    ).toBe("mini-mac-testflight");
  });
  it("makes a status request read-only, including when the Mac job was skipped", () => {
    const needs = {
      resolve: { result: "success", outputs: { mode: "status" } },
      testflight: { result: "skipped" },
      phone: { result: "skipped" },
    };
    expect(eligible(workflow.jobs.testflight.if, { needs })).toBe(false);
    expect(eligible(workflow.jobs.phone.if, { needs })).toBe(false);
    expect(eligible(workflow.jobs.availability.if, { needs }, false)).toBe(true);
    needs.resolve.outputs.mode = "release";
    needs.testflight.result = "failure";
    expect(eligible(workflow.jobs.availability.if, { needs }, false)).toBe(false);
    needs.testflight.result = "success";
    expect(eligible(workflow.jobs.availability.if, { needs })).toBe(true);
  });
});
