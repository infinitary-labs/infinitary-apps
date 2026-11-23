// The docs site's publish checks (docs/docs-site.md, "Publishing"): the
// preflight that refuses to take over an address someone else owns, the wait
// for a new address before the live check's first lookup, and the live checks
// that decide whether a publish produced a working site.
//
//   pnpm --dir docs-site test

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createClient, decide, HOSTNAME, publicRecords, readState, WORKER } from "./cloudflare-docs.mjs";
import { checkLive } from "./live-checks.mjs";
import { waitForAddress, WaitError } from "./wait-for-address.mjs";

const ACCOUNT = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

// Cloudflare's answers in the shape its API gives them (GET /zones and
// GET /accounts/{account}/workers/domains), ids replaced.
const zone = {
  id: "9a8b7c6d5e4f30211203f4e5d6c7b8a9",
  name: "getinfinitary.com",
  status: "active",
  account: { id: ACCOUNT, name: "Infinitary" },
};
const docsDomain = (service) => ({
  id: "e7a1c0d4b3f2e1d0c9b8a7f6e5d4c3b2",
  zone_id: zone.id,
  zone_name: "getinfinitary.com",
  hostname: HOSTNAME,
  service,
  environment: "production",
  cert_id: "4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e",
});
// What public DNS answers for a Worker's custom domain: Cloudflare's own addresses.
const workerAnswers = { A: ["104.21.32.1", "172.67.150.2"], AAAA: ["2606:4700:3030::6815:2001"] };

