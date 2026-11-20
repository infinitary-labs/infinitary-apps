import type { RepoView } from "@shared/repos";
import type { DeviceSignIns } from "@shared/signIns";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunsOnControl } from "./RunsOn";

/** Projects -> Runs on names why a computer cannot take work now; one whose connection is being made says connecting (captain, INF-49). */
const mini: DeviceSignIns = {
  deviceId: "mini",
  name: "Mac mini",
  onThisMac: false,
  reach: "out-of-reach",
  signIns: null,
};
const repo = {
  id: "r",
  name: "website",
  kind: "project",
  origin: "https://example.com/website.git",
  runsOn: null,
} as unknown as RepoView;
const options = (computer: DeviceSignIns) =>
  renderToStaticMarkup(<RunsOnControl repo={repo} computers={[computer]} onChoose={() => {}} />);

describe("Runs on's option for a computer not in reach", () => {
  it("says connecting while its connection is being made, out of reach otherwise", () => {
    expect(options({ ...mini, reach: "connecting" })).toContain("Mac mini · connecting");
    expect(options(mini)).toContain("Mac mini · out of reach");
  });
});
