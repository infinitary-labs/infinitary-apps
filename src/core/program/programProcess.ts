import { createContext, Script } from "node:vm";
import type { ProgramChildMessage, ProgramOp, ProgramParentMessage } from "./programProtocol";

/**
 * The program process's entry (INF-799 piece 2, docs/programs.md "The
 * runner"): one process for one running program. The script is plain
 * JavaScript, evaluated by Node's own engine in a fresh realm whose only
 * names beyond the language are the host functions - task(), ask(), log(),
 * phase() - and args. It has no require, no files, no network and no
 * timers; Date.now(), new Date() and Math.random() throw, so a replay of
 * the same script with the same answers makes the same calls. The realm
 * is a bound on the script, not a security boundary: its author is the
 * app's own agent. A runaway loop costs only this process, which the
 * runner kills when the program is dropped.
 *
 * The same file runs under Electron's `utilityProcess` in the app (reached
 * through `HostCapabilities.programProcess`) and under a plain `fork` in
 * tests, so it speaks to whichever parent port it was given. It imports
 * nothing but Node itself, so a test forks it as it stands.
 */

type Port = {
  send: (message: ProgramChildMessage) => void;
  listen: (listener: (message: ProgramParentMessage) => void) => void;
};

function parentPort(): Port {
  const electronPort = (
    process as unknown as {
      parentPort?: {
        postMessage: (message: unknown) => void;
        on: (event: "message", listener: (event: { data: unknown }) => void) => void;
      };
    }
  ).parentPort;
  if (electronPort) {
    return {
      send: (message) => electronPort.postMessage(message),
      listen: (listener) =>
        electronPort.on("message", (event) => listener(event.data as ProgramParentMessage)),
    };
  }
  if (process.send) {
    const send = process.send.bind(process);
    return {
      send: (message) => {
        send(message);
      },
      listen: (listener) =>
        process.on("message", (message) => listener(message as ProgramParentMessage)),
    };
  }
  throw new Error("the program process has no parent to answer");
}

/**
 * What runs inside the realm before the script: the host functions, each
 * one call whose answer is parsed by the realm's own JSON so every value
 * the script holds is its own, and the clock and randomness taken away.
 */
const PRELUDE = `"use strict";
(() => {
  const call = globalThis.__call;
  const args = JSON.parse(globalThis.__args);
  delete globalThis.__call;
  delete globalThis.__args;
  const ask = (op, input) =>
    call(op, JSON.stringify(input)).then((text) => {
      const answer = JSON.parse(text);
      if (Object.hasOwn(answer, "refused")) throw new Error(answer.refused);
      return answer.value;
    });
  const named = (name, fn) => Object.defineProperty(fn, "name", { value: name });
  Object.defineProperties(globalThis, {
    args: { value: args, enumerable: true },
    task: { value: named("task", (prompt, options) => ask("task", [prompt, options ?? {}])) },
    ask: { value: named("ask", (prompt, schema) => ask("ask", [prompt, schema ?? null])) },
    log: { value: named("log", (text) => ask("log", [String(text)]).then(() => undefined)) },
    phase: { value: named("phase", (name) => ask("phase", [String(name)]).then(() => undefined)) },
  });
  const refuse = (what) => () => {
    throw new Error(what + " is not available in a program: a replay must make the same calls.");
  };
  const RealDate = Date;
  Math.random = refuse("Math.random()");
  RealDate.now = refuse("Date.now()");
  globalThis.Date = new Proxy(RealDate, {
    apply: refuse("Date()"),
    construct(target, given, newTarget) {
      if (given.length === 0) refuse("new Date()")();
      return Reflect.construct(target, given, newTarget);
    },
  });
})();`;

const port = parentPort();
const waiting = new Map<number, (answer: string) => void>();
let calls = 0;
let started = false;

function call(op: ProgramOp, input: string): Promise<string> {
  return new Promise((resolve) => {
    calls += 1;
    waiting.set(calls, resolve);
    port.send({ type: "call", id: calls, op, input: JSON.parse(input) as unknown[] });
  });
}

/** A value as the record keeps it: JSON, with nothing returned read as null. */
function asJson(value: unknown): unknown {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
}

async function run(script: string, args: unknown): Promise<void> {
  try {
    const context = createContext({ __call: call, __args: JSON.stringify(args ?? null) });
    new Script(PRELUDE, { filename: "prelude.js" }).runInContext(context);
    // The script is the body of an async function, so it may await and
    // return at its top level, as a program's script is written.
    const body = new Script(`(async () => {\n${script}\n})()`, { filename: "program.js" });
    const value: unknown = await body.runInContext(context);
    port.send({ type: "done", value: asJson(value) });
  } catch (caught) {
    // An error the script threw is the realm's own Error, never this one's.
    const message =
      caught && typeof (caught as { message?: unknown }).message === "string"
        ? (caught as { message: string }).message
        : String(caught);
    port.send({ type: "failed", message });
  }
}

// A part the script never awaited may fail on its own; the program goes on.
process.on("unhandledRejection", () => {});

port.listen((message) => {
  if (message.type === "run") {
    if (started) return;
    started = true;
    void run(message.script, message.args);
    return;
  }
  const resolve = waiting.get(message.id);
  waiting.delete(message.id);
  resolve?.(
    JSON.stringify(
      message.type === "answer" ? { value: message.value ?? null } : { refused: message.message },
    ),
  );
});
