import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContextDelivery, type ContextSection } from "./contextDelivery";

/**
 * INF-1712 (the captain's "a wake carries only what changed"): a model
 * context reads the saved facts whole once, then only what changed, and its
 * view moves only when the backend witnesses the read.
 */

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const crew = (rows: Array<{ task_id: string; status: string }>): ContextSection => ({
  kind: "rows",
  rows: rows.map((row) => ({ id: row.task_id, value: row })),
});

/** Serve one context the way the first mate does, and say whether the model read it. */
function serve(
  delivery: ContextDelivery,
  sections: Record<string, ContextSection>,
  read = true,
): Record<string, unknown> {
  const rendered = delivery.render(sections);
  const body = JSON.stringify(rendered.payload);
  delivery.offer(body, rendered.offer);
  const framed = `[context]\n${body}\n[user]\nwords`;
  delivery.expect(framed);
  if (read) delivery.read(sha(framed));
  return rendered.payload;
}

describe("ContextDelivery", () => {
  it("serves every section once, then nothing for an unchanged wake", () => {
    const delivery = new ContextDelivery();
    const sections = {
      crew: crew([{ task_id: "t1", status: "running" }]),
      directions: { kind: "whole", value: "Always squash." } as const,
    };
    expect(serve(delivery, sections)).toEqual({
      crew: [{ task_id: "t1", status: "running" }],
      directions: "Always squash.",
    });
    expect(serve(delivery, sections)).toEqual({});
  });

  it("serves one changed row as one update, and names removals until the set is empty", () => {
    const delivery = new ContextDelivery();
    serve(delivery, {
      crew: crew([
        { task_id: "t1", status: "running" },
        { task_id: "t2", status: "idle" },
      ]),
    });
    expect(
      serve(delivery, {
        crew: crew([
          { task_id: "t1", status: "idle" },
          { task_id: "t2", status: "idle" },
        ]),
      }),
    ).toEqual({ crew: { changed: [{ task_id: "t1", status: "idle" }] } });
    expect(serve(delivery, { crew: crew([{ task_id: "t1", status: "idle" }]) })).toEqual({
      crew: { removed: ["t2"] },
    });
    expect(serve(delivery, { crew: crew([]) })).toEqual({ crew: { removed: ["t1"] } });
    expect(serve(delivery, { crew: crew([]) })).toEqual({});
  });

  it("names a whole section that emptied, and serves a direction's new text", () => {
    const delivery = new ContextDelivery();
    serve(delivery, { directions: { kind: "whole", value: "Always squash." } });
    expect(serve(delivery, { directions: { kind: "whole", value: "Always rebase." } })).toEqual({
      directions: "Always rebase.",
    });
    expect(serve(delivery, { directions: { kind: "whole", value: undefined } })).toEqual({
      removed_sections: ["directions"],
    });
  });

  it("sends a change again while no read of it was witnessed", () => {
    const delivery = new ContextDelivery();
    serve(delivery, { crew: crew([{ task_id: "t1", status: "running" }]) });
    const moved = { crew: crew([{ task_id: "t1", status: "idle" }]) };
    expect(serve(delivery, moved, false)).toEqual({
      crew: { changed: [{ task_id: "t1", status: "idle" }] },
    });
    expect(serve(delivery, moved)).toEqual({
      crew: { changed: [{ task_id: "t1", status: "idle" }] },
    });
    expect(serve(delivery, moved)).toEqual({});
  });

  it("applies two inputs built before either was read in the order they were read", () => {
    const delivery = new ContextDelivery();
    serve(delivery, { quota: { kind: "whole", value: "62%" } });
    // A turn's input and a steer, both built from the same view.
    const first = delivery.render({ quota: { kind: "whole", value: "40%" } });
    const firstBody = JSON.stringify(first.payload);
    delivery.offer(firstBody, first.offer);
    const second = delivery.render({ quota: { kind: "whole", value: "62%" } });
    expect(second.payload).toEqual({});
    const secondBody = `${JSON.stringify(second.payload)} steer`;
    delivery.offer(secondBody, second.offer);
    delivery.expect(`a ${firstBody}`);
    delivery.expect(`b ${secondBody}`);
    delivery.read(sha(`a ${firstBody}`));
    delivery.read(sha(`b ${secondBody}`));
    // The model read 40% last; the value is 62% now, so it goes again.
    expect(serve(delivery, { quota: { kind: "whole", value: "62%" } })).toEqual({
      quota: "62%",
    });
  });

  it("serves everything again after a reset, and ignores a read of an input built before it", () => {
    const delivery = new ContextDelivery();
    const sections = { crew: crew([{ task_id: "t1", status: "running" }]) };
    serve(delivery, sections);
    const stale = delivery.render({ crew: crew([{ task_id: "t1", status: "idle" }]) });
    const staleBody = JSON.stringify(stale.payload);
    delivery.offer(staleBody, stale.offer);
    delivery.expect(staleBody);
    delivery.reset();
    delivery.read(sha(staleBody));
    expect(delivery.completeNext).toBe(true);
    expect(serve(delivery, sections)).toEqual({ crew: [{ task_id: "t1", status: "running" }] });
  });

  it("calls an input's read hook only once its read is witnessed", () => {
    const delivery = new ContextDelivery();
    const rendered = delivery.render({ quota: { kind: "whole", value: "62%" } });
    const body = JSON.stringify(rendered.payload);
    let reads = 0;
    delivery.offer(body, rendered.offer, () => {
      reads += 1;
    });
    delivery.expect(body);
    expect(reads).toBe(0);
    delivery.read(sha(body));
    expect(reads).toBe(1);
  });
});
