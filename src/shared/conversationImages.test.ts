import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInvokeRequest } from "./ipc";

describe("INP-16: ten images in a first mate conversation", () => {
  it("accepts ten images with four text files, while refusing eleven and retaining the reply and steer limits", () => {
    const data = readFileSync("tests/e2e/fixtures/contribution-picture.png").toString("base64");
    const images = Array.from({ length: 10 }, (_, index) => ({
      mimeType: "image/png" as const,
      data,
      name: `picture-${index + 1}.png`,
    }));
    const files = [
      { name: "notes.txt", text: "Review the attached pictures." },
      { name: "room.txt", text: "The room is facing north." },
      { name: "colors.txt", text: "Use the existing colors." },
      { name: "details.txt", text: "Keep the original proportions." },
    ];
    const request = { text: "Please compare these pictures.", images, files };
    expect(parseInvokeRequest("inf:converse", [request])).toEqual([request]);
    expect(() =>
      parseInvokeRequest("inf:converse", [{ ...request, images: [...images, images[0]] }]),
    ).toThrow();
    const four = images.slice(0, 4);
    expect(parseInvokeRequest("inf:cards:reply", ["card-1", { images: four }])).toEqual([
      "card-1",
      { images: four },
    ]);
    expect(() =>
      parseInvokeRequest("inf:cards:reply", ["card-1", { images: images.slice(0, 5) }]),
    ).toThrow();
    expect(parseInvokeRequest("inf:task:steer", ["task-1", "Look", { images: four }])).toEqual([
      "task-1",
      "Look",
      { images: four },
    ]);
    expect(() =>
      parseInvokeRequest("inf:task:steer", ["task-1", "Look", { images: images.slice(0, 5) }]),
    ).toThrow();
  });
});
