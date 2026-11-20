import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { STUB_LOGIN, startGitHubStub } from "./githubStub";

/** Host-owned fork facts for the contribution journey, beside the shared ordinary forge. */
export async function startContributionForge() {
  const base = await startGitHubStub();
  const upstream = {
    id: 101,
    full_name: "examples/project",
    clone_url: "https://github.com/examples/project.git",
    owner: { id: 1 },
    permissions: { push: false },
    default_branch: "main",
    private: false,
    visibility: "public",
  };
  // Match the disposable sign-in fixture's identity, rather than another account.
  const user = { id: 2, login: STUB_LOGIN };
  const fork = {
    ...upstream,
    id: 102,
    full_name: `${user.login}/project`,
    clone_url: `https://github.com/${user.login}/project.git`,
    owner: { id: user.id },
    permissions: { push: true },
    fork: true,
    parent: upstream,
    source: { id: upstream.id },
  };
  let created = false;
  let createCalls = 0;
  let openedNumber: number | undefined;
  let branchHead: ((project: string, branch: string) => string) | undefined;
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      const method = req.method ?? "GET";
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (method !== "GET") writes.push({ method, path: url.pathname, body });
      const send = (value: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (method === "GET" && url.pathname === "/user") return send(user);
      if (method === "GET" && url.pathname === "/repos/examples/project") return send(upstream);
      if (method === "GET" && url.pathname === `/repos/${fork.full_name}`)
        return created ? send(fork) : send({ message: "Not found" }, 404);
      if (method === "GET" && url.pathname === "/user/repos") return send(created ? [fork] : []);
      const ref = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/(.+)$/.exec(url.pathname);
      const project = ref?.[1];
      const branch = ref?.[2];
      if (method === "GET" && project && branch && branchHead)
        return send({
          object: { type: "commit", sha: branchHead(project, decodeURIComponent(branch)) },
        });
      if (method === "POST" && url.pathname === "/repos/examples/project/forks") {
        createCalls++;
        created = true;
        return send(fork, 202);
      }
      const posted = method === "POST" && url.pathname === "/repos/examples/project/pulls";
      const forwarded = posted
        ? { ...body, head: String(body.head).split(":").slice(1).join(":") }
        : body;
      const answer = await fetch(`${base.url}${url.pathname}${url.search}`, {
        method,
        headers: {
          ...(raw ? { "content-type": "application/json" } : {}),
          ...(typeof req.headers.authorization === "string"
            ? { authorization: req.headers.authorization }
            : {}),
        },
        ...(raw ? { body: JSON.stringify(forwarded) } : {}),
      });
      let value: unknown = await answer.json();
      if (posted && value && typeof value === "object" && "number" in value)
        openedNumber = Number(value.number);
      // Fork identity belongs to the head, never the upstream branch with the same name.
      if (url.pathname.includes("/pulls")) {
        const source = (item: unknown) => {
          if (!item || typeof item !== "object" || !("head" in item)) return item;
          const pull = item as { head: Record<string, unknown> };
          return { ...pull, head: { ...pull.head, repo: { full_name: fork.full_name } } };
        };
        value = Array.isArray(value) ? value.map(source) : source(value);
      }
      send(value, answer.status);
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ message: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    upstream,
    fork,
    writes,
    createCalls: () => createCalls,
    headOf: (read: (project: string, branch: string) => string) => {
      branchHead = read;
      base.headOf((branch) => read(fork.full_name, branch));
    },
    setExistingFork: () => {
      created = true;
    },
    env: { ...base.env, INFINITARY_GITHUB_API_URL: url },
    openedNumber: () => openedNumber,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await base.close();
    },
  };
}
