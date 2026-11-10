import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalCode,
  decisionMessage,
  type FreshAuthentication,
  LocalApprovals,
  RemoteApprovals,
  type RemoteDecision,
  verifyDecision,
} from "./approvals";
import type { ApprovalDevice } from "./authority";
import { sha256 } from "./custody";

// Intent: INF-1105 - trusted approvals: fresh system authentication for a human
// Allow, and authenticated remote decisions bound to exact digest, nonce,
// expiry, enrollment generation and enforcing home (docs/secrets.md).
const DIGEST = sha256("checked: /bin/sh scripts/deploy-staging.sh with staging-deploy v2");

describe("local fresh approval", () => {
  it("makes a proof only from the system's confirmation, passing once for its subject and digest", async () => {
    let now = 1_000;
    const reasons: string[] = [];
    const system: FreshAuthentication = {
      available: async () => true,
      confirm: async (reason) => {
        reasons.push(reason);
        return true;
      },
    };
    const approvals = new LocalApprovals(system, () => now);
    const proof = await approvals.confirm("use:r1", DIGEST, 301_000, "run deploy-staging.sh");
    expect(reasons).toEqual(["run deploy-staging.sh"]);
    expect(approvals.consume({ kind: "local" }, "use:r1", DIGEST)).toBe(false);
    expect(approvals.consume(proof, "use:r2", DIGEST)).toBe(false);
    expect(approvals.consume(proof, "use:r1", sha256("another operation"))).toBe(false);
    expect(approvals.consume(proof, "use:r1", DIGEST)).toBe(true);
    expect(approvals.consume(proof, "use:r1", DIGEST)).toBe(false);

    const late = await approvals.confirm("use:r3", DIGEST, 301_000, "run again");
    now = 301_000;
    expect(approvals.consume(late, "use:r3", DIGEST)).toBe(false);
  });

  it("approves nothing when the system declines, fails, or cannot confirm the person", async () => {
    const declined = new LocalApprovals({
      available: async () => true,
      confirm: async () => false,
    });
    const failed = new LocalApprovals({
      available: async () => true,
      confirm: async () => {
        throw new Error("LAErrorUserCancel");
      },
    });
    const headless = new LocalApprovals(undefined);
    for (const approvals of [declined, failed, headless])
      expect(
        await approvals.confirm("use:r1", DIGEST, Date.now() + 300_000, "run"),
      ).toBeUndefined();
    expect(await headless.available()).toBe(false);
  });
});

type Device = { record: ApprovalDevice; privateKey: KeyObject };

function device(id: string, generation: number, curve = "prime256v1"): Device {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: curve });
  return {
    record: {
      device: id,
      label: "Kun's iPhone",
      generation,
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    },
    privateKey,
  };
}

function decide(
  signer: Device,
  fields: { home: string; request: string; digest: string; nonce: string; expires: number },
  generation = signer.record.generation,
): RemoteDecision {
  const message = decisionMessage({ ...fields, device: signer.record.device, generation });
  return {
    kind: "remote",
    device: signer.record.device,
    generation,
    nonce: fields.nonce,
    signature: sign("sha256", Buffer.from(message), {
      key: signer.privateKey,
      dsaEncoding: "der",
    }).toString("base64"),
  };
}

