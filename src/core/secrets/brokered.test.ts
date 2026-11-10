import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { BrokeredUse } from "./brokers";
import { httpSecretBroker } from "./httpBroker";
import { ProtectedSecrets } from "./protected";
import { SHORT_READ_SECONDS, SHORT_READ_USES } from "./readAccess";
import { SECRET_REQUEST_LIFETIME_MS, SecretRequests } from "./requests";
import { SecretVault } from "./vault";

// Intent: INF-1109 and INF-785's handoff: approved brokered bearer/OAuth/MCP
// delivery and 600-second/20-use read permission, with the existing renewer
// retaining its protocol and no values or raw responses returned to agents.
const ACCESS = "ya29.invented-calendar-access";
const REFRESH = "1//invented-google-refresh";
const replies: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    replies.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const received: { url: string; authorization?: string; form: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
      form: Buffer.concat(chunks).toString(),
    });
    response.setHeader("content-type", "application/json");
    if (request.url === "/token")
      response.end(
        JSON.stringify({
          access_token: `${ACCESS}-renewed`,
          expires_in: 3600,
          token_type: "Bearer",
        }),
      );
    else if (request.url === "/redirect") {
      response.writeHead(302, { location: "/stolen" });
      response.end();
    } else if (request.url === "/mcp")
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    else
      response.end(
        JSON.stringify({
          kind: "calendar#events",
          items: [{ id: "planning", summary: "Planning" }],
        }),
      );
  });
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  replies.push(server);
  const base = `http://127.0.0.1:${port}`;
  const custody = disposableCustody();
  const dir = scratchDir("secrets-broker-");
  let now = 10_000;
  const broker = httpSecretBroker({
    id: "calendar",
    label: "Google Calendar",
    resolve(input) {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        typeof input.path !== "string"
      )
        return undefined;
      if (!["/events", "/other-events", "/token", "/mcp", "/redirect"].includes(input.path))
        return undefined;
      const renewal = input.path === "/token";
      return {
        url: `${base}${input.path}`,
        method: renewal || input.path === "/mcp" ? "POST" : "GET",
        ...(renewal
          ? { form: { client_id: "installed-desktop-client", grant_type: "refresh_token" } }
          : {}),
        ...(input.path === "/mcp"
          ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }
          : {}),
        credentials: {
          credential: {
            ref: renewal ? "google-refresh" : "google-access",
            delivery: renewal
              ? { kind: "form", name: "refresh_token" }
              : { kind: "header", name: "authorization", prefix: "Bearer " },
          },
        },
        operation: renewal
          ? "Renew Google sign-in"
          : input.path === "/mcp"
            ? "List connected actions"
            : "Read calendar events",
        read: !renewal,
        result: "Response to the trusted integration owner only",
      };
    },
    send: (url, init) => fetch(url, init),
  });
  const options = {
    dir,
    custody,
    environment: () => ({}),
    authentication: { available: async () => true, confirm: async () => true },
    now: () => now,
    brokers: [broker],
  };
  const backend = await ProtectedSecrets.open({ ...options, initialize: true });
  await backend.putSecret("google-access", "Google access", Buffer.from(ACCESS));
  await backend.putSecret("google-refresh", "Google refresh", Buffer.from(REFRESH));
  const requests = new SecretRequests(backend, options.now);
  const request = (id: string, path = "/events"): BrokeredUse => ({
    id,
    reason: "Read my planning calendar",
    broker: "calendar",
    input: { path },
  });
  const approve = async (receipt: { request: string }, short = false) => {
    const pending = requests.pending(receipt.request);
    if (!pending) throw new Error("Request is not waiting.");
    const proof = await (short
      ? backend.confirmShortRead(
          receipt.request,
          pending.digest,
          pending.expires,
          "Allow this exact read briefly",
        )
      : backend.confirmUse(
          receipt.request,
          pending.digest,
          pending.expires,
          "Allow this operation once",
        ));
    return requests.approve(receipt.request, proof);
  };
  return {
    received,
    custody,
    dir,
    options,
    backend,
    requests,
    request,
    approve,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function settled(requests: SecretRequests, request: string) {
  await expect.poll(() => requests.status(request)?.state).not.toBe("executing");
  return requests.status(request);
}

describe("protected brokered delivery", () => {
  it("waits, sends one bearer request on fresh approval, returns its response only to the trusted consumer, and never replays an intent", async () => {
    const f = await fixture();
    const receipt = await f.requests.broker(f.request("calendar-read"));
    expect(receipt.state).toBe("waiting");
    expect(f.received).toEqual([]);
    expect(await f.requests.approve(receipt.request, { kind: "local" })).toMatchObject({
      state: "waiting",
    });
    expect(await f.approve(receipt)).toEqual({ request: receipt.request, state: "completed" });
    expect(f.received).toEqual([{ url: "/events", authorization: `Bearer ${ACCESS}`, form: "" }]);
    const response = f.backend.takeBrokerResult(receipt.request);
    expect(response).toBeInstanceOf(Response);
    expect(await (response as Response).json()).toMatchObject({ items: [{ summary: "Planning" }] });
    expect(f.backend.takeBrokerResult(receipt.request)).toBeUndefined();
    expect(await f.requests.broker(f.request("calendar-read"))).toEqual({
      request: receipt.request,
      state: "completed",
    });
    await expect(f.requests.broker(f.request("calendar-read", "/other-events"))).rejects.toThrow(
      "different operation",
    );
    expect(f.received).toHaveLength(1);
    const exposed = JSON.stringify([
      f.requests.receipts(),
      f.backend.history(),
      f.backend.exportHistory(),
    ]);
    for (const secret of [ACCESS, REFRESH, Buffer.from(ACCESS).toString("base64")])
      expect(exposed).not.toContain(secret);
    expect(await readFile(join(f.dir, "history.jsonl"), "utf8")).not.toContain(ACCESS);
    expect(f.backend.history()[0]).toMatchObject({ state: "completed", approval: "local" });
  });

  it("caps racing exact reads at the chosen count, then asks again without carrying authority to another operation", async () => {
    const f = await fixture();
    const first = await f.requests.broker(f.request("first"));
    await f.approve(first, true);
    expect(f.backend.readPermissions()[0]?.remaining).toBe(SHORT_READ_USES - 1);
    const other = await f.requests.broker(f.request("other", "/other-events"));
    expect(other.state).toBe("waiting");
    const racing = await Promise.all(
      Array.from({ length: SHORT_READ_USES + 2 }, (_, i) =>
        f.requests.broker(f.request(`race-${i}`)),
      ),
    );
    await Promise.all(racing.map((receipt) => settled(f.requests, receipt.request)));
    expect(f.received).toHaveLength(SHORT_READ_USES);
    expect(f.backend.readPermissions()).toEqual([]);
    expect((await f.requests.broker(f.request("after-cap"))).state).toBe("waiting");
    expect(
      f.backend.history().filter((item) => item.approval === "short-read").length,
    ).toBeGreaterThan(0);
  });

  it.each(["expire", "end", "replace", "restart"] as const)(
    "invalidates short permission on %s",
    async (change) => {
      const f = await fixture();
      const first = await f.requests.broker(f.request("first"));
      await f.approve(first, true);
      if (change === "expire") f.advance(SHORT_READ_SECONDS * 1000);
      if (change === "end") f.backend.endReadAccess(f.backend.readPermissions()[0]?.id);
      if (change === "replace")
        await f.backend.putSecret(
          "google-access",
          "Google access",
          Buffer.from(`${ACCESS}-rotated`),
        );
      const backend = change === "restart" ? await ProtectedSecrets.open(f.options) : f.backend;
      const requests =
        change === "restart" ? new SecretRequests(backend, f.options.now) : f.requests;
      expect((await requests.broker(f.request("next"))).state).toBe("waiting");
      expect(f.received).toHaveLength(1);
      if (change === "restart")
        expect((await requests.broker(f.request("first"))).state).toBe("completed");
    },
  );

  it.each(["end", "expire"] as const)(
    "stops a consumed but unsent read after %s during value opening",
    async (change) => {
      const f = await fixture();
      const first = await f.requests.broker(f.request("first"));
      await f.approve(first, true);
      let entered = () => {};
      let resume = () => {};
      const opening = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const original = SecretVault.prototype.open;
      vi.spyOn(SecretVault.prototype, "open").mockImplementation(async function (
        this: SecretVault,
        ref: string,
      ) {
        entered();
        await held;
        return original.call(this, ref);
      });
      const next = await f.requests.broker(f.request("in-flight"));
      try {
        await opening;
        if (change === "end") f.backend.endReadAccess();
        else f.advance(SHORT_READ_SECONDS * 1000);
      } finally {
        resume();
      }
      expect((await settled(f.requests, next.request))?.state).toBe("invalidated");
      expect(f.received).toHaveLength(1);
    },
  );

  // INF-1254's review of INF-1109: revoke after the final metadata snapshot,
  // not only while opening a value. The held reading is an actual sealed entry.
  it.each(["end", "expire", "replace", "never"] as const)(
    "stops an unsent read after %s during the last metadata await",
    async (change) => {
      const f = await fixture();
      const first = await f.requests.broker(f.request("first"));
      await f.approve(first, true);
      const entered = deferred();
      const resume = deferred();
      let valueOpened = false;
      let held = false;
      const open = SecretVault.prototype.open;
      vi.spyOn(SecretVault.prototype, "open").mockImplementation(async function (
        this: SecretVault,
        ref: string,
      ) {
        const result = await open.call(this, ref);
        valueOpened = true;
        return result;
      });
      const entry = SecretVault.prototype.entry;
      vi.spyOn(SecretVault.prototype, "entry").mockImplementation(async function (
        this: SecretVault,
        ref: string,
      ) {
        const result = await entry.call(this, ref);
        if (valueOpened && !held) {
          held = true;
          entered.resolve();
          await resume.promise;
        }
        return result;
      });
      const next = await f.requests.broker(f.request("last-metadata-read"));
      try {
        await entered.promise;
        if (change === "end") f.backend.endReadAccess();
        if (change === "expire") f.advance(SHORT_READ_SECONDS * 1000);
        if (change === "replace")
          await f.backend.putSecret("google-access", "Google access", Buffer.from(`${ACCESS}-new`));
        if (change === "never") {
          const proposal = f.backend.proposeAuthority({
            rules: [{ id: "stop", effect: "never", secret: "google-access" }],
            devices: [],
          });
          if (!proposal) throw new Error("No policy proposal.");
          const proof = await f.backend.confirmAuthority(
            proposal.digest,
            f.options.now() + SECRET_REQUEST_LIFETIME_MS,
            "Stop calendar access",
          );
          expect(await f.backend.saveAuthority(proposal.authority, proof)).toBe("stored");
        }
      } finally {
        resume.resolve();
      }
      expect((await settled(f.requests, next.request))?.state).toBe("invalidated");
      expect(f.received).toHaveLength(1);
    },
  );

  it("invalidates a waiting use if a removed reference is added again with the same displayed version", async () => {
    const f = await fixture();
    const receipt = await f.requests.broker(f.request("waiting-before-replacement"));
    const version = (await f.backend.metadata()).find(
      (entry) => entry.ref === "google-access",
    )?.version;
    await f.backend.forgetSecret("google-access");
    await f.backend.putSecret(
      "google-access",
      "Replacement account",
      Buffer.from(`${ACCESS}-replacement`),
    );
    expect(
      (await f.backend.metadata()).find((entry) => entry.ref === "google-access")?.version,
    ).toBe(version);
    expect((await f.approve(receipt))?.state).toBe("invalidated");
    expect(f.received).toEqual([]);
  });

  it.each(["before approval", "during opening"] as const)(
    "refuses a different authentic record at the same version substituted %s",
    async (when) => {
      // INF-1109 binds approval to the exact credential, not a reusable display version.
      // Replay a real earlier sealed file; no forged MAC or fabricated read is involved.
      const f = await fixture();
      const folder = join(f.dir, "values");
      let path = "";
      let earlier: Buffer | undefined;
      for (const file of await readdir(folder)) {
        const candidate = await readFile(join(folder, file));
        if (JSON.parse(candidate.toString()).entry.ref === "google-access") {
          path = join(folder, file);
          earlier = candidate;
        }
      }
      if (!earlier) throw new Error("No sealed access record.");
      await f.backend.forgetSecret("google-access");
      await f.backend.putSecret("google-access", "Google access", Buffer.from(`${ACCESS}-new`));
      const receipt = await f.requests.broker(f.request("exact-record"));
      if (when === "before approval") await writeFile(path, earlier);
      else {
        const open = SecretVault.prototype.open;
        const saved = earlier;
        vi.spyOn(SecretVault.prototype, "open").mockImplementationOnce(async function (
          this: SecretVault,
          ref: string,
        ) {
          await writeFile(path, saved);
          return open.call(this, ref);
        });
      }
      expect((await f.approve(receipt))?.state).toBe("invalidated");
      expect(f.received).toEqual([]);
    },
  );

  it("does not spend a short read on OAuth renewal; only its one-use approval delivers the form to the existing renewer", async () => {
    const f = await fixture();
    const first = await f.requests.broker(f.request("first"));
    await f.approve(first, true);
    const renewal = await f.requests.broker(f.request("renew", "/token"));
    expect(renewal.state).toBe("waiting");
    const pending = f.requests.pending(renewal.request);
    if (!pending) throw new Error("No renewal request.");
    expect(
      await f.backend.confirmShortRead(renewal.request, pending.digest, pending.expires, "Renew"),
    ).toBeUndefined();
    expect((await f.approve(renewal))?.state).toBe("completed");
    expect(new URLSearchParams(f.received[1]?.form)).toEqual(
      new URLSearchParams({
        client_id: "installed-desktop-client",
        grant_type: "refresh_token",
        refresh_token: REFRESH,
      }),
    );
    const response = f.backend.takeBrokerResult(renewal.request) as Response;
    expect(await response.json()).toMatchObject({ access_token: `${ACCESS}-renewed` });
    expect(f.backend.readPermissions()[0]?.remaining).toBe(SHORT_READ_USES - 1);
    expect(JSON.stringify(f.requests.receipts())).not.toContain(REFRESH);
  });

  it("lets the registered remote MCP owner classify its POST read and applies the bearer only inside its transport", async () => {
    const f = await fixture();
    const receipt = await f.requests.broker(f.request("list-actions", "/mcp"));
    expect(f.backend.describeBrokered(receipt.request)?.shortReadEligible).toBe(true);
    await f.approve(receipt, true);
    expect(f.received[0]).toMatchObject({ url: "/mcp", authorization: `Bearer ${ACCESS}` });
    expect(JSON.parse(f.received[0]?.form ?? "")).toMatchObject({ method: "tools/list" });
    expect(await (f.backend.takeBrokerResult(receipt.request) as Response).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
  });

  it("refuses unregistered adapters, unavailable custody, and redirected requests without leaking or replaying", async () => {
    const f = await fixture();
    expect(
      (await f.requests.broker({ ...f.request("unknown"), broker: "agent-written" })).state,
    ).toBe("unavailable");
    const redirect = await f.requests.broker(f.request("redirect", "/redirect"));
    expect((await f.approve(redirect))?.state).toBe("unknown");
    expect(f.received.map((request) => request.url)).toEqual(["/redirect"]);
    expect((await f.requests.broker(f.request("redirect", "/redirect"))).state).toBe("unknown");
    f.custody.state = "locked";
    expect((await f.requests.broker(f.request("locked"))).state).toBe("unavailable");
    expect(f.received).toHaveLength(1);
  });

  it("End access invalidates an unspent short-read proof, and ordinary approval cannot mint a bounded grant", async () => {
    const f = await fixture();
    const receipt = await f.requests.broker(f.request("read"));
    const pending = f.requests.pending(receipt.request);
    if (!pending) throw new Error("No request.");
    const proof = await f.backend.confirmShortRead(
      receipt.request,
      pending.digest,
      pending.expires,
      "Read briefly",
    );
    f.backend.endReadAccess();
    expect((await f.requests.approve(receipt.request, proof))?.state).toBe("waiting");
    await f.approve(receipt);
    expect(f.backend.readPermissions()).toEqual([]);
    expect(f.received).toHaveLength(1);
  });
});
