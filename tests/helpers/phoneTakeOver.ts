import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyIdentity } from "@core/devices/identity";
import { StandbyKeeper } from "@core/standby/keeper";
import { StandbyPeers } from "@core/standby/peers";
import { askTakeOver, phoneOffer, TakeOverHere } from "@core/standby/takeOver";
import {
  STANDBY_FULL_ORDER,
  STANDBY_HELLO_ORDER,
  STANDBY_HOME_ORDER,
  STANDBY_PIECE_ORDER,
  standbyHelloSchema,
} from "@shared/standby";
import {
  type PhoneStandby,
  STANDBY_PHONE_OFFER,
  STANDBY_PHONE_TAKE_OVER,
  standbyPhoneOrders,
} from "@shared/standbyPhone";
import { claimedPort } from "./claimedPort";
import { scratchDir } from "./scratchDirs";

/**
 * INF-4207 piece 9's phone part (`take-over` in scripts/phone-test-plan.ts): a computer that keeps a copy of the
 * test home's record, standing in beside it. Its link for phones, its copy and its takeover are the core's own
 * (`StandbyPeers`, `StandbyKeeper`, `TakeOverHere`); only the first mate it starts is a stand-in: the test home
 * itself answers again at its own key with the takeover's number, as the computer that took over would.
 */
export type PhoneTakeOverHome = {
  /** Where the record's device list lives on the test home. */
  devicesDir: string;
  /** The test home's name, as the copy heard it. */
  name: string;
  userData: string;
  /** Ends the test home's connection, and starts it again. */
  offline: () => Promise<void>;
  online: () => Promise<void>;
  /** Sends every device the home's routes again, with the computers that keep a copy. */
  routes: () => Promise<void>;
};

export function phoneTakeOverControls(home: PhoneTakeOverHome) {
  let homeNumber = 1;
  let takeOver: string | null = null;
  /** The number the takeover made, which a second home says again. */
  let tookOverNumber: number | null = null;
  let homeAnswers = true;
  let standby: Awaited<ReturnType<typeof startStandby>> | null = null;
  const asked: string[] = [];
  const restart = async () => {
    await home.offline();
    await home.online();
  };
  const startStandby = async () => {
    const workDir = scratchDir("infinitary-phone-standby-");
    const own = createKeyIdentity("Firstmate device");
    const deviceId = randomUUID();
    const name = "Test Mac Studio";
    const logged: string[] = [];
    let here: TakeOverHere | null = null;
    const stream = randomUUID();
    const copiedAt = Date.now();
    const peers = new StandbyPeers({
      workDir,
      own: { deviceId, key: own.key, cert: own.cert },
      hosts: () => ["127.0.0.1"],
      port: await claimedPort(),
      homeNumber: () => 1,
      log: (line) => logged.push(line),
      phone: async (channel, args) => {
        asked.push(channel);
        if (channel === STANDBY_PHONE_OFFER)
          return phoneOffer({
            workDir,
            deviceId,
            home: { contact: homeAnswers ? "in-reach" : "lost", heardAt: copiedAt, slept: false },
            homeNumber: 1,
          });
        const [{ id }] = standbyPhoneOrders[STANDBY_PHONE_TAKE_OVER].request.parse(args);
        return askTakeOver(workDir, id, { look: () => here?.look() });
      },
    });
    const keeper = new StandbyKeeper({
      workDir,
      log: (line) => logged.push(line),
      listens: () => peers.listens(),
      onCopy: (what) => peers.copyChanged(what),
    });
    peers.start();
    const hello = standbyHelloSchema.parse(await keeper.answer(STANDBY_HELLO_ORDER, []));
    // The record as the home sends it: its device list, which names the phone and its system.
    const files = ["devices.json", "systems.json"].map((file) => {
      const path = join(home.devicesDir, file);
      if (!existsSync(path)) throw new Error(`The test home has no ${file} to copy yet`);
      const data = readFileSync(path);
      return {
        path: `devices/${file}`,
        data,
        sha256: createHash("sha256").update(data).digest("hex"),
      };
    });
    for (const file of files)
      await keeper.answer(STANDBY_PIECE_ORDER, [
        {
          sha256: file.sha256,
          size: file.data.length,
          offset: 0,
          data: file.data.toString("base64"),
        },
      ]);
    await keeper.answer(STANDBY_FULL_ORDER, [
      {
        stream,
        seq: 1,
        at: copiedAt,
        part: 0,
        last: true,
        files: files.map(({ path, data, sha256 }) => ({ path, size: data.length, sha256 })),
      },
    ]);
    // What taking over needs that the record does not hold, as the home tells it.
    await keeper.answer(STANDBY_HOME_ORDER, [
      {
        name: home.name,
        from: { userData: home.userData, homeDir: home.userData },
        projects: [],
        signIns: { providers: [], forges: [] },
        homeNumber: 1,
        stream,
        seq: 1,
        at: copiedAt,
        copies: [],
      },
    ]);
    here = new TakeOverHere({
      workDir,
      own: async () => ({ deviceId, name }),
      homeNumber: () => 1,
      inReach: () => homeAnswers,
      filesOf: (move) => join(workDir, "moves", move, "files"),
      // The stand-in first mate: the test home answers again at its own key, as the next home.
      arrive: async (order) => {
        homeNumber = order.homeNumber;
        tookOverNumber = order.homeNumber;
        takeOver = order.move;
        await home.online();
        return { addresses: [] };
      },
      started: () => {},
      log: (line) => logged.push(line),
      lookMs: 100,
    });
    here.start();
    const entry: PhoneStandby = { deviceId, name, pin: own.pin, listens: hello.listens ?? [] };
    return {
      entry,
      logged,
      stop: async () => {
        here?.dispose();
        peers.stop();
      },
    };
  };

  return {
    /** The pairing's own answers the test home's connection reads, with the ones this part changes. */
    override(name: string | symbol): (() => unknown) | undefined {
      if (name === "phoneStandbys") return () => (standby ? [standby.entry] : []);
      if (name === "homeNumber") return () => homeNumber;
      if (name === "takeOver") return () => takeOver;
      return undefined;
    },
    /** One control request of this part, or undefined for one it does not own. */
    async command(command: string): Promise<unknown> {
      switch (command) {
        case "POST standby-start":
          standby ??= await startStandby();
          await home.routes();
          return { standby: standby.entry };
        case "POST standby-home-stops":
          homeAnswers = false;
          await home.offline();
          return { ok: true };
        // The home the takeover left behind comes back: number 1, with no takeover.
        case "POST standby-old-home":
          homeNumber = 1;
          takeOver = null;
          await restart();
          return { ok: true };
        // Another computer that took over with the same number.
        case "POST standby-second-home":
          if (tookOverNumber === null) throw new Error("Nothing took over yet");
          homeNumber = tookOverNumber;
          takeOver = randomUUID();
          await restart();
          return { ok: true, takeOver };
        case "GET standby-state":
          return { homeNumber, takeOver, asked, logged: standby?.logged ?? [] };
        default:
          return undefined;
      }
    },
    stop: async () => {
      await standby?.stop();
    },
  };
}
