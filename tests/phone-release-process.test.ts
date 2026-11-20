import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { phoneCertificateFixture } from "./helpers/phoneCertificateFixture";
import { scratchDir } from "./helpers/scratchDirs";

// INF-80: run the workflow's real release command through stand-in Xcode/Apple
// boundaries. No signing, real keys, personal keychain or external request.
const require = createRequire(import.meta.url);
const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml");
const workflow = yaml.load(readFileSync(".github/workflows/ios-release.yml", "utf8"));
const execute = promisify(execFile);

async function runRelease(failure = "", overrides: Partial<Record<string, string>> = {}) {
  const root = scratchDir("infinitary-phone-release-");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const temp = join(root, "temp");
  for (const directory of [
    bin,
    home,
    temp,
    join(root, "scripts"),
    join(root, "ios"),
    join(root, "packaging"),
  ])
    mkdirSync(directory);
  for (const file of [
    "release-phone.sh",
    "phone-release.ts",
    "phone-release-archive.ts",
    "phone-certificates.ts",
  ])
    copyFileSync(resolve("scripts", file), join(root, "scripts", file));
  // Exercise the original project's numbering even after the source configuration moves.
  const repository = "infinitary-labs/infinitary";
  const releaseSource = JSON.parse(readFileSync("packaging/release-source.json", "utf8"));
  writeFileSync(
    join(root, "packaging/release-source.json"),
    JSON.stringify({ ...releaseSource, repository }),
  );
  copyFileSync("ios/ExportOptions.plist", join(root, "ios/ExportOptions.plist"));
  copyFileSync("ios/Infinitary/Info.plist", join(root, "ios/Info.plist"));
  // The app's own build settings, which Xcode reads where the release command passes none.
  copyFileSync(
    "ios/Infinitary/Infinitary.xcodeproj/project.pbxproj",
    join(root, "ios/project.pbxproj"),
  );
  copyFileSync("ios/Infinitary/NotificationsInfo.plist", join(root, "ios/NotificationsInfo.plist"));
  // INF-227 F4: these scratch files model the uploader's earlier search locations.
  const staleKey = "A stale key fixture that this release must neither use nor remove";
  const otherKeyFiles = [
    join(root, "private_keys"),
    join(home, "private_keys"),
    join(home, ".private_keys"),
    join(home, ".appstoreconnect/private_keys"),
  ].map((directory) => {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "AuthKey_A1B2C3D4E5.p8");
    writeFileSync(path, staleKey);
    return path;
  });
  const mock = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const tool = path.basename(process.argv[1]); const args = process.argv.slice(2);
const get = name => args[args.indexOf(name) + 1];
// A setting the command passes, or else the app target's own: its configurations come first in the project.
const setting = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1) ??
  fs.readFileSync('ios/project.pbxproj', 'utf8').match(new RegExp(name + ' = ([^;]+);'))?.[1];
