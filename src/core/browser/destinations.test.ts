import { describe, expect, it } from "vitest";
import { checkOpenable, decideRequest, isLoopbackHost, originKey } from "./destinations";

/**
 * Where a task browser may go: the crewmate opens public websites over
 * https and pages a project serves on this Mac, and a page reaches public
 * websites over https and the local pages the crewmate opened.
 */

function registered(...urls: string[]): Set<string> {
  return new Set(urls.map((url) => originKey(new URL(url))));
}

describe("the task browser's destinations", () => {
  it("names this Mac's loopback and nothing else", () => {
    for (const host of [
      "localhost",
      "task-12.website.localhost",
      "127.0.0.1",
      "127.8.9.10",
      "[::1]",
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      "example.com",
      "localhost.example.com",
      "10.0.0.2",
      "192.168.1.5",
      "128.0.0.1",
      "[::2]",
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("opens a project's page on this Mac, over http or https, and gives its origin", () => {
    const opened = checkOpenable(" http://localhost:5173/settings?tab=2 ");
    expect(opened).toMatchObject({ ok: true, origin: "http://localhost:5173" });
    expect(checkOpenable("https://task-12.website.localhost:1355/")).toMatchObject({ ok: true });
    expect(checkOpenable("http://127.0.0.1/")).toMatchObject({
      ok: true,
      origin: "http://127.0.0.1:80",
    });
  });

  it("opens a public website over https, with no origin to register", () => {
    const opened = checkOpenable("https://skyfare.example/flights?from=LHR");
    expect(opened).toMatchObject({ ok: true });
    expect(opened.ok && opened.origin).toBeUndefined();
    expect(checkOpenable("https://93.184.215.14/").ok).toBe(true);
  });

  it("refuses anything else in words that say why and what to do", () => {
    const plain = checkOpenable("http://skyfare.example/flights");
    expect(!plain.ok && plain.reason).toContain("only over https");
    expect(!plain.ok && plain.reason).toContain("https://skyfare.example/flights");
    for (const address of [
      "http://192.168.1.5/router",
      "https://10.0.0.2/",
      "https://169.254.169.254/latest",
      "https://[fe80::1]/",
      "https://[::ffff:127.0.0.1]/",
    ]) {
      const refused = checkOpenable(address);
      expect(refused.ok, address).toBe(false);
      expect(!refused.ok && refused.reason, address).toContain("private network");
    }
    const listen = checkOpenable("http://0.0.0.0:8000/");
    expect(!listen.ok && listen.reason).toContain("http://localhost:8000/");
    expect(checkOpenable("file:///etc/hosts").ok).toBe(false);
    expect(checkOpenable("localhost:5173").ok).toBe(false);
    expect(checkOpenable("not an address").ok).toBe(false);
  });

  it("lets a page reach the origins the crewmate opened, live reload included", () => {
    const origins = registered("http://localhost:5173/");
    expect(decideRequest("http://localhost:5173/src/main.tsx", origins)).toEqual({ allowed: true });
    expect(decideRequest("ws://localhost:5173/?token=1", origins)).toEqual({ allowed: true });
    for (const own of [
      "data:image/png;base64,AAAA",
      "blob:http://localhost:5173/1",
      "about:blank",
    ]) {
      expect(decideRequest(own, origins), own).toEqual({ allowed: true });
    }
  });

  it("sends a public website over https or wss on to the connection guard", () => {
    const origins = registered("http://localhost:5173/");
    for (const address of [
      "https://fonts.googleapis.com/css",
      "wss://live.skyfare.example/socket",
      "https://93.184.215.14/logo.png",
    ]) {
      expect(decideRequest(address, origins), address).toEqual({ allowed: true });
    }
  });

  it("refuses another service on this Mac, a private address, plain http and any other scheme", () => {
    const origins = registered("http://localhost:5173/");
    expect(decideRequest("http://localhost:3001/api", origins)).toEqual({
      allowed: false,
      host: "localhost:3001",
      kind: "local",
    });
    expect(decideRequest("https://localhost:5173/", origins)).toMatchObject({
      allowed: false,
      kind: "local",
    });
    expect(decideRequest("http://192.168.1.5/router", origins)).toEqual({
      allowed: false,
      host: "192.168.1.5",
      kind: "private",
    });
    expect(decideRequest("https://[fd00::1]/", origins)).toMatchObject({
      allowed: false,
      kind: "private",
    });
    expect(decideRequest("http://tracker.example/pixel", origins)).toEqual({
      allowed: false,
      host: "tracker.example",
      kind: "insecure",
    });
    expect(decideRequest("ws://live.skyfare.example/", origins)).toMatchObject({
      allowed: false,
      kind: "insecure",
    });
    expect(decideRequest("file:///etc/hosts", origins)).toMatchObject({
      allowed: false,
      host: "file",
      kind: "scheme",
    });
    expect(decideRequest("app-frame://card/1", origins)).toMatchObject({ allowed: false });
    expect(decideRequest("msauth://sign-in", origins)).toMatchObject({
      allowed: false,
      kind: "scheme",
    });
  });
});
