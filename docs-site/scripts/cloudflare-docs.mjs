// The read-only preflight before each publish of docs.getinfinitary.com
// (docs/docs-site.md, "Publishing"). It changes nothing:
//
//   pnpm --dir docs-site preflight
//
// Environment: CLOUDFLARE_API_TOKEN, the docs site's own key, sent only as a
// request header, and CLOUDFLARE_ACCOUNT_ID, the account it publishes to. The
// publish run reads both from the repository's Actions secrets
// CLOUDFLARE_DOCS_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
//
// It stops the publish when
// - the getinfinitary.com zone is missing or belongs to another account,
// - the zone's Always Use HTTPS setting is off, so plain http would serve the
//   site's static files instead of moving to https,
// - docs.getinfinitary.com is attached to a Worker other than infinitary-docs,
// - or a DNS record for docs.getinfinitary.com answers while no Worker of ours
//   owns the address, so a record someone else made is never taken over.
//
// Its output names the zone, the Worker on the address and the kinds of DNS
// answer, and never the key, the account id or the zone id.

import { Resolver } from "node:dns/promises";
import { pathToFileURL } from "node:url";

export const ZONE = "getinfinitary.com";
export const HOSTNAME = "docs.getinfinitary.com";
export const WORKER = "infinitary-docs";
const API = "https://api.cloudflare.com/client/v4";

export class PreflightError extends Error {}

/** A Cloudflare API reader whose messages never carry the key or an id. */
export function createClient({ token, accountId, fetchImpl = fetch }) {
  const shown = (path) => path.replaceAll(accountId, "{account}").replace(/\/zones\/[0-9a-f]{32}\//, "/zones/{zone}/");
  return async function get(path, what) {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new PreflightError(`${what}: no answer from Cloudflare (${error?.name ?? "error"}) for GET ${shown(path)}`);
    }
    const payload = await response.json().catch(() => null);
    if (response.status === 403) {
      throw new PreflightError(
        `${what}: HTTP 403. The key lacks the permission for GET ${shown(path)}; see docs/docs-site.md, "The key".`,
      );
    }
    if (!response.ok || payload?.success !== true) {
      const errors = (payload?.errors ?? []).map((error) => `${error.code}: ${error.message}`).join("; ");
      throw new PreflightError(`${what}: HTTP ${response.status} ${errors}`.trim());
    }
    return payload.result;
  };
}

/** The public DNS answers for the address, by kind; an address with none answers {}. */
export async function publicRecords(hostname, resolver = new Resolver()) {
  resolver.setServers?.(["1.1.1.1", "8.8.8.8"]);
  const answers = {};
  for (const [kind, ask] of [
    ["A", (name) => resolver.resolve4(name)],
    ["AAAA", (name) => resolver.resolve6(name)],
    ["CNAME", (name) => resolver.resolveCname(name)],
  ]) {
    try {
      const found = await ask(hostname);
      if (found.length) answers[kind] = found;
    } catch (error) {
      if (!["ENODATA", "ENOTFOUND"].includes(error?.code)) {
        throw new PreflightError(`Could not read the public DNS records for ${hostname} (${error?.code ?? error})`);
      }
    }
  }
  return answers;
}

/** Reads everything the decision depends on. Read-only. */
export async function readState(get, { accountId, resolver }) {
  const zones = await get(`/zones?name=${ZONE}`, "reading the zone");
  const zone = zones.find((each) => each.name === ZONE);
  const alwaysUseHttps = zone
    ? (await get(`/zones/${zone.id}/settings/always_use_https`, "reading the zone's Always Use HTTPS setting")).value
    : undefined;
  const domains = await get(
    `/accounts/${accountId}/workers/domains?hostname=${HOSTNAME}`,
    "reading the Workers on the address",
  );
  return { zones, alwaysUseHttps, domains, records: await publicRecords(HOSTNAME, resolver) };
}

/** Pure: whether the publish may go ahead, and why not. */
export function decide(state, { accountId }) {
  const conflicts = [];
  const zones = state.zones.filter((zone) => zone.name === ZONE);
  if (zones.length !== 1) conflicts.push(`the key reaches ${zones.length} zones named ${ZONE}, not one`);
  else if (zones[0].account?.id !== accountId) conflicts.push(`${ZONE} belongs to an account other than CLOUDFLARE_ACCOUNT_ID`);
  else if (state.alwaysUseHttps !== "on") {
    conflicts.push(`${ZONE}'s Always Use HTTPS is ${state.alwaysUseHttps ?? "unread"}, so plain http would not move to https`);
  }

  const attached = state.domains.filter((domain) => domain.hostname === HOSTNAME);
  for (const domain of attached.filter((each) => each.service !== WORKER)) {
    conflicts.push(`${HOSTNAME} is attached to the Worker ${domain.service}, not ${WORKER}`);
  }
  const owned = attached.some((domain) => domain.service === WORKER);
  const kinds = Object.keys(state.records);
  if (kinds.length > 0 && !owned) {
    conflicts.push(`${HOSTNAME} already answers DNS (${kinds.join(", ")}) and ${WORKER} does not own it`);
  }
  return { conflicts, owned, kinds };
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must both be set.");
    process.exit(2);
  }
  try {
    const state = await readState(createClient({ token, accountId }), { accountId });
    const { conflicts, owned, kinds } = decide(state, { accountId });
    console.log(`zone: ${ZONE} (${state.zones.length} found), Always Use HTTPS ${state.alwaysUseHttps ?? "unread"}`);
    console.log(`${HOSTNAME} attached to: ${state.domains.map((d) => d.service).join(", ") || "nothing yet"}`);
    console.log(`${HOSTNAME} public DNS: ${kinds.join(", ") || "none"}`);
    if (conflicts.length) {
      console.error(`Preflight stopped the publish:\n${conflicts.map((c) => `- ${c}`).join("\n")}`);
      process.exit(1);
    }
    console.log(owned ? `Preflight passed: ${WORKER} owns ${HOSTNAME}.` : `Preflight passed: ${HOSTNAME} is free for ${WORKER}.`);
  } catch (error) {
    if (!(error instanceof PreflightError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
