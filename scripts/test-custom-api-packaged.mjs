// Explicit macOS evidence probe, not a per-push package requirement. All files,
// HOME, CA/server keys and ad-hoc signatures belong to disposable scratch data.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, realpathSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { createRequire, Module } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("electron-vite"));
const { build: bundle } = viteRequire("esbuild");
const helpers = await bundle({ stdin: { resolveDir: root, contents: 'export { hostEnv } from "./src/core/hostEnv.ts"; export { scratchDir, removeScratchDirs } from "./tests/helpers/scratchDirs.ts"; export { customApiCaFixture } from "./tests/helpers/customApiCaFixture.ts"; export { customResponsesCall, customResponsesText, sendCustomStream } from "./tests/helpers/customApiDialect.ts";' }, bundle: true, write: false, format: "cjs", platform: "node" });
const helperModule = new Module(join(root, "scripts", "synthetic-probe-helpers.cjs"));
helperModule._compile(helpers.outputFiles[0].text, helperModule.id);
const { hostEnv, scratchDir, removeScratchDirs, customApiCaFixture, customResponsesCall, customResponsesText, sendCustomStream } = helperModule.exports;
const { X509Certificate } = await import("node:crypto");
assert.equal(process.platform, "darwin", "Packaged transport evidence requires macOS");
const scratch = scratchDir("custom-api-packaged-home-");
process.env.HOME = scratch;
process.env.CFFIXED_USER_HOME = scratch;
process.env.INFINITARY_LOCAL_CODESIGN_DIR = join(scratch, "signing");
for (const name of ["CSC_LINK", "CSC_KEYCHAIN", "CSC_NAME", "CSC_KEY_PASSWORD", "CSC_INSTALLER_LINK", "CSC_INSTALLER_KEY_PASSWORD"]) delete process.env[name];
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const fixture = customApiCaFixture(scratch);
const servers = [];
const wire = [];
const serverFor = async (cert) => {
  const server = createServer({ key: fixture.leafKey, cert }, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    wire.push({ path: req.url, authorizationMatchesLiteral: req.headers.authorization === "Bearer $(never-a-command) ${SYNTHETIC_NOT_AN_ENV_KEY}", body });
    const isCheck = JSON.stringify(body).includes("synthetic API connection check");
    const hasResult = JSON.stringify(body).includes('"type":"function_call_output"');
    sendCustomStream(res, isCheck && !hasResult ? customResponsesCall("firstmate_echo", '{"text":"FIRSTMATE_CUSTOM_API_OK"}') : customResponsesText(isCheck ? "FIRSTMATE_CUSTOM_API_OK" : "Synthetic packaged answer."));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const address = server.address(); assert(address && typeof address !== "string");
  return `https://gateway.example.test:${address.port}/operator/path`;
};
try {
  const baseUrl = await serverFor(fixture.leaf);
  const expiredUrl = await serverFor(fixture.expired);
  const config = join(scratch, "fixture.json");
  writeFileSync(config, JSON.stringify({ stateRoot: join(scratch, "state"), baseUrl, expiredUrl, ca: fixture.ca, otherCa: fixture.otherCa, fingerprints: [new X509Certificate(fixture.ca).fingerprint256], otherFingerprints: [new X509Certificate(fixture.otherCa).fingerprint256] }), { mode: 0o600 });
  const appDir = join(scratch, "app"); mkdirSync(appDir, { mode: 0o700 });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "firstmate-custom-api-probe", version: pkg.version, main: "bootstrap.cjs", type: "module", description: "Synthetic packaged transport probe", author: pkg.author, packageManager: pkg.packageManager, dependencies: pkg.dependencies }));
  writeFileSync(join(appDir, "bootstrap.cjs"), `const { app } = require("electron"); process.on("uncaughtException", error => { console.error("PROBE_BOOTSTRAP_FAILED", error.message); app.exit(1); }); import("./probe.mjs").catch(error => { console.error("PROBE_BOOTSTRAP_FAILED", error.message); app.exit(1); });`);
  symlinkSync(join(root, "node_modules"), join(appDir, "node_modules"), "dir");
  await bundle({ entryPoints: [join(root, "tests/helpers/customApiPackagedProbe.ts")], outfile: join(appDir, "probe.mjs"), bundle: true, platform: "node", format: "esm", alias: { "@shared": join(root, "src/shared") }, external: ["electron", ...Object.keys(pkg.dependencies)], logLevel: "warning" });
  // Refuse any keychain command before it could touch a real search list.
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = (file, ...args) => {
    if (String(file).endsWith("/security") || file === "security") throw new Error("This probe must not inspect any keychain");
    return originalExecFile(file, ...args);
  };
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libEntry = builderRequire.resolve("app-builder-lib");
  const libRequire = createRequire(libEntry);
  const { MacTargetHelper } = require(join(dirname(libEntry), "mac", "MacTargetHelper.js"));
  const signEntry = libRequire.resolve("@electron/osx-sign");
  const { Identity } = require(join(dirname(signEntry), "util-identities.js"));
  const { signAsync } = libRequire("@electron/osx-sign");
  // Synthetic ad-hoc identity, never discovery or the project's local signer.
  MacTargetHelper.prototype.findSigningIdentity = async () => new Identity("-");
  const { build, Platform, Arch } = require("electron-builder");
  const output = join(scratch, "package");
  await build({ projectDir: root, targets: Platform.MAC.createTarget("dir", Arch.arm64), config: { extends: join(root, "electron-builder.dev.yml"), appId: "com.firstmate.synthetic.transport-probe", productName: "Firstmate transport probe", directories: { app: appDir, output }, npmRebuild: false, electronDist: join(dirname(require.resolve("electron/package.json")), "dist"), files: ["bootstrap.cjs", "probe.mjs", "package.json"], extraResources: [], mac: { identity: "-", hardenedRuntime: false, notarize: false, sign: async (options) => {
    assert(resolve(options.app).startsWith(`${scratch}/`), "Sign only the disposable bundle");
    await signAsync({ ...options, identity: "-", identityValidation: false, preAutoEntitlements: false, gatekeeperAssess: false, optionsForFile: (file) => { assert(realpathSync(file).startsWith(`${realpathSync(scratch)}/`), "Never sign outside the disposable bundle"); return { hardenedRuntime: false }; } });
  } } } });
  const { extractFile } = libRequire("@electron/asar");
  const manifest = JSON.parse(extractFile(join(output, "mac-arm64", "Firstmate transport probe.app", "Contents", "Resources", "app.asar"), "package.json").toString());
  assert.equal(manifest.main, "bootstrap.cjs");
  const executable = join(output, "mac-arm64", "Firstmate transport probe.app", "Contents", "MacOS", "Firstmate transport probe");
  const child = childProcess.spawn(executable, [`--fixture-config=${config}`, `--user-data-dir=${join(scratch, "profile")}`], { env: { ...hostEnv(), HOME: scratch, CFFIXED_USER_HOME: scratch, INFINITARY_LOCAL_CODESIGN_DIR: join(scratch, "signing"), PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 90000);
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((done, reject) => { child.on("error", reject); child.on("exit", done); });
  clearTimeout(deadline);
  assert.equal(status, 0, `Packaged probe failed: ${stdout}\n${stderr}`);
  const marker = stdout.split("\n").find((line) => line.startsWith("CUSTOM_API_PACKAGED_TLS ")); assert(marker, `No result: ${stdout}\n${stderr}`);
  for (const request of wire) { assert.equal(request.authorizationMatchesLiteral, true); assert.equal(request.body.store, false); }
  mkdirSync(join(root, "test-results/custom-api"), { recursive: true });
  writeFileSync(join(root, "test-results/custom-api/packaged-tls.json"), JSON.stringify({ ...JSON.parse(marker.slice("CUSTOM_API_PACKAGED_TLS ".length)), wire }, null, 2));
  console.log(marker);
} finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  removeScratchDirs();
}
