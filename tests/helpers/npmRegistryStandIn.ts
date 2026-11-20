import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { delimiter, dirname, join } from "node:path";
import { expect } from "vitest";
import { hostEnv } from "../../src/core/hostEnv";
import { claimedPort } from "./claimedPort";

/**
 * A stand-in for npm's registry and the project's own pnpm installing from
 * it, for tests of what a job's install does when the registry is slow:
 * tests/pnpm-action.test.ts and tests/check-installed-packages.test.ts.
 */

/** One package the stand-in publishes, and how long its tarball takes to arrive whole: at once when unset. */
export type Published = {
  manifest: { name: string; version: string } & Record<string, unknown>;
  files: Record<string, string | Buffer>;
  seconds?: number;
};

/**
 * Serves each package's metadata and tarball as npm's registry does, each
 * published long ago. A slow package's tarball keeps arriving, a tenth each
 * tenth of its `seconds`, as npm's registry served a large package to a
 * hosted job.
 */
export async function npmRegistryStandIn(folder: string, packages: readonly Published[]) {
  const served = new Map(
    packages.map((published) => {
      const { name, version } = published.manifest;
      const tree = join(folder, `tree-${name}-${version}`);
      mkdirSync(join(tree, "package"), { recursive: true });
      writeFileSync(join(tree, "package", "package.json"), JSON.stringify(published.manifest));
      for (const [file, content] of Object.entries(published.files))
        writeFileSync(join(tree, "package", file), content);
      const archive = join(folder, `${name}-${version}.tgz`);
      const packed = spawnSync("tar", ["-czf", archive, "-C", tree, "package"], { env: hostEnv() });
      expect(packed.status, String(packed.stderr)).toBe(0);
      return [name, { published, body: readFileSync(archive) }] as const;
    }),
  );
  const asked = new Map<string, number>();
  const sending = new Set<NodeJS.Timeout>();
  const publishedAt = "2020-01-01T00:00:00.000Z";
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    const metadata = served.get(decodeURIComponent(path.slice(1)));
    if (metadata) {
      const { manifest } = metadata.published;
      const dist = {
        tarball: `http://${request.headers.host}/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz`,
        integrity: `sha512-${createHash("sha512").update(metadata.body).digest("base64")}`,
        shasum: createHash("sha1").update(metadata.body).digest("hex"),
      };
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          name: manifest.name,
          "dist-tags": { latest: manifest.version },
          versions: { [manifest.version]: { ...manifest, dist } },
          time: { created: publishedAt, modified: publishedAt, [manifest.version]: publishedAt },
        }),
      );
      return;
    }
    const name = /^\/(.+)\/-\/[^/]+\.tgz$/.exec(path)?.[1];
    const tarball = name ? served.get(name) : undefined;
    if (!name || !tarball) {
      response.writeHead(404).end();
      return;
    }
    asked.set(name, (asked.get(name) ?? 0) + 1);
    const { body } = tarball;
    response.writeHead(200, { "content-length": body.length });
    const seconds = tarball.published.seconds;
    if (seconds === undefined) {
      response.end(body);
      return;
    }
    const part = Math.ceil(body.length / 10);
    let sent = 0;
    const timer = setInterval(
      () => {
        if (response.destroyed || sent >= body.length) {
          clearInterval(timer);
          sending.delete(timer);
          return;
        }
        const next = body.subarray(sent, sent + part);
        sent += next.length;
        if (sent >= body.length) response.end(next);
        else response.write(next);
      },
      (seconds * 1000) / 10,
    );
    sending.add(timer);
  });
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    registry: `http://127.0.0.1:${port}/`,
    /** How many times a package's tarball was asked for. */
    tarballRequests: (name: string) => asked.get(name) ?? 0,
    close: () => {
      for (const timer of sending) clearInterval(timer);
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The pnpm this project pins, as package.json's packageManager names it. */
const ownPnpm = (
  JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
    packageManager: string;
  }
).packageManager;

/**
 * The project's own pnpm running `args` in `folder`/project, whose
 * package.json is `manifest`, against `registry`, with a store of its own in
 * `folder` and none of the machine's pnpm settings, as a hosted job's first
 * install starts, and the job's environment on top: what its earlier steps
 * wrote to GITHUB_ENV. Run beside the test, since the registry answering it
 * listens in this process.
 */
export function pnpmInstall(
  folder: string,
  registry: string,
  manifest: Record<string, unknown>,
  job: Record<string, string>,
  args: readonly string[],
) {
  const project = join(folder, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "project", version: "1.0.0", packageManager: ownPnpm, ...manifest }),
  );
  const outside = Object.entries(hostEnv()).filter(([name]) => !/^(npm|pnpm)_config_/i.test(name));
  const child = spawn("pnpm", [...args, "--reporter=append-only"], {
    cwd: project,
    env: {
      ...Object.fromEntries(outside),
      PATH: `${dirname(process.execPath)}${delimiter}${hostEnv().PATH ?? ""}`,
      // The machine's own cache stays, since a version manager such as
      // Corepack keeps the pinned pnpm there; pnpm's own goes beside the store.
      XDG_CONFIG_HOME: join(folder, "config"),
      XDG_DATA_HOME: join(folder, "data"),
      XDG_STATE_HOME: join(folder, "state"),
      pnpm_config_registry: registry,
      pnpm_config_store_dir: join(folder, "store"),
      pnpm_config_cache_dir: join(folder, "cache"),
      // The pause between tries, ten seconds and then a minute on a runner.
      pnpm_config_fetch_retry_mintimeout: "100",
      pnpm_config_fetch_retry_maxtimeout: "100",
      ...job,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return new Promise<{ status: number | null; output: string; project: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, output, project }));
    },
  );
}
