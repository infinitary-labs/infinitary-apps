import { deviceAddressesSchema } from "@shared/devices";
import { expect, it } from "vitest";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { home } from "../../../tests/helpers/connectionHome";
import type { CoreDispatch } from "../dispatcher";

// The review of INF-4930: a Windows home says it adds no computer by its address
// (`device-adds-by-address`), and a desktop from before reads where devices find a home
// strictly, so it is never answered or pushed the new field and keeps its addresses and
// firewall line; a view naming the change reads it.
it("leaves addsByAddress out of where devices find a home for a view without the change", async () => {
  const addresses = {
    addresses: [{ address: "192.168.1.20", network: "local" as const }],
    chosen: null,
    current: "192.168.1.20",
    windowsFirewall: {
      name: "windows" as const,
      port: 47013,
      program: "C:\\Program Files\\Infinitary\\Infinitary.exe",
      profiles: ["public" as const],
      blockRule: false,
      blockAll: true,
    },
    addsByAddress: false as const,
  };
  const at = await home({
    dispatch: (async (channel) => {
      if (channel === "inf:devices:addresses" || channel === "inf:devices:address:set")
        return addresses;
      throw new Error("Unexpected request");
    }) as CoreDispatch,
  });
  const grant = await at.join();
  const older = await connectClient(grant, { changes: [] });
  const current = await connectClient(grant, { changes: ["device-adds-by-address"] });
  const olderAddresses = deviceAddressesSchema.omit({ addsByAddress: true });
  const { addsByAddress: _adds, ...without } = addresses;
  expect(olderAddresses.parse(await older.invoke("inf:devices:addresses", []))).toEqual(without);
  expect(olderAddresses.parse(await older.invoke("inf:devices:address:set", [null]))).toEqual(
    without,
  );
  expect(await current.invoke("inf:devices:addresses", [])).toEqual(addresses);
  at.events.emit("inf:devices:addresses", addresses);
  const pushed = await older.push((push) => push.channel === "inf:devices:addresses");
  expect(olderAddresses.parse(pushed.payload)).toEqual(without);
  expect((await current.push((push) => push.channel === "inf:devices:addresses")).payload).toEqual(
    addresses,
  );
  await older.close();
  await current.close();
});
