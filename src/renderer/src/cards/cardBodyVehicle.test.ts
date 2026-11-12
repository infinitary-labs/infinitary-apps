import { FRAME_TEMPLATE_MAX_BYTES } from "@shared/plugins/frameDocument";
import { describe, expect, it } from "vitest";
import { oversizedMergeCardBody } from "../../../../tests/fixtures/oversized-card/mergeCard";
import { cardBodyMarkup, cardBodyVehicle } from "./prototypeSrcdoc";

// INF-3887's plan, approved by the captain: a scripted body too large for its
// mount opens with its words under one line saying its drawings are off,
// rather than "could not be opened" with a Retry that sends it again.
describe("cardBodyVehicle", () => {
  const big = oversizedMergeCardBody();
  const lean = big.replace(/<pre>[\s\S]*?<\/pre>/g, "");

  it("opens a scripted merge card over the mount limit with its words only", () => {
    expect(cardBodyMarkup(big).html.length).toBeGreaterThan(FRAME_TEMPLATE_MAX_BYTES);
    expect(cardBodyVehicle(big)).toBe("words");
  });

  it("mounts the same card once its kept transcripts are gone", () => {
    expect(cardBodyVehicle(lean)).toBe("mount");
  });

  it("leaves a body without a script on srcdoc at any size", () => {
    expect(cardBodyVehicle(big.replace(/<script>[\s\S]*?<\/script>/g, ""))).toBe("srcdoc");
  });
});
