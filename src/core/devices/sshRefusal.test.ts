import { describe, expect, it } from "vitest";
import { sshRefusal } from "./sshRefusal";

/**
 * Why SSH could not reach or sign in to the other Mac, from SSH's own words.
 * Every stderr below is what the Mac's own `/usr/bin/ssh` (OpenSSH 10.3p1)
 * printed with the options the home runs it with, against a real SSH server;
 * `remoteLogin.test.ts` drives the same cases end to end.
 */

const LOCKED = [
  "debug1: Will attempt key: /Users/sam/.ssh/id_ed25519 ED25519 SHA256:v4RM54SirSdnRJr0b5I9R5MO1T2lpbks37NJh3GeTbw explicit",
  "debug1: Offering public key: /Users/sam/.ssh/id_ed25519 ED25519 SHA256:v4RM54SirSdnRJr0b5I9R5MO1T2lpbks37NJh3GeTbw explicit",
  "debug1: Server accepts key: /Users/sam/.ssh/id_ed25519 ED25519 SHA256:v4RM54SirSdnRJr0b5I9R5MO1T2lpbks37NJh3GeTbw explicit",
  "sam@mini.local: Permission denied (publickey).",
].join("\n");

/** The key held by an agent that asks before it signs, and was not approved. */
const DECLINED = [
  "debug1: Will attempt key: /Users/sam/.ssh/id_ed25519.pub ED25519 SHA256:GW6TkI05AI24cx8rYrz0QzFUwciFuzpIYeSXg4Zl1uk explicit agent",
  "debug1: Offering public key: /Users/sam/.ssh/id_ed25519.pub ED25519 SHA256:GW6TkI05AI24cx8rYrz0QzFUwciFuzpIYeSXg4Zl1uk explicit agent",
  "debug1: Server accepts key: /Users/sam/.ssh/id_ed25519.pub ED25519 SHA256:GW6TkI05AI24cx8rYrz0QzFUwciFuzpIYeSXg4Zl1uk explicit agent",
  'sign_and_send_pubkey: signing failed for ED25519 "/Users/sam/.ssh/id_ed25519.pub" from agent: agent refused operation',
  "debug1: No more authentication methods to try.",
  "sam@mini.local: Permission denied (publickey).",
].join("\n");

/**
 * The key named by its public half, held by an agent the settings name that
 * is not running: its socket gone, or left behind with nothing answering.
 */
const AGENT_GONE = (socket: string) =>
  [
    `debug1: get_agent_identities: ssh_get_authentication_socket: ${socket}`,
    "debug1: Will attempt key: /Users/sam/.ssh/id_ed25519.pub ED25519 SHA256:d0Tqm9Qp4NQSkfLAh+uU0qJPSbs/GPwiC/6s0Q79km4 explicit",
    "debug1: Offering public key: /Users/sam/.ssh/id_ed25519.pub ED25519 SHA256:d0Tqm9Qp4NQSkfLAh+uU0qJPSbs/GPwiC/6s0Q79km4 explicit",
    "debug1: Server accepts key: /Users/sam/.ssh/id_ed25519.pub ED25519 SHA256:d0Tqm9Qp4NQSkfLAh+uU0qJPSbs/GPwiC/6s0Q79km4 explicit",
    "Permissions 0644 for '/Users/sam/.ssh/id_ed25519.pub' are too open.",
    'Load key "/Users/sam/.ssh/id_ed25519.pub": bad permissions',
    "debug1: No more authentication methods to try.",
    "sam@mini.local: Permission denied (publickey).",
  ].join("\n");

/** Settings that name only the agent, which is not running, and no key file there. */
const AGENT_GONE_NO_KEY = [
  "debug1: get_agent_identities: ssh_get_authentication_socket: Connection refused",
  "debug1: Will attempt key: /Users/sam/.ssh/id_ed25519  explicit",
  "debug1: Trying private key: /Users/sam/.ssh/id_ed25519",
  "no such identity: /Users/sam/.ssh/id_ed25519: No such file or directory",
  "debug1: No more authentication methods to try.",
  "sam@mini.local: Permission denied (publickey).",
].join("\n");

const REFUSED = [
  "debug1: Will attempt key: /Users/sam/.ssh/id_ed25519 ED25519 SHA256:GviKaspG3I9EBJGHQl2+PkQBQVX7Mrdr4JCCgH9wPB0 explicit",
  "debug1: Offering public key: /Users/sam/.ssh/id_ed25519 ED25519 SHA256:GviKaspG3I9EBJGHQl2+PkQBQVX7Mrdr4JCCgH9wPB0 explicit",
  "debug1: Authentications that can continue: publickey",
  "sam@mini.local: Permission denied (publickey).",
].join("\n");

const CHANGED = [
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
  "Host key for mini.local has changed and you have requested strict checking.",
  "Host key verification failed.",
].join("\n");

describe("why SSH could not reach the other Mac", () => {
  it("tells a key locked with a passphrase from one the other Mac refused", () => {
    expect(sshRefusal(LOCKED)).toBe("key-locked");
    expect(sshRefusal(REFUSED)).toBe("key-refused");
    expect(sshRefusal("sam@mini.local: Too many authentication failures")).toBe("key-refused");
  });

  it("tells a key its agent did not sign with from one locked with a passphrase", () => {
    expect(sshRefusal(DECLINED)).toBe("agent-declined");
    expect(sshRefusal(LOCKED)).toBe("key-locked");
  });

  it("tells an agent that is not running from a locked key, a declined one and a refused one", () => {
    expect(sshRefusal(AGENT_GONE("No such file or directory"))).toBe("agent-not-running");
    expect(sshRefusal(AGENT_GONE("Connection refused"))).toBe("agent-not-running");
    expect(sshRefusal(AGENT_GONE_NO_KEY)).toBe("agent-not-running");
    expect(sshRefusal(LOCKED)).toBe("key-locked");
    expect(sshRefusal(DECLINED)).toBe("agent-declined");
    expect(sshRefusal(REFUSED)).toBe("key-refused");
  });

  it("tells a Mac never reached before from one that answers unlike before", () => {
    expect(sshRefusal("Host key verification failed.")).toBe("host-unknown");
    expect(sshRefusal(CHANGED)).toBe("host-changed");
  });

  it("tells Remote Login off from nothing answering", () => {
    expect(sshRefusal("ssh: connect to host 127.0.0.1 port 22: Connection refused")).toBe(
      "remote-login-off",
    );
    for (const said of [
      "ssh: Could not resolve hostname mini.local: nodename nor servname provided, or not known",
      "ssh: connect to host 10.255.255.1 port 22: Operation timed out",
      "Connection reset by 127.0.0.1 port 22",
      "",
    ])
      expect(sshRefusal(said), said).toBe("unreachable");
  });
});
