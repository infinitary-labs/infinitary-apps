import {
  HOME_UPDATE,
  HOME_UPDATE_INSTALL,
  HOME_UPDATE_LATER,
  HOME_UPDATE_STATUS,
} from "@shared/homeUpdate";
import { expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";

// The home's own update across a version split (docs/view.md, "Updating the first mate's
// computer"): the read-only gate lets a view's update requests through (`READ_ONLY_ASKS`).
// INF-4012 direction 1, the captain's "1 and 2 together": a phone or a Mac reading only across a
// version split, on an older or a newer major than the home's, still reads the home's update
// and presses Update or Update later, and nothing else rides those names.
it("lets a view reading only read, start and put off the home's update", async () => {
  const at = await home({ protocolVersion: "3.2.0", viewFloor: 3 });
  const viewGrant = await at.join("view");
  const phone = await connectClient(viewGrant, {
    protocolVersion: "4.0.0",
    viewFloor: 4,
    system: { system: "ios" },
  });
  const mac = await connectClient(viewGrant, { protocolVersion: "2.9.0", viewFloor: 2 });
  expect([phone, mac].map((device) => device.welcome.access)).toEqual(["read", "read"]);
  expect(phone.welcome.changes).toContain(HOME_UPDATE);
  for (const device of [phone, mac]) {
    // The core's stand-in refuses everything it is asked, so reaching it is the proof.
    for (const channel of [HOME_UPDATE_STATUS, HOME_UPDATE_INSTALL, HOME_UPDATE_LATER] as const)
      await expect(device.invoke(channel, [])).rejects.toThrow("malformed request");
    for (const channel of [HOME_UPDATE_INSTALL, HOME_UPDATE_LATER] as const)
      await expect(device.invoke(channel, ["0.7.2-alpha.590"])).rejects.toThrow(
        "only reads from a home on 3.2.0 until it is updated",
      );
    // The window's own update request stays the home's, never a view's.
    await expect(device.invoke("inf:update:install", [])).rejects.toThrow();
  }
  const update = [HOME_UPDATE_STATUS, HOME_UPDATE_INSTALL, HOME_UPDATE_LATER];
  expect(at.asked.map((ask) => ask.channel)).toEqual([...update, ...update]);
});