describe("the preflight", () => {
  it("lets the first publish take a free address", () => {
    assert.deepEqual(decide({ zones: [zone], alwaysUseHttps: "on", domains: [], records: {} }, { accountId: ACCOUNT }), {
      conflicts: [],
      owned: false,
      kinds: [],
    });
  });

  it("lets a later publish replace the Worker that already owns the address", () => {
    const state = { zones: [zone], alwaysUseHttps: "on", domains: [docsDomain(WORKER)], records: workerAnswers };
    assert.deepEqual(decide(state, { accountId: ACCOUNT }).conflicts, []);
  });

  it("stops when a DNS record someone else made already answers for the address", () => {
    const state = { zones: [zone], alwaysUseHttps: "on", domains: [], records: { CNAME: ["infinitary-labs.github.io"] } };
    assert.deepEqual(decide(state, { accountId: ACCOUNT }).conflicts, [
      `${HOSTNAME} already answers DNS (CNAME) and ${WORKER} does not own it`,
    ]);
  });

  it("stops when another Worker serves the address", () => {
    const state = { zones: [zone], alwaysUseHttps: "on", domains: [docsDomain("infinitary-site")], records: workerAnswers };
    assert.deepEqual(decide(state, { accountId: ACCOUNT }).conflicts, [
      `${HOSTNAME} is attached to the Worker infinitary-site, not ${WORKER}`,
      `${HOSTNAME} already answers DNS (A, AAAA) and ${WORKER} does not own it`,
    ]);
  });

  it("stops when the zone belongs to another account or is out of the key's reach", () => {
    const other = { ...zone, account: { id: "1".repeat(32), name: "Someone else" } };
    assert.deepEqual(decide({ zones: [other], domains: [], records: {} }, { accountId: ACCOUNT }).conflicts, [
      "getinfinitary.com belongs to an account other than CLOUDFLARE_ACCOUNT_ID",
    ]);
    assert.deepEqual(decide({ zones: [], domains: [], records: {} }, { accountId: ACCOUNT }).conflicts, [
      "the key reaches 0 zones named getinfinitary.com, not one",
    ]);
  });

  // Plain http to the site's static files moves to https only through the
  // zone's own setting; the Worker runs no code that could do it.
  it("stops when the zone leaves plain http unredirected", () => {
    assert.deepEqual(decide({ zones: [zone], alwaysUseHttps: "off", domains: [], records: {} }, { accountId: ACCOUNT }).conflicts, [
      "getinfinitary.com's Always Use HTTPS is off, so plain http would not move to https",
    ]);
  });

  it("reads the zone's Always Use HTTPS setting, naming no zone id when it is refused", async () => {
    const answers = (setting) => async (url) => {
      if (url.includes("/settings/always_use_https")) {
        return setting === 403
          ? new Response(JSON.stringify({ success: false, errors: [] }), { status: 403 })
          : new Response(JSON.stringify({ success: true, result: { id: "always_use_https", value: setting, editable: true } }));
      }
      if (url.includes("/workers/domains")) return new Response(JSON.stringify({ success: true, result: [] }));
      return new Response(JSON.stringify({ success: true, result: [zone] }));
    };
    const resolver = { resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [] };
    const read = (setting) =>
      readState(createClient({ token: "k", accountId: ACCOUNT, fetchImpl: answers(setting) }), { accountId: ACCOUNT, resolver });
    assert.equal((await read("on")).alwaysUseHttps, "on");
    assert.equal((await read("off")).alwaysUseHttps, "off");
    const refusal = await read(403).catch((e) => e);
    assert.match(refusal.message, /GET \/zones\/\{zone\}\/settings\/always_use_https/);
    assert.ok(!refusal.message.includes(zone.id));
  });

  it("asks Cloudflare with the key in a header only, and names no id or key when it is refused", async () => {
    const token = "docs-key-under-test";
    const asked = [];
    const fetchImpl = async (url, init) => {
      asked.push({ url, init });
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), {
        status: 403,
      });
    };
    const get = createClient({ token, accountId: ACCOUNT, fetchImpl });
    const refusal = await readState(get, { accountId: ACCOUNT, resolver: { resolve4: async () => [] } }).catch((e) => e);
    assert.match(refusal.message, /HTTP 403\. The key lacks the permission for GET \/zones\?name=getinfinitary\.com/);
    assert.equal(asked[0].init.headers.Authorization, `Bearer ${token}`);
    assert.ok(!asked[0].url.includes(token));

    const fetchDomains = async (url) =>
      url.includes("/workers/domains")
        ? new Response(JSON.stringify({ success: false, errors: [] }), { status: 403 })
        : new Response(JSON.stringify({ success: true, result: [zone] }), { status: 200 });
    const second = await readState(createClient({ token, accountId: ACCOUNT, fetchImpl: fetchDomains }), {
      accountId: ACCOUNT,
    }).catch((e) => e);
    assert.match(second.message, /GET \/accounts\/\{account\}\/workers\/domains/);
    assert.ok(!second.message.includes(ACCOUNT) && !second.message.includes(token));
  });

  it("reads an address with no DNS records as free, and an unreadable answer as a stop", async () => {
    const none = Object.assign(new Error("queryA ENODATA"), { code: "ENODATA" });
    const empty = { resolve4: async () => Promise.reject(none), resolve6: async () => Promise.reject(none), resolveCname: async () => Promise.reject(none) };
    assert.deepEqual(await publicRecords(HOSTNAME, empty), {});
    const broken = { ...empty, resolve6: async () => Promise.reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })) };
    await assert.rejects(publicRecords(HOSTNAME, broken), /Could not read the public DNS records/);
  });
});

