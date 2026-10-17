/** INF-64 piece 3 / INF-80: versioned TestFlight delivery; Apple reads never mutate account state. */
import { createPrivateKey, sign } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const PHONE = {
  name: "Infinitary",
  bundle: "com.getinfinitary.infinitary",
  team: "9T2J7MNUP9",
} as const;
const APPLE = "https://api.appstoreconnect.apple.com";
type Environment = Record<string, string | undefined>;

export function releaseVersion(value: string): string {
  if (value.trim() !== value || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || value.length > 30) {
    throw new Error("Use a numeric phone version such as 0.1.0, without a tag prefix or prerelease suffix.");
  }
  return value;
}

export function buildNumber(value: string): string {
  // CFBundleVersion: positive first component, at most four digits; two digits thereafter.
  if (value.trim() !== value || !/^[1-9]\d{0,3}\.(?:[1-9]\d?)$/.test(value)) {
    throw new Error("The phone build must be run.attempt: run 1–9999 and attempt 1–99.");
  }
  return value;
}

export function resolveRelease(env: Environment) {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Phone releases and status checks must be requested from main.");
  }
  // Rerunning only failed jobs keeps resolve's old outputs but advances the
  // runner's attempt. It must neither renumber nor resubmit an uncertain upload.
  if (!env.CHECK_BUILD && env.GITHUB_RUN_ATTEMPT !== "1") {
    throw new Error("A release job cannot be rerun. Check the previous build with check_build before starting a new release request.");
  }
  const source = env.GITHUB_SHA ?? "";
  if (source.length !== 40 || !/^[a-f0-9]{40}$/.test(source)) throw new Error("Missing exact source commit.");
  return {
    version: releaseVersion(env.PHONE_VERSION ?? ""),
    build_number: buildNumber(env.CHECK_BUILD || `${env.GITHUB_RUN_NUMBER}.${env.GITHUB_RUN_ATTEMPT}`),
    source_commit: source,
    mode: env.CHECK_BUILD ? "status" : "release",
  };
}

export function appleCredentials(env: Environment) {
  const id = env.APP_STORE_CONNECT_KEY_ID ?? "";
  const issuer = env.APP_STORE_CONNECT_ISSUER_ID ?? "";
  if (id.length !== 10 || issuer.length !== 36 || !/^[A-Z0-9]{10}$/.test(id) || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(issuer)) {
    throw new Error("Set APP_STORE_CONNECT_KEY_ID and APP_STORE_CONNECT_ISSUER_ID in the project's secrets.");
  }
  try {
    const encoded = (env.APP_STORE_CONNECT_API_KEY ?? "").replace(/\s/g, "");
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const key = createPrivateKey(Buffer.from(encoded, "base64"));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error();
    }
    return { id, issuer, key };
  } catch {
    throw new Error("APP_STORE_CONNECT_API_KEY must contain the base64-encoded App Store Connect P-256 private key.");
  }
}

type Resource = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
};
type Page = { data: Resource[]; included?: Resource[]; links?: { next?: string | null } };
export type AppleRead = (path: string) => Promise<Page>;

export function appleReader(env: Environment, request: typeof fetch = fetch): AppleRead {
  const { id, issuer, key } = appleCredentials(env);
  return async (path) => {
    const url = new URL(path, APPLE);
    if (url.origin !== APPLE || !url.pathname.startsWith("/v1/") || url.username || url.password) {
      throw new Error("Apple returned an unexpected pagination address.");
    }
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "ES256", kid: id, typ: "JWT" })}.${encode({ iss: issuer, iat: now, exp: now + 300, aud: "appstoreconnect-v1" })}`;
    const jwt = `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    let response: Response;
    try {
      response = await request(url, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
      });
    } catch {
      throw new Error("Could not read App Store Connect; no Apple account changes were made.");
    }
    if (!response.ok) throw new Error(`App Store Connect refused a read (HTTP ${response.status}); check the key's app access and role.`);
    const text = await response.text();
    if (text.length > 1_048_576) throw new Error("Apple's response exceeded the read limit.");
    let page: Page;
    try { page = JSON.parse(text); } catch { throw new Error("Apple returned unreadable data."); }
    if (!Array.isArray(page.data) || page.data.some((item) => typeof item.id !== "string" || typeof item.type !== "string")) {
      throw new Error("Apple returned an unexpected record shape.");
    }
    return page;
  };
}

