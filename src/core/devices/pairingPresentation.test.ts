import { X509Certificate } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { parsePairingLink } from "@shared/devices";
import { devicePlace } from "@shared/signIns";
import { expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import * as addresses from "../connection/addresses";
import { createKeyIdentity } from "./identity";
import { DevicePairing } from "./pairing";

// INF-2186: Tasks rows repeatedly classified the same reached address,
// constructing SocketAddress values in the main process for every row.
it("classifies a device's reached network once per address, and refreshes it when the address changes", () => {
  const pairing = new DevicePairing({
    dir: scratchDir("pairing-presentation-"),
    ownUid: 501,
    interfaces: () => ({}),
  });
  const key = createKeyIdentity("Work computer");
  const request = (localAddress: string) =>
    ({
      headers: {},
      socket: {
        remoteAddress: "192.168.1.30",
        localAddress,
        localPort: 47000,
        getPeerX509Certificate: () => new X509Certificate(key.cert),
      },
    }) as unknown as IncomingMessage;
  const classify = vi.spyOn(addresses, "reachedNetwork");
  try {
    const joined = pairing.claim(
      {
        code: parsePairingLink(pairing.invite({ kind: "work" }).link).code,
        kind: "work",
        name: "Work computer",
        user: { name: "builder", uid: 502 },
      },
      request("192.168.1.20"),
    );
    if (!joined.ok) throw new Error(joined.reason);
    pairing.admit(request("192.168.1.20"));
    expect(pairing.list()[0]?.reachedOn).toBe("local");
    classify.mockClear();
    pairing.readProjection(() => {
      for (let row = 0; row < 40; row += 1) expect(pairing.list()[0]?.reachedOn).toBe("local");
      expect(classify).not.toHaveBeenCalled();
      pairing.admit(request("100.64.1.20"));
      expect(pairing.list()[0]?.reachedOn).toBe("private");
      expect(classify).toHaveBeenCalledTimes(1);
      pairing.admit(request("127.0.0.1"));
      expect(pairing.list()[0]?.reachedOn).toBeUndefined();
      expect(classify).toHaveBeenCalledTimes(2);
    });
    pairing.readProjection(() => {
      const deviceId = pairing.list()[0]?.id;
      if (!deviceId) throw new Error("Missing paired computer");
      const expected = devicePlace(pairing.list(), deviceId);
      const list = vi.spyOn(pairing, "list");
      try {
        for (let task = 0; task < 40; task += 1)
          expect(pairing.placeOf(deviceId)).toEqual(expected);
        expect(list).toHaveBeenCalledTimes(1);
        pairing.admit(request("192.168.1.21"));
        expect(pairing.placeOf(deviceId)).toEqual(expected);
        expect(list).toHaveBeenCalledTimes(2);
      } finally {
        list.mockRestore();
      }
    });
  } finally {
    classify.mockRestore();
    pairing.dispose();
  }
});