const entry = {tool, args};
const key = get('-authenticationKeyPath');
if (args.includes('-authenticationKeyPath')) {
  entry.keyMode = fs.statSync(key).mode & 0o777;
  entry.keyDirectoryMode = fs.statSync(path.dirname(key)).mode & 0o777;
  entry.privateKeyPresent = fs.readFileSync(key, 'utf8').includes('PRIVATE KEY');
}
if (tool === 'xcrun' && args[0] === 'altool') {
  const uploadKey = get('--p8-file-path');
  entry.usesPreparedKey = args.includes('--p8-file-path') && fs.existsSync(uploadKey) &&
    fs.readFileSync(uploadKey, 'utf8') === Buffer.from(process.env.APP_STORE_CONNECT_API_KEY, 'base64').toString('utf8');
}
fs.appendFileSync(process.env.TRACE, JSON.stringify(entry) + '\\n');
const fail = process.env.FAIL_AT;
if (tool === 'security' || tool === 'codesign') process.exit(97);
if (tool === 'xcodebuild' && args[0] === '-version') { console.log('Xcode 26.4'); process.exit(0); }
if (args[0] === 'archive') {
  if (fail === 'archive') process.exit(7);
  if (process.env.PHONE_TEST_SIGNER) console.log('/usr/bin/codesign --force --sign ' + process.env.PHONE_TEST_SIGNER + ' /archive/Infinitary.app');
  // The project's actual metadata is the fixture. Only compiler-added fields
  // and supplied build settings are filled in, so an omitted iPad key fails too.
  let info = fs.readFileSync('ios/Info.plist', 'utf8');
  for (const name of ['PRODUCT_BUNDLE_IDENTIFIER', 'MARKETING_VERSION', 'CURRENT_PROJECT_VERSION']) {
    info = info.replaceAll('$(' + name + ')', setting(name));
  }
  info = info.replaceAll('$(PRODUCT_NAME)', 'Infinitary').replaceAll('$(EXECUTABLE_NAME)', 'Infinitary');
  if (fail === 'identity') info = info.replace('<key>CFBundleDisplayName</key><string>Infinitary</string>', '<key>CFBundleDisplayName</key><string>Wrong name</string>');
  if (fail === 'ipad-missing') {
    const start = info.indexOf('<key>UISupportedInterfaceOrientations~ipad</key>');
    if (start >= 0) info = info.slice(0, start) + info.slice(info.indexOf('</array>', start) + '</array>'.length);
  }
  if (fail === 'ipad-incomplete') info = info.replace('<string>UIInterfaceOrientationPortraitUpsideDown</string>', '');
  const compiled = '<key>DTPlatformName</key><string>iphoneos</string><key>CFBundleIcons</key><dict><key>CFBundlePrimaryIcon</key><dict><key>CFBundleIconName</key><string>AppIcon</string></dict></dict>';
  info = info.replace('</dict></plist>', compiled + '</dict></plist>');
  const folder = path.join(get('-archivePath'), 'Products/Applications/Infinitary.app');
  fs.mkdirSync(folder, {recursive: true});
  fs.writeFileSync(path.join(folder, 'Info.plist'), info);
  // The notification part, from its own metadata and its target's own identifier in the project.
  const project = fs.readFileSync('ios/project.pbxproj', 'utf8');
  const partSettings = project.split('\\n').find(line => line.includes('INFOPLIST_FILE = NotificationsInfo.plist;'));
  let part = fs.readFileSync('ios/NotificationsInfo.plist', 'utf8')
    .replaceAll('$(PRODUCT_BUNDLE_IDENTIFIER)', partSettings.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/)[1]);
  for (const name of ['MARKETING_VERSION', 'CURRENT_PROJECT_VERSION']) part = part.replaceAll('$(' + name + ')', setting(name));
  if (fail === 'part-version') part = part.replace(setting('CURRENT_PROJECT_VERSION'), '1');
  fs.mkdirSync(path.join(folder, 'PlugIns/InfinitaryNotifications.appex'), {recursive: true});
  fs.writeFileSync(path.join(folder, 'PlugIns/InfinitaryNotifications.appex/Info.plist'), part);
} else if (args[0] === '-exportArchive') {
  if (fail === 'export') process.exit(8);
  const target = get('-exportPath'); fs.mkdirSync(target);
  if (fail !== 'no-ipa') fs.writeFileSync(path.join(target, 'Infinitary.ipa'), 'stand-in exported archive');
  if (fail === 'two-ipas') fs.writeFileSync(path.join(target, 'Other.ipa'), 'another archive');
} else if (tool === 'xcrun' && args[0] === 'altool') {
  if (!entry.usesPreparedKey || !fs.existsSync(get('--file'))) process.exit(91);
  if (fail === 'upload') process.exit(9);
  console.log('Upload accepted by stand-in Apple boundary');
} else process.exit(96);
`;
  for (const name of ["xcodebuild", "xcrun", "security", "codesign"])
    writeFileSync(join(bin, name), mock, { mode: 0o755 });
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const env = {
    ...hostEnv(),
    HOME: home,
    CFFIXED_USER_HOME: home,
    INFINITARY_LOCAL_CODESIGN_DIR: join(home, "unused"),
    PATH: `${bin}:${dirname(process.execPath)}:${hostEnv().PATH}`,
    RUNNER_TEMP: temp,
    GITHUB_ENV: join(root, "github-env"),
    GITHUB_OUTPUT: join(root, "github-output"),
    GITHUB_STEP_SUMMARY: join(root, "summary.md"),
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: "54d835d17f2baa056c3899f7ad93f20e96756b1a",
    GITHUB_RUN_NUMBER: "42",
    GITHUB_RUN_ATTEMPT: "1",
    RUNNER_NAME: "hosted-mac",
    PHONE_VERSION: "0.1.0",
    CHECK_BUILD: "",
    PHONE_RECEIPT: join(temp, "receipt.json"),
    APP_STORE_CONNECT_KEY_ID: "A1B2C3D4E5",
    APP_STORE_CONNECT_ISSUER_ID: "11111111-2222-3333-4444-555555555555",
    APP_STORE_CONNECT_API_KEY: Buffer.from(privatePem).toString("base64"),
    TRACE: join(root, "trace.jsonl"),
    FAIL_AT: failure,
    ...overrides,
  };
  if (overrides.PHONE_TEST_CERTIFICATES) {
    const loader = join(root, "apple-boundary.cjs");
    writeFileSync(
      loader,
      `
