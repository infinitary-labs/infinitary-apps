import { expect, it } from "vitest";
import { journeyCallers } from "../scripts/journey-callers";

it("selects direct, aliased and transitive calls without selecting import-only consumers", () => {
  const files = new Map([
    ["tests/e2e/layout.ts", "export function resizeWindow() {}"],
    ["tests/e2e/direct.spec.ts", 'import { resizeWindow } from "./layout"; resizeWindow();'],
    ["tests/e2e/alias.spec.ts", 'import { resizeWindow as resize } from "./layout"; resize();'],
    [
      "tests/e2e/demo.ts",
      'import { resizeWindow } from "./layout"; export function demo() { resizeWindow(); }',
    ],
    ["tests/e2e/demo.spec.ts", 'import { demo } from "./demo"; demo();'],
    ["tests/e2e/other.spec.ts", 'import { focusOn } from "./layout"; focusOn();'],
    ["tests/e2e/unrelated.spec.ts", "function resizeWindow() {} resizeWindow();"],
  ]);
  const specs = [...files.keys()].filter((file) => file.endsWith(".spec.ts"));
  expect(
    journeyCallers(specs, "tests/e2e/layout.ts", ["resizeWindow"], (file) => files.get(file)),
  ).toEqual(["tests/e2e/alias.spec.ts", "tests/e2e/demo.spec.ts", "tests/e2e/direct.spec.ts"]);
});
