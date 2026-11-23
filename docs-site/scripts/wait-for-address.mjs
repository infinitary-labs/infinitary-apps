// Waits after a publish until docs.getinfinitary.com answers at its zone's own
// name servers (docs/docs-site.md, "Verify"), so the live check's first lookup
// through this computer's resolver finds the address:
//
//   node docs-site/scripts/wait-for-address.mjs [--within <seconds>]
//
// A publish that attaches a new address (the first one, or one after the site
// was withdrawn) gets its DNS record a few seconds after the upload says it is
// done. A resolver asked before then hears "no such name" and keeps that answer
// for the zone's negative time, 30 minutes for getinfinitary.com, so a live
// check that asks too early fails for half an hour while the site already
// serves. The zone's own name servers keep no such answer: this asks each of
// their addresses directly, and never asks this computer's resolver about the
// address, until none of them still says the name is missing. An address that
// already answers, as on every later publish, passes at once.
//
// It asks the name servers' IPv4 addresses only, since GitHub's hosted runners
// have no IPv6.

import { Resolver } from "node:dns/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { HOSTNAME, ZONE } from "./cloudflare-docs.mjs";

export class WaitError extends Error {}

const MISSING = ["ENOTFOUND", "ENODATA"];

/** A resolver that asks only the one name server address, briefly, keeping nothing between rounds. */
function askOnly(address) {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers([address]);
  return resolver;
}

/** The IPv4 addresses of zone's name servers, read through this computer's resolver, which is never asked about the address itself. */
async function nameServerAddresses(zone, system) {
  try {
    const names = await system.resolveNs(zone);
    const addresses = (await Promise.all(names.map((name) => system.resolve4(name)))).flat();
    if (addresses.length === 0) throw Object.assign(new Error("no addresses"), { code: "ENODATA" });
    return [...new Set(addresses)].toSorted();
  } catch (error) {
    throw new WaitError(`Could not read ${zone}'s name servers (${error?.code ?? error})`);
  }
}

/**
 * Waits until no name server address of zone says hostname is missing and at
 * least one answers its IPv4 addresses, then answers them. An address that
 * does not answer at all counts as neither, since a resolver moves on from it.
 * Throws a WaitError when the name is still missing after within milliseconds.
 * system, ask, sleep and now are this computer's resolver, the per-address
 * resolver, the pause between rounds and the clock, or stand-ins in tests.
 */
export async function waitForAddress({
  hostname = HOSTNAME,
  zone = ZONE,
  within = 600_000,
  every = 2_000,
  system = new Resolver(),
  ask = askOnly,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = () => {},
} = {}) {
  const servers = await nameServerAddresses(zone, system);
  const started = now();
  let shown = "";
  for (;;) {
    const rounds = await Promise.all(
      servers.map((server) =>
        ask(server)
          .resolve4(hostname)
          .then(
            (found) => ({ server, found }),
            (error) => ({ server, missing: MISSING.includes(error?.code), code: error?.code ?? String(error) }),
          ),
      ),
    );
    const answering = rounds.filter((round) => round.found?.length);
    const missing = rounds.filter((round) => !round.found?.length && round.missing !== false);
    const silent = rounds.filter((round) => round.missing === false);
    const seconds = Math.round((now() - started) / 1000);
    const state = `${answering.length} of ${servers.length} answer, ${missing.length} say no such name${
      silent.length ? `, ${silent.length} did not answer (${silent.map((round) => round.code).join(", ")})` : ""
    }`;
    if (missing.length === 0 && answering.length > 0) {
      const addresses = [...new Set(answering.flatMap((round) => round.found))].toSorted();
      return { addresses, seconds, servers: servers.length, state };
    }
    if (now() - started >= within) {
      throw new WaitError(`${hostname} still has no address at ${zone}'s name servers after ${seconds} s: ${state}.`);
    }
    if (state !== shown) log(`${seconds} s: ${hostname} at ${zone}'s ${servers.length} name server addresses: ${state}`);
    shown = state;
    await sleep(every);
  }
}

async function main() {
  const { values } = parseArgs({ options: { within: { type: "string", default: "600" } } });
  const within = Number(values.within);
  if (!Number.isFinite(within) || within < 0) {
    console.error("usage: wait-for-address.mjs [--within <seconds>]");
    process.exit(2);
  }
  try {
    const { addresses, seconds, state } = await waitForAddress({ within: within * 1000, log: console.log });
    console.log(`${HOSTNAME} answers at ${ZONE}'s name servers after ${seconds} s (${state}): ${addresses.join(", ")}`);
  } catch (error) {
    if (!(error instanceof WaitError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
