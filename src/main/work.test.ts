import { APP_FRAME_SCHEME } from "@shared/csp";
import { expect, it, vi } from "vitest";

const registered = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  app: {},
  protocol: { registerSchemesAsPrivileged: registered },
}));
vi.mock("@core/helper/cli", () => ({ runCli: vi.fn() }));
vi.mock("./workContext", () => ({ workContext: vi.fn() }));
vi.mock("./mediaProbe", () => ({ createMediaProbe: vi.fn() }));
vi.mock("./host/taskBrowser", () => ({ createTaskBrowserHost: vi.fn() }));
vi.mock("./host/axiProcess", () => ({ createAxiProcessSpawner: vi.fn() }));
vi.mock("./host/setAsideProcess", () => ({ createSetAsideProcessSpawner: vi.fn() }));
vi.mock("./host/resourceMemory", () => ({ readResourceMemory: vi.fn() }));
vi.mock("./ownDisplay", () => ({ startOwnDisplay: vi.fn() }));

import { frameScheme } from "./frames/frameScheme";
import "./work";

/**
 * A crewmate on another computer attaches a valid H.264 demo (INF-124).
 * The work mode must register the frame scheme when its module loads, before
 * the app is ready, or the media probe reports that this player cannot play
 * the recording's format.
 */
it("registers the frame scheme's stream privileges when the work mode loads", () => {
  expect(registered).toHaveBeenCalledOnce();
  expect(registered).toHaveBeenCalledWith([frameScheme]);
  expect(frameScheme.scheme).toBe(APP_FRAME_SCHEME);
  expect(frameScheme.privileges).toMatchObject({
    standard: true,
    secure: true,
    stream: true,
  });
});
