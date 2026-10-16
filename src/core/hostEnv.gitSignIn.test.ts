import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { ForgeSignInStore } from "./forge";
import { configureBundledGit, configureGitSignIn, hostEnv } from "./hostEnv";
import { resolveBundledGit } from "./workspace/bundledGit";

/**
 * Git that never prompts, and answers GitHub only with the app's own
 * sign-in (git integration PR 1.2, `docs/forge.md`), proven with real git
 * against a local HTTPS host that asks for a sign-in the way GitHub does:
 * a 401 with a Basic challenge. The host here is 127.0.0.1 on a random
 * port, standing where github.com stands in the app.
 *
 * - The app's helper answers with `x-access-token` and the stored sign-in.
 * - A credential helper in the person's own git config (the keychain's,
 *   another program's sign-in) is never asked for that host.
 * - A host with no sign-in here gets nothing, and git fails at once rather
 *   than waiting on a prompt nobody sees.
 */

const ASKPASS = join(__dirname, "../../resources/git-askpass");

let tls: { key: string; cert: string };
let server: Server | undefined;

beforeAll(() => {
  const dir = scratchDir("infinitary-git-tls-");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  tls = {
    key: readFileSync(join(dir, "key.pem"), "utf8"),
    cert: readFileSync(join(dir, "cert.pem"), "utf8"),
  };
});

afterEach(async () => {
  configureGitSignIn(undefined);
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** A host that challenges for Basic auth and records every Authorization it was sent. */
async function challengingHost(): Promise<{ port: number; auths: string[] }> {
  const auths: string[] = [];
  server = createServer(tls, (req, res) => {
    const auth = req.headers.authorization;
    if (auth) auths.push(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString("utf8"));
    // Every attempt is refused, so git stops after the answer it was given.
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' });
    res.end();
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", () => resolve()));
  return { port: (listening.address() as AddressInfo).port, auths };
}

function setup(signedIn: boolean, port: number) {
  const home = scratchDir("infinitary-git-home-");
  const store = new ForgeSignInStore(join(home, "forges"));
  if (signedIn) {
    store.write("127.0.0.1", { token: "gho_app_sign_in", scopes: [], login: "o", createdAt: 1 });
  }
  // The person's own git config carries a helper that would answer with
  // another sign-in: the app must never let it speak for its host.
  const globalConfig = join(home, "gitconfig");
  writeFileSync(
    globalConfig,
    '[credential]\n\thelper = "!f() { echo username=someone-else; echo password=not-the-app; }; f"\n',
  );
  configureGitSignIn({
    askpass: ASKPASS,
    signInDir: store.root,
    hosts: [`127.0.0.1:${port}`],
  });
  return { home, globalConfig };
}

function lsRemote(port: number, globalConfig: string, home: string) {
  return new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = execFile(
      "git",
      ["ls-remote", `https://127.0.0.1:${port}/o/r.git`],
      {
        cwd: home,
        env: hostEnv({
          HOME: home,
          GIT_CONFIG_GLOBAL: globalConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_SSL_NO_VERIFY: "1",
        }),
        timeout: 20_000,
      },
      (error, _stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
      },
    );
    child.stdin?.end();
  });
}

/**
 * The same two answers from the git on the search path and, where
 * `pnpm install` vendored it (a Mac), from the app's own git, which a
 * crewmate's shell finds first (git integration phase 2).
 */
const appGit = resolveBundledGit(
  { packaged: false, appDir: join(__dirname, "../.."), resourcesDir: "" },
  {},
);
const gits = [
  { name: "the git on the search path", bundled: undefined },
  ...(appGit ? [{ name: "the app's own git", bundled: appGit }] : []),
];

describe.each(gits)("$name under the app", ({ bundled }) => {
  beforeEach(() => configureBundledGit(bundled));
  afterEach(() => configureBundledGit(undefined));

  it("answers the host with the app's own sign-in, never another helper's", async () => {
    const host = await challengingHost();
    const { home, globalConfig } = setup(true, host.port);
    const result = await lsRemote(host.port, globalConfig, home);
    expect(result.code).not.toBe(0);
    expect(host.auths).toContain("x-access-token:gho_app_sign_in");
    expect(host.auths.join("\n")).not.toContain("not-the-app");
  });

  it("answers a host on the person's own server signed in after the helper was named, with that host's own user name", async () => {
    const host = await challengingHost();
    const { home, globalConfig } = setup(false, host.port);
    const store = new ForgeSignInStore(join(home, "forges"));
    // The hosts are read at each spawn: a sign-in made since counts.
    const signedIn: string[] = [];
    configureGitSignIn({ askpass: ASKPASS, signInDir: store.root, hosts: () => signedIn });
    store.write("127.0.0.1", {
      token: "glpat_server_key",
      scopes: [],
      login: "o",
      createdAt: 1,
      kind: "gitlab",
      gitUser: "oauth2",
    });
    signedIn.push(`127.0.0.1:${host.port}`);
    const result = await lsRemote(host.port, globalConfig, home);
    expect(result.code).not.toBe(0);
    expect(host.auths).toContain("oauth2:glpat_server_key");
    expect(host.auths.join("\n")).not.toContain("not-the-app");
  });

  it("gives a host with no sign-in here nothing, and fails without waiting on a prompt", async () => {
    const host = await challengingHost();
    const { home, globalConfig } = setup(false, host.port);
    const result = await lsRemote(host.port, globalConfig, home);
    expect(result.code).not.toBe(0);
    expect(host.auths.join("\n")).not.toContain("not-the-app");
    expect(host.auths.join("\n")).not.toContain("gho_");
  });
});
