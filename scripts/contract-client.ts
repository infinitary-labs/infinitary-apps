import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { connect, type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { WebSocket } from "ws";

/**
 * A client of a Firstmate home written against the published contract alone
 * (docs/contract.md): every channel name, shape, path, limit and version it
 * uses comes from docs/contract.json, read at start, and it imports nothing
 * of the app. It runs under plain Node, which could not load the app's own
 * modules if it tried.
 *
 *   node scripts/contract-client.ts --grant grant.json [--contract docs/contract.json]
 *     [--speak 1.56.0] [--floor 11] [--cursor <epoch>:<seq>]
 *
 * `--grant` is a device's saved grant (docs/devices.md, "Joining"): where it
 * dials, the home's pin, and its own key and certificate. `--speak` is the
 * contract version its hello names, the file's own by default, so it can
 * stand in an older or newer client under the version rule. `--floor` is the
 * oldest home major its hello says it changes things on (the view floor), the
 * file's own by default. It reads a value from one of the file's open lists
 * that the file does not list as that list's unknown, as a view does.
 *
 * It reads requests from stdin, one JSON line each: `{ "id", "channel",
 * "args" }`. It writes one JSON line per event to stdout: the `welcome`, each
 * `result`, each `push`, a request it `refused` itself because the file has
 * no such channel or the arguments do not fit it, any frame or answer from
 * the home that does not fit the file as `invalid`, and `closed`. It hides
 * nothing the version rule would: it sends what it is asked, to show what
 * the home answers. It exits when stdin ends or the home closes, with 1 if
 * anything was invalid.
 */

type JsonSchema = Record<string, unknown>;
type OpenList = { members: unknown[]; unknown: unknown };
type Contract = {
  protocolVersion: string;
  versionRule: { viewFloor?: number; openLists?: OpenList[] };
  connection: {
    path: string;
    maxFrameBytes: number;
    clientFrame: JsonSchema;
    homeFrame: JsonSchema;
  };
  requests: Record<string, { effect: string; reach: string; request: JsonSchema; response: JsonSchema }>;
  pushes: Record<string, { payload: JsonSchema }>;
};
type Issue = { keyword: string; instancePath: string; params: Record<string, unknown> };

/**
 * Replaces each value an enum issue points at with its open list's unknown,
 * when the issue's allowed values are exactly one of the file's open lists.
 * True when it replaced one. A value from any other closed set stays wrong.
 */
function keepUnknownMembers(root: unknown, issues: readonly Issue[], openLists: readonly OpenList[]) {
  let replaced = false;
  for (const issue of issues) {
    if (issue.keyword !== "enum" || !issue.instancePath) continue;
    const allowed = issue.params.allowedValues;
    if (!Array.isArray(allowed)) continue;
    const open = openLists.find(
      ({ members }) =>
        members.length === allowed.length && members.every((member) => allowed.includes(member)),
    );
    if (!open) continue;
    const path = issue.instancePath.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    const key = path.pop() as string;
    let parent: unknown = root;
    for (const part of path) parent = (parent as Record<string, unknown> | null)?.[part];
    if (parent === null || typeof parent !== "object") continue;
    const current = (parent as Record<string, unknown>)[key];
    if (typeof current !== "string" || allowed.includes(current)) continue;
    (parent as Record<string, unknown>)[key] = open.unknown;
    replaced = true;
  }
  return replaced;
}

/** Whether what the home sent fits once each unknown member of an open list reads as its unknown. */
export function readsKeepingOpen(validate: ValidateFunction, value: unknown, openLists: readonly OpenList[]) {
  if (validate(value)) return true;
  const copy = structuredClone(value);
  // Each pass replaces at least one unknown member, and a value holds finitely many.
  while (keepUnknownMembers(copy, (validate.errors ?? []) as Issue[], openLists))
    if (validate(copy)) return true;
  return false;
}

type Grant = { at: string; homeKey: string; key: string; cert: string };
type Asked = { id: string | number; channel: string; args: unknown };

const DEFAULT_CONTRACT = join(fileURLToPath(new URL("..", import.meta.url)), "docs", "contract.json");

/** Where a dial address points, as `host:port` or `[v6]:port`. */
function addressOf(at: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(at);
  if (!match) throw new Error(`The grant's address is not host:port: ${at}`);
  return { host: match[1] ?? match[2] ?? "", port: Number(match[3]) };
}

/** TLS 1.3 showing the device's key, resolved only once the home's key hashes to its pin. */
function pinnedSocket(grant: Grant): Promise<TLSSocket> {
  const { host, port } = addressOf(grant.at);
  return new Promise((resolvePinned, reject) => {
    const socket = connect({
      host,
      port,
      servername: isIP(host) ? "" : host,
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      key: grant.key,
      cert: grant.cert,
    });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const spki = socket
        .getPeerX509Certificate()
        ?.publicKey.export({ type: "spki", format: "der" });
      const pin = spki ? createHash("sha256").update(spki).digest("base64url") : null;
      if (pin !== grant.homeKey) {
        socket.destroy();
        reject(new Error("The computer at this address is not the home the grant names."));
        return;
      }
      socket.off("error", reject);
      resolvePinned(socket);
    });
  });
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      grant: { type: "string" },
      contract: { type: "string", default: DEFAULT_CONTRACT },
      speak: { type: "string" },
      floor: { type: "string" },
      cursor: { type: "string" },
    },
  });
  if (!values.grant) throw new Error("--grant <file> names the device's saved grant");
  const contract = JSON.parse(readFileSync(resolve(values.contract), "utf8")) as Contract;
  const grant = JSON.parse(readFileSync(resolve(values.grant), "utf8")) as Grant;

  // Formats are annotations in this dialect; the shapes themselves are strict.
  const ajv = new Ajv2020({ strict: true, strictTuples: false, validateFormats: false });
  const compiled = new Map<JsonSchema, ValidateFunction>();
  /** Null when the value fits the published shape; otherwise what does not. */
  const fits = (schema: JsonSchema, value: unknown) => {
    let validate = compiled.get(schema);
    if (!validate) {
      try {
        validate = ajv.compile(schema);
      } catch (error) {
        return `the file's shape does not compile: ${(error as Error).message}`;
      }
      compiled.set(schema, validate);
    }
    return validate(value) ? null : ajv.errorsText(validate.errors);
  };
  /** As fits, for what the home sends: an unknown member of an open list reads as its unknown. */
  const reads = (schema: JsonSchema, value: unknown) => {
    const first = fits(schema, value);
    const validate = compiled.get(schema);
    if (!first || !validate) return first;
    return readsKeepingOpen(validate, value, contract.versionRule.openLists ?? []) ? null : first;
  };

  let invalid = 0;
  const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const notFitting = (what: string, errors: string) => {
    invalid += 1;
    say({ t: "invalid", what, errors });
  };

  const socket = await pinnedSocket(grant);
  const { host, port } = addressOf(grant.at);
  const ws = new WebSocket(
    `wss://${host.includes(":") ? `[${host}]` : host}:${port}${contract.connection.path}`,
    {
      createConnection: () => socket,
      perMessageDeflate: false,
      maxPayload: contract.connection.maxFrameBytes,
    },
  );
  const asked = new Map<string | number, string>();
  const send = (frame: Record<string, unknown>) => {
    const problem = fits(contract.connection.clientFrame, frame);
    if (problem) throw new Error(`This client would send a frame the contract refuses: ${problem}`);
    ws.send(JSON.stringify(frame));
  };

  // docs/connection.md: a validated parts header names the UTF-8 byte length
  // of the next logical frame. Join its bytes before decoding or validating
  // it; the app's internal joiner is not part of this client's published surface.
  let remaining = 0;
  let parts: Buffer[] = [];
  ws.on("message", (raw) => {
    // ws delivers text messages as Buffers with its default binaryType.
    const message = raw as Buffer;
    let text: string;
    if (remaining > 0) {
      remaining -= message.length;
      if (remaining < 0) {
        remaining = 0;
        parts = [];
        notFitting("frame parts", "The parts exceed the length their header named.");
        ws.close();
        return;
      }
      parts.push(message);
      if (remaining > 0) return;
      text = Buffer.concat(parts).toString("utf8");
      parts = [];
    } else {
      text = message.toString("utf8");
    }
    const frame = JSON.parse(text) as Record<string, unknown>;
    const problem = fits(contract.connection.homeFrame, frame);
    if (problem) return notFitting("frame", problem);
    if (frame.t === "parts") {
      // The published header schema owns the positive length and frame limit.
      remaining = frame.bytes as number;
      return;
    }
    if (frame.t === "welcome") return say(frame);
    if (frame.t === "push") {
      const channel = String(frame.channel);
      const published = contract.pushes[channel];
      // A push the file does not name is a later minor's; a client ignores it.
      if (!published) return;
      const wrong = reads(published.payload, frame.payload);
      if (wrong) notFitting(`${channel} push`, wrong);
      return say(frame);
    }
    const id = frame.id as string | number;
    const channel = asked.get(id);
    asked.delete(id);
    if (channel && frame.ok === true) {
      const wrong = reads(contract.requests[channel]?.response ?? {}, frame.value);
      if (wrong) notFitting(`${channel} response`, wrong);
    }
    say({ ...frame, channel });
  });

  const opened = new Promise<void>((resolveOpen, reject) => {
    ws.once("open", () => resolveOpen());
    ws.once("error", reject);
    ws.once("unexpected-response", (_request, response) =>
      reject(new Error(`The home refused the connection: ${response.statusCode}`)),
    );
  });
  const closed = new Promise<number>((resolveClosed) =>
    ws.once("close", (code) => resolveClosed(code)),
  );
  await opened;

  const [epoch, seq] = values.cursor?.split(":") ?? [];
  // It reads the channels in the one spelling the published file names them
  // in (docs/connection.md, "Two spellings"), and says so.
  const spelling = Object.keys(contract.requests)[0]?.split(":")[0];
  send({
    t: "hello",
    protocolVersion: values.speak ?? contract.protocolVersion,
    ...(values.floor !== undefined || contract.versionRule.viewFloor !== undefined
      ? { viewFloor: values.floor !== undefined ? Number(values.floor) : contract.versionRule.viewFloor }
      : {}),
    ...(spelling ? { spellings: [spelling] } : {}),
    ...(epoch && seq ? { cursor: { epoch, seq: Number(seq) } } : {}),
  });

  const input = createInterface({ input: process.stdin });
  input.on("line", (text) => {
    if (!text.trim()) return;
    const ask = JSON.parse(text) as Asked;
    const published = contract.requests[ask.channel];
    if (!published)
      return say({ t: "refused", id: ask.id, error: `${ask.channel} is not in the contract` });
    const wrong = fits(published.request, ask.args);
    if (wrong) return say({ t: "refused", id: ask.id, error: wrong });
    asked.set(ask.id, ask.channel);
    send({ t: "invoke", id: ask.id, channel: ask.channel, args: ask.args });
  });
  input.once("close", () => ws.close());

  const code = await closed;
  input.close();
  say({ t: "closed", code });
  return invalid > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    },
  );
}