// The site's first publish: the live check asked the runner's resolver about
// the address 0.1 s after the upload, before its DNS record existed, and the
// resolver kept that "no such name" for the zone's negative time of 30
// minutes, so every try failed while the site already served. The name
// servers and answers are getinfinitary.com's own, as dig read them.
describe("the wait for a new address", () => {
  const NAME_SERVERS = {
    "amy.ns.cloudflare.com": ["173.245.58.101", "172.64.32.101", "108.162.192.101"],
    "ignacio.ns.cloudflare.com": ["108.162.195.82", "162.159.44.82", "172.64.35.82"],
  };
  const SERVED = ["172.67.214.47", "104.21.93.194"];
  const failure = (code) => Object.assign(new Error(`queryA ${code} ${HOSTNAME}`), { code });

  /** This computer's resolver, noting every name it is asked about. */
  function systemResolver(asked) {
    return {
      resolveNs: async (name) => (asked.push(name), Object.keys(NAME_SERVERS)),
      resolve4: async (name) => (asked.push(name), NAME_SERVERS[name]),
    };
  }

  /** A clock that moves only when the wait pauses, and the pauses it took. */
  function clock() {
    const state = { at: 0, pauses: 0 };
    return { state, now: () => state.at, sleep: async (ms) => ((state.at += ms), state.pauses++) };
  }

  it("asks only the zone's name servers until none says the address is missing", async () => {
    const asked = [];
    const { state, now, sleep } = clock();
    // Round by round, each name server address's answer: missing everywhere,
    // then at one name server's addresses, then answered everywhere but one
    // address that does not answer at all.
    const rounds = [
      () => Promise.reject(failure("ENOTFOUND")),
      (server) => (NAME_SERVERS["amy.ns.cloudflare.com"].includes(server) ? Promise.resolve(SERVED) : Promise.reject(failure("ENOTFOUND"))),
      (server) => (server === "162.159.44.82" ? Promise.reject(failure("ETIMEOUT")) : Promise.resolve(SERVED)),
    ];
    const ask = (server) => ({ resolve4: async (name) => (assert.equal(name, HOSTNAME), rounds[state.pauses](server)) });
    const found = await waitForAddress({ system: systemResolver(asked), ask, now, sleep });
    assert.deepEqual(found.addresses, SERVED.toSorted());
    assert.equal(state.pauses, 2);
    assert.ok(!asked.includes(HOSTNAME), `this computer's resolver was asked about ${HOSTNAME}`);
  });

  it("passes at once for an address that already answers", async () => {
    const { state, now, sleep } = clock();
    const ask = () => ({ resolve4: async () => SERVED });
    const found = await waitForAddress({ system: systemResolver([]), ask, now, sleep });
    assert.equal(found.servers, 6);
    assert.equal(state.pauses, 0);
  });

  it("stops, naming what the name servers say, when the address never appears", async () => {
    const { now, sleep } = clock();
    const ask = () => ({ resolve4: async () => Promise.reject(failure("ENOTFOUND")) });
    const stopped = await waitForAddress({ system: systemResolver([]), ask, now, sleep, within: 600_000 }).catch((e) => e);
    assert.ok(stopped instanceof WaitError);
    assert.equal(
      stopped.message,
      `${HOSTNAME} still has no address at getinfinitary.com's name servers after 600 s: 0 of 6 answer, 6 say no such name.`,
    );
  });
});

// Answers recorded from Cloudflare's own local runtime serving this Worker and
// the built site (fixtures/served.json); plain http is getinfinitary.com's
// own answer, its address moved to the docs host.
const served = JSON.parse(await readFile(new URL("fixtures/served.json", import.meta.url), "utf8"));
const ORIGIN = "https://docs.getinfinitary.com";

// The build's pages, as the recorded answers carry them.
const built = { home: served["/"].body, inner: served["/install/"].body, notFound: served["/no-such-page/"].body };

/** A stand-in fetch answering each address with a recorded answer, changed by edit. */
function servedFetch(edit = (answer) => answer) {
  return async (url) => {
    const { protocol, pathname, search } = new URL(url);
    const key = protocol === "http:" ? "plain-http" : pathname.startsWith("/no-such-page") ? "/no-such-page/" : pathname;
    let answer = structuredClone(served[key]);
    if (key === "plain-http") answer.headers.location = `${ORIGIN}${pathname}${search}`;
    answer = edit(answer, key);
    return new Response(answer.status === 301 ? null : answer.body, { status: answer.status, headers: answer.headers });
  };
}