async function all(read: AppleRead, path: string): Promise<Resource[]> {
  const result: Resource[] = [];
  let next: string | null | undefined = path;
  for (let page = 0; next && page < 10; page++) {
    const answer = await read(next);
    result.push(...answer.data);
    next = answer.links?.next;
  }
  if (next) throw new Error("Apple's listing exceeded ten pages; readiness is not established.");
  return result;
}

export async function findPhoneApp(read: AppleRead): Promise<string> {
  const apps = (await all(read, `/v1/apps?filter[bundleId]=${PHONE.bundle}&limit=200`))
    .filter((app) => app.attributes?.bundleId === PHONE.bundle);
  const app = apps[0];
  if (apps.length !== 1 || !app) {
    throw new Error(`Create the Infinitary iOS app record in App Store Connect for ${PHONE.bundle}, or grant this key access to it.`);
  }
  if (app.attributes?.name !== PHONE.name) throw new Error('Rename the App Store Connect app to "Infinitary" before uploading.');
  if (!/^\d+$/.test(app.id)) throw new Error("Apple returned an unexpected app identifier.");
  return app.id;
}

export async function checkReady(read: AppleRead) {
  const app = await findPhoneApp(read);
  const bundles = (await all(read, `/v1/bundleIds?filter[identifier]=${PHONE.bundle}&limit=200`))
    .filter((bundle) => bundle.attributes?.identifier === PHONE.bundle);
  if (bundles.length !== 1) {
    throw new Error(`Register ${PHONE.bundle} in Apple Developer for team ${PHONE.team}, or give the key access to signing resources.`);
  }
  const groups = await all(read, `/v1/apps/${app}/betaGroups?limit=200`);
  const internal = groups.filter((group) => group.attributes?.isInternalGroup === true && group.attributes.hasAccessToAllBuilds === true);
  let readyGroups = 0;
  for (const group of internal) {
    const testers = await all(read, `/v1/betaGroups/${encodeURIComponent(group.id)}/betaTesters?limit=200`);
    // Apple sends the invitation only once a build is available. A configured
    // first-build tester may still be NOT_INVITED; acceptance cannot gate upload.
    if (testers.some((tester) => ["NOT_INVITED", "INVITED", "ACCEPTED", "INSTALLED"].includes(String(tester.attributes?.state)))) readyGroups++;
  }
  if (!readyGroups) {
    throw new Error("In Infinitary's TestFlight tab, create an internal group with automatic distribution and add yourself. Apple sends the invitation when a build is available.");
  }
  return { app, readyGroups };
}

