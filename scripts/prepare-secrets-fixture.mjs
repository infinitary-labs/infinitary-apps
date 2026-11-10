// Build inputs only: no signing, Keychain access, application launch or upload.
// Usage: node scripts/prepare-secrets-fixture.mjs <output> <runtime-root> <evidence-folder>
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
const [output, fixture, evidence, ...extra] = process.argv.slice(2);
if (!output || !fixture || !evidence || extra.length || ![output, fixture, evidence].every(isAbsolute))
  throw new Error("Name absolute output, disposable runtime and evidence folders.");
const root = process.cwd();
const generated = join(output, "generated");
mkdirSync(output); // Refuse an existing output: never overwrite a previous fixture.
mkdirSync(generated);
const req = createRequire(join(root, "package.json"));
const builderReq = createRequire(req.resolve("electron-builder"));
const appBuilderReq = createRequire(builderReq.resolve("app-builder-lib"));
const yaml = appBuilderReq("js-yaml");
const original = yaml.load(readFileSync(join(root, "electron-builder.yml"), "utf8"));
const entitlements = resolve(root, original.mac.entitlements);
const config = {
  ...original,
  appId: "com.getinfinitary.infinitary.secrets-check",
  productName: "Infinitary Secrets Check",
  directories: { ...original.directories, output: join(output, "unsigned"), buildResources: resolve(root, original.directories.buildResources) },
  npmRebuild: false,
  forceCodeSigning: false,
  extraMetadata: { main: "out/main/secrets-fixture.mjs" },
  files: [...original.files, ...original.mac.files,
    { from: generated, to: "out/main", filter: ["secrets-fixture.mjs", "secrets-unlock.mjs"] },
    { from: join(root, "src/renderer/src/design/assets/fonts"), to: "out/main/secrets-fixture-assets/fonts" },
    { from: join(root, "src/main/assets"), to: "out/main/secrets-fixture-assets/native" },
  ],
  mac: { ...original.mac, files: [], target: [{ target: "dir", arch: ["arm64"] }], identity: null, notarize: false,
    entitlements, entitlementsInherit: resolve(root, original.mac.entitlementsInherit) },
  publish: null,
};
writeFileSync(join(output, "unsigned.json"), JSON.stringify(config, null, 2));
const files = path => readdirSync(join(root, path)).filter(name => name.endsWith(".md") && name !== "README.md").sort();
const frameDir = join(root, "out/frame-lib");
const pins = Object.fromEntries(readdirSync(frameDir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
  const path = join(e.parentPath, e.name);
  return [path.slice(frameDir.length + 1), "sha256-" + createHash("sha256").update(readFileSync(path)).digest("base64")];
}));
const fonts = readdirSync(join(root, "src/renderer/src/design/assets/fonts")).filter(n => n.endsWith(".woff2"));
const { build } = createRequire(req.resolve("vite"))("esbuild");
await build({ entryPoints: [join(root, "tests/fixtures/native-secrets/entry.ts")], bundle: true, packages: "external", platform: "node", format: "esm", target: "node24", tsconfig: join(root, "tsconfig.node.json"), outfile: join(generated, "secrets-fixture.mjs"), alias: { sharp: join(root, "src/main/voice/noSharp.ts") }, plugins: [{ name: "isolated-secrets-fixture", setup(build) {
  build.onLoad({ filter: /\/host\/electronKeychain\.ts$/, namespace: "file" }, () => ({ contents: "import {absentKeychain} from '@core/host'; export const createDesktopKeychain = () => absentKeychain; export const readElectronKeychainStatus = async () => 'unknown';", loader: "ts", resolveDir: root }));
  build.onLoad({ filter: /\/frames\/fontFiles\.ts$/, namespace: "file" }, () => ({ contents: `import {fileURLToPath} from 'node:url'; export const frameFontFiles = Object.fromEntries(${JSON.stringify(fonts)}.map(name => [name,fileURLToPath(new URL('./secrets-fixture-assets/fonts/'+name,import.meta.url))]));`, loader: "js" }));
  build.onResolve({ filter: /^virtual:fm-frame-lib$/ }, args => ({ path: args.path, namespace: "frame-pins" }));
  build.onLoad({ filter: /.*/, namespace: "frame-pins" }, () => ({ contents: `export const FRAME_LIB_PINS=Object.freeze(${JSON.stringify(pins)})`, loader: "js" }));
  build.onResolve({ filter: /\?asset$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -6)), namespace: "native-asset" }));
  build.onLoad({ filter: /.*/, namespace: "native-asset" }, args => ({ contents: `import {fileURLToPath} from 'node:url'; export default fileURLToPath(new URL(${JSON.stringify("./secrets-fixture-assets/native/" + args.path.split("/").at(-1))},import.meta.url));`, loader: "js" }));
} }], define: { __FM_CONTRACT_REVISIONS__: JSON.stringify(files("src/core/prompts/contract-revisions")), __INF_CONTRACT_CHANGES__: JSON.stringify(files("src/shared/contract-changes")), __INF_SECRET_FIXTURE_ROOT__: JSON.stringify(fixture), __INF_SECRET_FIXTURE_EVIDENCE__: JSON.stringify(evidence), "process.env.INFINITARY_BUILD_UMAMI_HOST": '""', "process.env.INFINITARY_BUILD_UMAMI_WEBSITE_ID": '""' } });
// The fixture's explicit unlock uses the current private child lifecycle, with a
// compiled-in disposable store. It never searches the person's saved passwords.
await build({ entryPoints: [join(root, "tests/fixtures/native-secrets/unlockMain.ts")], bundle: true, packages: "external", platform: "node", format: "esm", target: "node24", tsconfig: join(root, "tsconfig.node.json"), outfile: join(generated, "secrets-unlock.mjs"), define: { __INF_SECRET_FIXTURE_ROOT__: JSON.stringify(fixture) } });
writeFileSync(join(output, "preparation.json"), JSON.stringify({ prepared: true, signed: false, launched: false, keychainAccessed: false, runtimeRoot: fixture, evidenceFolder: evidence, appId: config.appId, releaseHardenedRuntime: config.mac.hardenedRuntime, releaseEntitlementsSha256: createHash("sha256").update(readFileSync(entitlements)).digest("hex"), fuses: config.electronFuses, fixtureDifferences: ["Separate app identity and disposable home", "Existing sign-in backend returns absent", "Closed app-owned controls, invented stimulus and own-renderer capture", "Fixed disposable recovery file choices; picker UI is not proved", "Apple silicon; no notarization or publication"], unsignedConfig: join(output, "unsigned.json") }, null, 2));
console.log("Prepared the unsigned native fixture; no signing, Keychain access or launch occurred.");