describe("remote decisions", () => {
  const home = "home-9b7d";
  const phone = device("phone-1", 2);

  it("passes a decision the enrolled device signed for this home, request, digest, nonce and expiry, once", () => {
    const remote = new RemoteApprovals(() => 1_000);
    const { nonce } = remote.challenge("r1", DIGEST, 301_000) ?? { nonce: "" };
    const decision = decide(phone, {
      home,
      request: "r1",
      digest: DIGEST,
      nonce,
      expires: 301_000,
    });
    const fields = { home, request: "r1", digest: DIGEST, devices: [phone.record] };
    expect(remote.consume(decision, fields)).toBe("phone-1");
    expect(remote.consume(decision, fields)).toBeUndefined();
  });

  const refusals: [
    string,
    (nonce: string) => { decision: RemoteDecision; devices?: ApprovalDevice[]; now?: number },
  ][] = [
    [
      "another home",
      (nonce) => ({
        decision: decide(phone, {
          home: "home-other",
          request: "r1",
          digest: DIGEST,
          nonce,
          expires: 301_000,
        }),
      }),
    ],
    [
      "an older enrollment",
      (nonce) => ({
        decision: decide(
          phone,
          { home, request: "r1", digest: DIGEST, nonce, expires: 301_000 },
          1,
        ),
      }),
    ],
    [
      "another digest",
      (nonce) => ({
        decision: decide(phone, {
          home,
          request: "r1",
          digest: sha256("changed"),
          nonce,
          expires: 301_000,
        }),
      }),
    ],
    [
      "another request",
      (nonce) => ({
        decision: decide(phone, { home, request: "r2", digest: DIGEST, nonce, expires: 301_000 }),
      }),
    ],
    [
      "another expiry",
      (nonce) => ({
        decision: decide(phone, { home, request: "r1", digest: DIGEST, nonce, expires: 900_000 }),
      }),
    ],
    [
      "a device no longer enrolled",
      (nonce) => ({
        decision: decide(phone, { home, request: "r1", digest: DIGEST, nonce, expires: 301_000 }),
        devices: [],
      }),
    ],
    [
      "a key on another curve",
      (nonce) => {
        const other = device("phone-1", 2, "secp384r1");
        return {
          decision: decide(other, { home, request: "r1", digest: DIGEST, nonce, expires: 301_000 }),
          devices: [other.record],
        };
      },
    ],
    [
      "a decision after expiry",
      (nonce) => ({
        decision: decide(phone, { home, request: "r1", digest: DIGEST, nonce, expires: 301_000 }),
        now: 301_000,
      }),
    ],
    [
      "a stale nonce",
      () => ({
        decision: decide(phone, {
          home,
          request: "r1",
          digest: DIGEST,
          nonce: "replayed",
          expires: 301_000,
        }),
      }),
    ],
  ];

  it.each(refusals)("refuses %s", (_name, build) => {
    let now = 1_000;
    const remote = new RemoteApprovals(() => now);
    const { nonce } = remote.challenge("r1", DIGEST, 301_000) ?? { nonce: "" };
    const { decision, devices, now: later } = build(nonce);
    if (later) now = later;
    expect(
      remote.consume(decision, {
        home,
        request: "r1",
        digest: DIGEST,
        devices: devices ?? [phone.record],
      }),
    ).toBeUndefined();
  });
});

// Intent: INF-1109's "phone's approval screen for remote decisions", built by
// INF-1202: a decision the phone signs passes this home's own verifier. The
// fixture is the phone's real output (InfinitaryKit's ApprovalKey and
// PhoneDecision.message) over a real challenge from SecretsSettings.approvals;
// InfinitaryKit's ApprovalTests reads the same file.
describe("a decision the phone signed", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../../ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/Fixtures/secrets.json",
      ),
      "utf8",
    ),
  ) as {
    fields: Parameters<typeof decisionMessage>[0];
    message: string;
    key: string;
    signature: string;
    code: string;
  };

  it("is the exact message this home checks, and passes its verifier", () => {
    expect(fixture.message).toBe(decisionMessage(fixture.fields));
    expect(verifyDecision(fixture.key, fixture.fields, fixture.signature)).toBe(true);
  });

  it("fails the verifier once any binding differs", () => {
    for (const binding of Object.keys(fixture.fields) as (keyof typeof fixture.fields)[]) {
      const value = fixture.fields[binding];
      const changed = {
        ...fixture.fields,
        [binding]: typeof value === "number" ? value + 1 : `${value}x`,
      };
      expect(verifyDecision(fixture.key, changed, fixture.signature), binding).toBe(false);
    }
  });

  it("shows the same code on the phone and on this computer", () => {
    expect(approvalCode(fixture.key)).toBe(fixture.code);
  });
});
