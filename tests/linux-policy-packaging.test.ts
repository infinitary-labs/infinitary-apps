import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1109: the installed policy rejected group-write permission. Fix its package input,
// never the installed ownership/mode assertion. This exercises the real configured hook
// and policy bytes; the Linux installed-package journey owns root ownership and defaults.
it("stages both package inputs without inheriting group-write permission", async () => {
  const root = join(__dirname, "..");
  const require = createRequire(import.meta.url);
  const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml") as {
    load: (text: string) => unknown;
  };
  const config = yaml.load(readFileSync(join(root, "electron-builder.linux.yml"), "utf8")) as {
    beforePack: string;
    deb: { fpm: string[] };
    rpm: { fpm: string[] };
  };
  const mappings = [config.deb, config.rpm].map(({ fpm }) => {
    const policies = fpm.filter((argument) => argument.endsWith(".policy"));
    expect(policies).toHaveLength(1);
    const [input, destination] = policies[0]?.split("=") ?? [];
    if (!input || !destination) throw new Error("The policy mapping is incomplete");
    return { input, destination };
  });
  expect(mappings[0]).toEqual(mappings[1]);
  const mapping = mappings[0];
  if (!mapping) throw new Error("No policy mapping is configured");
  const projectDir = scratchDir("infinitary-policy-package-");
  const relativeSource = join("packaging/linux/polkit", basename(mapping.destination));
  const source = join(projectDir, relativeSource);
  mkdirSync(dirname(source), { recursive: true });
  copyFileSync(join(root, relativeSource), source);
  // Replay the failed installed policy's group-write bit on real policy bytes.
  chmodSync(source, 0o664);
  const before = readFileSync(source);
  const { default: prepare } = await import(pathToFileURL(join(root, config.beforePack)).href);
  const context = { electronPlatformName: "linux", packager: { projectDir } };
  const staged = join(projectDir, mapping.input);

  await prepare(context);
  expect(readFileSync(staged)).toEqual(before);
  expect(statSync(staged).mode & 0o777).toBe(0o644);
  expect(statSync(source).mode & 0o777).toBe(0o664);
  // A previous generated copy must not keep its permissions on the next build either.
  chmodSync(staged, 0o664);
  await prepare(context);
  expect(readFileSync(staged)).toEqual(before);
  expect(statSync(staged).mode & 0o777).toBe(0o644);
});
