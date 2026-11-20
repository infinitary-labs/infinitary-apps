import { afterAll, afterEach, expect } from "vitest";

// Shared-code unit and contract/math tests are allowed to reuse module loading, not mutate
// process state. Report changed names only: environment values can be secrets.
const environment = { ...process.env };
const globals = { Date, dateNow: Date.now, random: Math.random, setTimeout, setInterval };

function assertNoLeaks() {
  const names = new Set([...Object.keys(environment), ...Object.keys(process.env)]);
  expect([...names].filter((name) => process.env[name] !== environment[name])).toEqual([]);
  expect(globalThis.Date).toBe(globals.Date);
  expect(Date.now).toBe(globals.dateNow);
  expect(Math.random).toBe(globals.random);
  expect(globalThis.setTimeout).toBe(globals.setTimeout);
  expect(globalThis.setInterval).toBe(globals.setInterval);
}

afterEach(assertNoLeaks);
// Registered before the file hooks, so this also checks mutations in teardown.
afterAll(assertNoLeaks);