const fs = require('node:fs');
globalThis.fetch = async (url, init) => {
  if (url.origin !== 'https://api.appstoreconnect.apple.com' || url.pathname !== '/v1/certificates' || init.method !== 'GET') throw new Error('Unexpected Apple request');
  fs.appendFileSync(process.env.TRACE, JSON.stringify({tool: 'apple', args: [init.method, url.pathname]}) + '\\n');
  return new Response(JSON.stringify({data: JSON.parse(process.env.PHONE_TEST_CERTIFICATES)}));
};
`,
    );
    Object.assign(env, { NODE_OPTIONS: `--require="${loader}"` });
  }
  const command = workflow.jobs.testflight.steps.find(
    (step: { id?: string }) => step.id === "upload",
  ).run;
  let code = 0;
  let output = "";
  try {
    const result = await execute("bash", ["-e", "-c", command], { cwd: root, env });
    output = result.stdout + result.stderr;
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    code = failed.code;
    output = failed.stdout + failed.stderr;
  }
  expect(output).not.toContain(privatePem);
  expect(output).not.toContain(env.APP_STORE_CONNECT_API_KEY);
  const files = readdirSync(temp);
  expect(files.filter((name) => name.startsWith("infinitary-ios-release."))).toEqual([]);
  let trace: {
    tool: string;
    args: string[];
    keyMode?: number;
    keyDirectoryMode?: number;
    privateKeyPresent?: boolean;
    usesPreparedKey?: boolean;
  }[] = [];
  try {
    trace = readFileSync(env.TRACE, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    /* Refusals happen before any tool runs. */
  }
  const receipt = files.includes("receipt.json")
    ? JSON.parse(readFileSync(env.PHONE_RECEIPT, "utf8"))
    : undefined;
  expect(trace.some((item) => ["security", "codesign"].includes(item.tool))).toBe(false);
  for (const path of otherKeyFiles) expect(readFileSync(path, "utf8")).toBe(staleKey);
  const summary = (() => {
    try {
      return readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
    } catch {
      return "";
    }
  })();
  const evidence = process.env.INFINITARY_PHONE_RELEASE_EVIDENCE;
  if (evidence) {
    const folder = resolve(evidence);
    if (folder === resolve(".") || folder.startsWith(`${resolve(".")}/`)) {
      throw new Error("Release evidence must stay outside the working copy");
    }
    mkdirSync(folder, { recursive: true });
    const name =
      (overrides.PHONE_TEST_CERTIFICATES?.includes("invalid certificate")
        ? "listing-failed"
        : "") ||
      failure ||
      (overrides.PHONE_TEST_CERTIFICATES ? "certificate-list" : Object.keys(overrides)[0]) ||
      "success";
    writeFileSync(
      join(folder, `${name}.json`),
      JSON.stringify(
        {
          boundary: "Stand-in Xcode and Apple upload commands; no real signing or upload",
          code,
          trace,
          receipt,
          output,
          summary,
        },
        null,
        2,
      ),
    );
  }
  return { code, trace, receipt, output, summary };
}

describe("the TestFlight release command", () => {
  it("archives the supplied version, verifies its identity, exports and uploads exactly once, then removes the key", async () => {
    const result = await runRelease();
    expect(result.code, result.output).toBe(0);
    expect(result.trace.map((entry) => [entry.tool, entry.args[0]])).toEqual([
      ["xcodebuild", "-version"],
      ["xcodebuild", "archive"],
      ["xcodebuild", "-exportArchive"],
      ["xcrun", "altool"],
    ]);
    expect(result.trace[1]).toMatchObject({
      keyMode: 0o600,
      keyDirectoryMode: 0o700,
      privateKeyPresent: true,
    });
    expect(result.trace[1]?.args).toContain("MARKETING_VERSION=0.1.0");
    expect(result.trace[1]?.args).toContain("CURRENT_PROJECT_VERSION=42.1");
    expect(result.trace.at(-1)?.usesPreparedKey).toBe(true);
    expect(result.output).toContain("Skipped: not the Mac mini runner.");
    expect(result.output).toContain("list-only; no certificates revoked");
    expect(result.receipt).toMatchObject({
      version: "0.1.0",
      build_number: "42.1",
      upload: "accepted",
      app: "Infinitary",
    });
  });
  it("lists the eligible certificate after upload through the real cleanup entry point without a delete", async () => {
    const certificates = phoneCertificateFixture();
    const api = certificates.api!;
    const signer = certificates["other-key"]!;
    // Use the real fixture's validity reading, not an invented API creation date.
    // The fixture is older than one day at the release boundary by its fixed notBefore.
    const result = await runRelease("", {
      RUNNER_NAME: "mini-mac",
      PHONE_TEST_SIGNER: signer.fingerprint.replaceAll(":", ""),
      PHONE_TEST_CERTIFICATES: JSON.stringify([
        {
          id: "old-api",
          type: "certificates",
          attributes: {
            certificateType: "DEVELOPMENT",
            certificateContent: api.raw.toString("base64"),
          },
        },
      ]),
    });
    expect(result.code, result.output).toBe(0);
    expect(result.trace.map((entry) => [entry.tool, entry.args[0]])).toEqual([
      ["xcodebuild", "-version"],
      ["xcodebuild", "archive"],
      ["xcodebuild", "-exportArchive"],
      ["xcrun", "altool"],
      ["apple", "GET"],
    ]);
    expect(result.output).toContain("list-only; no certificates revoked");
    expect(result.output).toContain(
      `Would revoke: old-api; SHA-1 ${api.fingerprint.replaceAll(":", "")}`,
    );
    expect(result.receipt.upload).toBe("accepted");
  });
  it("does not retry or invalidate an accepted upload when the certificate listing fails", async () => {
    const result = await runRelease("", {
      RUNNER_NAME: "mini-mac",
      PHONE_TEST_SIGNER: "AEBD27AB15EDB3547EF82E2E8025D54BA1F849A1",
      PHONE_TEST_CERTIFICATES: JSON.stringify([
        {
          id: "broken",
          type: "certificates",
          attributes: { certificateType: "DEVELOPMENT", certificateContent: "invalid certificate" },
        },
      ]),
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Certificate listing failed; upload remains accepted");
    expect(result.receipt.upload).toBe("accepted");
    expect(result.trace.filter((entry) => entry.tool === "xcrun")).toHaveLength(1);
  });
  it("lists nothing on the Mac mini when the archive has no signing fingerprint", async () => {
    const result = await runRelease("", { RUNNER_NAME: "mini-mac" });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Skipped: no archive signing fingerprint");
    expect(result.receipt.upload).toBe("accepted");
  });
  it.each([
    "archive",
    "identity",
    "ipad-missing",
    "ipad-incomplete",
    // INF-4794: a notification part whose build differs from the app's.
    "part-version",
    "export",
    "no-ipa",
    "two-ipas",
  ])("a %s failure uploads nothing and removes its temporary credentials", async (failure) => {
    const result = await runRelease(failure);
    expect(result.code).not.toBe(0);
    expect(result.trace.some((entry) => entry.tool === "xcrun")).toBe(false);
    expect(result.receipt).toBeUndefined();
    expect(result.output).not.toContain("Certificate cleanup:");
  });
  it("does not retry an unclear upload and retains an attempted, not accepted, receipt", async () => {
    const result = await runRelease("upload");
    expect(result.code).not.toBe(0);
    expect(result.trace.filter((entry) => entry.tool === "xcrun")).toHaveLength(1);
    expect(result.receipt.upload).toBe("attempted");
    expect(result.output).not.toContain("Certificate cleanup:");
    expect(result.output).toContain("do not retry automatically");
  });
  it.each([
    { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_ACTIONS: "false" },
    { GITHUB_RUN_ATTEMPT: "2" },
    { CHECK_BUILD: "41.1" },
    { PHONE_VERSION: "1.2.3; false" },
  ])("refuses unsafe release context %j before any Xcode command", async (override) => {
    const result = await runRelease("", override);
    expect(result.code).not.toBe(0);
    expect(result.trace).toEqual([]);
  });
});