export async function readBuild(read: AppleRead, app: string, version: string, build: string) {
  const answer = await read(`/v1/builds?filter[app]=${app}&filter[version]=${encodeURIComponent(build)}&include=preReleaseVersion,buildBetaDetail&limit=200`);
  // Build numbers can repeat in different marketing versions. Identify the whole pair.
  const found = answer.data.filter((item) => {
    const pre = item.relationships?.preReleaseVersion?.data?.id;
    const release = answer.included?.find((part) => part.type === "preReleaseVersions" && part.id === pre);
    if (item.type !== "builds" || item.attributes?.version !== build || typeof release?.attributes?.version !== "string" || typeof release.attributes.platform !== "string") {
      throw new Error("Apple omitted the build's version identity; its upload outcome is not established.");
    }
    return release.attributes.version === version && release.attributes.platform === "IOS";
  });
  if (answer.links?.next) throw new Error("Apple's build listing is incomplete; the upload outcome is not established.");
  if (!found.length) return { state: "absent" as const, reason: "Apple has not listed this version and build yet" };
  const record = found[0]!;
  if (found.length !== 1 || record.attributes?.version !== build) throw new Error("Apple returned an ambiguous build.");
  const processing = record.attributes.processingState;
  if (typeof record.attributes.expired !== "boolean") throw new Error("Apple omitted the build's expiry state.");
  if (record.attributes.expired === true || processing === "FAILED" || processing === "INVALID") {
    throw new Error("Apple rejected or expired this build. Inspect its TestFlight details before another upload.");
  }
  if (processing === "PROCESSING") return { state: "waiting" as const, reason: "Apple is processing the uploaded build" };
  if (processing !== "VALID") throw new Error("Apple returned an unknown processing state; do not upload again to check it.");
  const detail = answer.included?.find((item) => item.type === "buildBetaDetails" && item.id === record.relationships?.buildBetaDetail?.data?.id);
  const internal = detail?.attributes?.internalBuildState;
  if (internal === "IN_BETA_TESTING") return { state: "ready" as const, reason: "Apple reports this build in internal TestFlight testing" };
  if (internal === "MISSING_EXPORT_COMPLIANCE" || internal === "IN_EXPORT_COMPLIANCE_REVIEW") {
    throw new Error("Apple needs export-compliance information in this build's TestFlight details; no second upload is needed.");
  }
  if (internal !== "READY_FOR_BETA_TESTING" && internal !== "PROCESSING") throw new Error("Apple returned an unknown internal-testing state; inspect TestFlight before another upload.");
  return { state: "waiting" as const, reason: "Apple has not made the processed build available to internal testers yet" };
}

export async function waitForBuild(read: AppleRead, app: string, version: string, build: string,
  pause: () => Promise<unknown> = () => delay(30_000), attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await readBuild(read, app, version, build);
    if (result.state === "ready") return result;
    if (attempt + 1 < attempts) await pause();
  }
  throw new Error(`Apple has not confirmed internal testing yet. Run this workflow with version ${version} and check_build ${build} to check again without uploading.`);
}

async function main() {
  const env = process.env;
  const command = process.argv[2];
  if (command === "resolve") {
    const result = resolveRelease(env);
    const lines = Object.entries(result).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines); else process.stdout.write(lines);
    return;
  }
  if (command === "prepare-key") {
    const directory = resolve(process.argv[3] ?? "");
    if (!process.argv[3]) throw new Error("Name an owned temporary key directory.");
    const { id, key } = appleCredentials(env);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `AuthKey_${id}.p8`);
    writeFileSync(path, key.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
    process.stdout.write(path);
    return;
  }
  if (command === "receipt") {
    const path = env.PHONE_RECEIPT;
    if (!path) throw new Error("Missing receipt path.");
    const release = resolveRelease(env);
    const state = process.argv[3];
    if (state !== "attempted" && state !== "accepted") throw new Error("Unknown upload state.");
    writeFileSync(path, JSON.stringify({ ...release, app: PHONE.name, bundle: PHONE.bundle, upload: state }, null, 2) + "\n");
    return;
  }
  const release = resolveRelease(env);
  const read = appleReader(env);
  if (command === "preflight") {
    const ready = await checkReady(read);
    const existing = await readBuild(read, ready.app, release.version, release.build_number);
    if (existing.state !== "absent") throw new Error("This build is already in App Store Connect. Use check_build instead of uploading it again.");
    console.log(`Infinitary's app record and ${ready.readyGroups} internal tester group(s) are ready. Signing authority is checked by Xcode, not inferred from these reads.`);
  } else if (command === "status") {
    const app = await findPhoneApp(read);
    const result = await waitForBuild(read, app, release.version, release.build_number);
    const message = `Infinitary ${release.version} (${release.build_number}): ${result.reason}. This is not confirmation of installation on a physical phone.`;
    console.log(message);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`);
  } else throw new Error("Use resolve, preflight, prepare-key, receipt or status.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Phone release failed.");
    process.exitCode = 1;
  });
}