describe("the live checks", () => {
  it("pass for the site as Cloudflare serves it", async () => {
    const results = await checkLive(ORIGIN, { built, fetchImpl: servedFetch() });
    assert.deepEqual(results.filter((r) => !r.ok), []);
    assert.ok(results.some((r) => r.name === "plain http: moves to https"));
  });

  it("fail when the build's headers did not reach the answers", async () => {
    const bare = servedFetch((answer) => {
      delete answer.headers["content-security-policy"];
      delete answer.headers["x-frame-options"];
      return answer;
    });
    const failed = (await checkLive(ORIGIN, { built, fetchImpl: bare })).filter((r) => !r.ok).map((r) => r.name);
    assert.deepEqual(failed, ["home page: security headers", "inner page: security headers", "unknown address: security headers"]);
  });

  it("fail when an unknown address answers anything but the site's own not-found page", async () => {
    const soft = servedFetch((answer, key) => (key === "/no-such-page/" ? served["/"] : answer));
    const failed = (await checkLive(ORIGIN, { built, fetchImpl: soft })).filter((r) => !r.ok).map((r) => r.name);
    assert.deepEqual(failed, [
      "unknown address: answers 404",
      "unknown address: the site's own not-found page",
      "unknown address: exactly as built",
    ]);
  });

  // The site's first publish: Cloudflare's edge added its Web Analytics script
  // to every page a browser asked for, as recorded from the live site (its
  // token replaced), while the pages said only what Cloudflare sends on its own.
  it("fail when Cloudflare's edge changes the pages on their way", async () => {
    const beacon =
      '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092" integrity="sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw==" data-cf-beacon=\'{"version":"2024.11.0","token":"5d1c0e2f8a4b49c7b3e6a1d0f9c8b7a6","r":1,"spa":2}\' crossorigin="anonymous"></script>';
    const edge = servedFetch((answer, key) =>
      key === "plain-http"
        ? answer
        : { ...answer, body: answer.body + beacon, headers: { ...answer.headers, "cache-control": "public, max-age=0, must-revalidate" } },
    );
    const failures = (await checkLive(ORIGIN, { built, fetchImpl: edge })).filter((r) => !r.ok);
    assert.deepEqual(
      failures.map((r) => r.name),
      [
        "home page: exactly as built",
        "home page: says no-transform",
        "inner page: exactly as built",
        "inner page: says no-transform",
        "unknown address: exactly as built",
        "unknown address: says no-transform",
      ],
    );
    assert.match(failures[0].detail, /the answer holds: <script type="module" src="https:\/\/static\.cloudflareinsights\.com\//);
  });

  it("fail when plain http serves the page instead of moving to https", async () => {
    const plain = servedFetch((answer, key) => (key === "plain-http" ? served["/install/"] : answer));
    const failed = (await checkLive(ORIGIN, { built, fetchImpl: plain })).filter((r) => !r.ok).map((r) => r.name);
    assert.deepEqual(failed, ["plain http: moves to https"]);
  });

  it("fail when a page sets a cookie", async () => {
    const cookie = servedFetch((answer, key) =>
      key === "/" ? { ...answer, headers: { ...answer.headers, "set-cookie": "visitor=1; Path=/" } } : answer,
    );
    const failed = (await checkLive(ORIGIN, { built, fetchImpl: cookie })).filter((r) => !r.ok).map((r) => r.name);
    assert.deepEqual(failed, ["home page: no cookie"]);
  });
});

// Piece 2 of the docs site's plan: the Worker publishes to one address, with
// no workers.dev copy, preview addresses, logs or metrics, read as the
// publish tool itself reads the config.
describe("the Worker's config", () => {
  it("publishes infinitary-docs only at docs.getinfinitary.com, with nothing else switched on", async () => {
    const { unstable_readConfig } = await import("wrangler");
    const config = unstable_readConfig({ config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)) });
    assert.equal(config.name, WORKER);
    assert.deepEqual(config.routes, [{ pattern: HOSTNAME, custom_domain: true }]);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.equal(config.observability?.enabled, false);
    assert.equal(config.upload_source_maps, false);
    assert.equal(config.send_metrics, false);
    assert.equal(config.main, undefined, "the Worker runs no code of its own");
    assert.equal(config.assets?.not_found_handling, "404-page");
  });
});
