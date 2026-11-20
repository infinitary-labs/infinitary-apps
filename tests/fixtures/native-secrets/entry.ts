// Packaged proof entry only; the production entry never imports this module.

import { randomUUID } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, type BrowserWindow, utilityProcess } from "electron";
import { hostEnv } from "../../../src/core/hostEnv";
import { startApp } from "../../../src/main/app";
import { createDarwinFreshAuthentication } from "../../../src/main/host/darwinFreshAuthentication";
import {
  createDarwinSecretCustody,
  loadDarwinCustodyApi,
} from "../../../src/main/host/darwinSecretCustody";
import { createProcessKeychain } from "../../../src/main/host/keychainProcess";
import {
  readSecretRecoveryFiles,
  saveSecretRecoveryFiles,
} from "../../../src/main/host/secretRecoveryFiles";
import { installMainProcessErrorHandlers } from "../../../src/main/processErrors";
import { SECRETS_RECOVERY_WORDS, SECRETS_WORDS } from "../../../src/shared/secrets";
import {
  type FixtureArea,
  type FixtureCommand,
  fixtureControls,
  serveFixtureControls,
} from "./control";
import { FIXTURE_PURPOSE, FIXTURE_SERVICE } from "./unlock";

declare const __INF_SECRET_FIXTURE_ROOT__: string;
declare const __INF_SECRET_FIXTURE_EVIDENCE__: string;
const root = __INF_SECRET_FIXTURE_ROOT__;
const evidence = __INF_SECRET_FIXTURE_EVIDENCE__;
const home = join(root, "home");
const marker = join(root, "fixture.json");
if (
  !app.isPackaged ||
  process.platform !== "darwin" ||
  process.env.HOME !== home ||
  process.env.CFFIXED_USER_HOME !== home ||
  process.env.PI_OFFLINE !== "1"
)
  throw new Error("This fixture requires its packaged Mac app, isolated home and offline mode.");
if (
  realpathSync(root) !== root ||
  realpathSync(home) !== home ||
  (lstatSync(root).mode & 0o077) !== 0 ||
  (lstatSync(home).mode & 0o077) !== 0 ||
  !lstatSync(marker).isFile() ||
  lstatSync(marker).isSymbolicLink() ||
  JSON.parse(readFileSync(marker, "utf8")).purpose !== FIXTURE_PURPOSE
)
  throw new Error("The fixture refused an unowned runtime folder.");
process.chdir(root); // Relative control.sock stays within Darwin's Unix socket path limit.
app.setPath("appData", join(home, "Library/Application Support"));
app.setPath("userData", join(home, "Library/Application Support/infinitary"));
installMainProcessErrorHandlers();
const mainDir = fileURLToPath(new URL(".", import.meta.url));
const record = (facts: object) =>
  appendFileSync(join(evidence, "mac-controlled-fixture.jsonl"), `${JSON.stringify(facts)}\n`, {
    mode: 0o600,
  });
const keychain = join(home, "Library/Keychains/secrets-proof.keychain-db");
if (
  realpathSync(keychain) !== keychain ||
  !lstatSync(keychain).isFile() ||
  lstatSync(keychain).nlink !== 1
)
  throw new Error("The fixture requires its own regular, unlinked test store.");
const custody = createDarwinSecretCustody(loadDarwinCustodyApi(keychain), {
  service: FIXTURE_SERVICE,
});
const native = createDarwinFreshAuthentication();
if (!native)
  throw new Error("Native confirmation is unavailable; this fixture cannot substitute it.");
let confirming = false;
let pendingUi: object | undefined;
const authentication = {
  available: () => native.available(),
  confirm: async (reason: string) => {
    confirming = true;
    record({ event: "confirmation-started" });
    try {
      const accepted = await native.confirm(reason);
      record({ event: "confirmation-ended", accepted });
      return accepted;
    } finally {
      confirming = false;
    }
  },
};
const unlocker = createProcessKeychain({
  helperPath: join(mainDir, "secrets-unlock.mjs"),
  allowInteraction: true,
  fork: (path, args) =>
    utilityProcess.fork(path, args, {
      serviceName: "Secrets fixture unlock",
      stdio: "ignore",
      env: hostEnv({ HOME: home, CFFIXED_USER_HOME: home, PI_OFFLINE: "1" }),
    }),
});
const archive = join(home, "recovery/archive.infinitary-recovery");
const recoveryKey = join(home, "recovery-key/key.infinitary-recovery-key");
let window: BrowserWindow | undefined;
app.on("browser-window-created", (_event, win) => {
  if (window) return;
  window = win;
  win.once("ready-to-show", () => {
    win.setSize(1280, 900);
    win.show();
  });
});

function currentWindow(): BrowserWindow {
  if (!window || window.isDestroyed()) throw new Error("No fixture window.");
  return window;
}
function openSettings() {
  const view = currentWindow().webContents;
  view.sendInputEvent({ type: "keyDown", keyCode: ",", modifiers: ["meta"] });
  view.sendInputEvent({ type: "keyUp", keyCode: ",", modifiers: ["meta"] });
  return { keySent: true };
}
async function click(label: string, approval = false): Promise<unknown> {
  // Only compiled-in labels reach this script. It reads button labels, never
  // editable values, and acts only on the shown trusted card for an approval.
  return currentWindow().webContents.executeJavaScript(
    `(() => {
    const scope = ${approval ? "document.querySelector('[data-card-layer] [data-stage-entry=\"shown\"]')" : "document"};
    if (!scope) return { refused: 'The requested surface is not shown.' };
    const matches = [...scope.querySelectorAll('button')].filter(button => {
      if (button.disabled || !button.getClientRects().length) return false;
      const copy = button.cloneNode(true);
      copy.querySelectorAll('kbd, [aria-hidden="true"]').forEach(node => node.remove());
      const name = button.getAttribute('aria-label') || copy.textContent.trim();
      return name === ${JSON.stringify(label)};
    });
    if (matches.length !== 1) return { refused: 'The exact fixture control is not uniquely shown.' };
    matches[0].click(); return { clicked: true };
  })()`,
    true,
  );
}
async function showArea(area: FixtureArea): Promise<unknown> {
  return currentWindow().webContents.executeJavaScript(
    `(() => {
      const scope = document.querySelector('[role="tabpanel"][data-settings-section="secrets"]');
      if (!scope) return { refused: 'Secrets settings are not shown.' };
      const matches = [...scope.querySelectorAll('details[data-secrets-area]')].filter(row =>
        row.getAttribute('data-secrets-area') === ${JSON.stringify(area)} && row.getClientRects().length
      );
      if (matches.length !== 1) return { refused: 'The fixed Secrets view is not available.' };
      matches[0].open = true;
      return { selected: ${JSON.stringify(area)} };
    })()`,
    true,
  );
}
async function photograph() {
  const view = currentWindow().webContents;
  if (confirming || pendingUi) return { refused: "A native action is pending." };
  for (const frame of view.mainFrame.framesInSubtree) {
    if (
      await frame.executeJavaScript("Boolean(document.querySelector('input[type=\"password\"]'))")
    )
      return { refused: "A protected entry control is present; no field value was read." };
  }
  const image = await view.capturePage(); // This renderer only, never the desktop or native dialogs.
  if (confirming || pendingUi)
    return { refused: "A native action began; the picture was discarded." };
  const path = join(evidence, `mac-fixture-window-${randomUUID()}.png`);
  await writeFile(path, image.toPNG(), { flag: "wx", mode: 0o600 });
  return { captured: path };
}

startApp(mainDir, null, {
  secrets: {
    custody,
    authentication,
    unlock: async () => {
      confirming = true;
      try {
        return (
          (await unlocker.unlockKeychain?.({ service: FIXTURE_SERVICE, interactive: true }))
            ?.kind === "unlocked"
        );
      } finally {
        confirming = false;
      }
    },
    // The fixture chooses two fixed disposable paths. Native file writing,
    // archive encryption and confirmation remain real; this does not prove picker UI.
    recovery: {
      chooseSave: async () => {
        await mkdir(join(home, "recovery"), { recursive: true });
        await mkdir(join(home, "recovery-key"), { recursive: true });
        return (files) => saveSecretRecoveryFiles({ archive, key: recoveryKey }, files);
      },
      chooseRestore: () => readSecretRecoveryFiles({ archive, key: recoveryKey }),
    },
  },
  started: (core) => {
    if (!core.paths.userData.startsWith(`${home}/`))
      throw new Error("The fixture refused non-isolated app data.");
    const command = core.services.secrets.commandFor({ task: "" });
    let request: string | undefined;
    let preparing = false;
    const status = async () => {
      const view = await core.services.secrets.view();
      return {
        availability: view.availability,
        home: view.home,
        confirming,
        actionPending: !!pendingUi,
        entries: view.entries.map(({ ref, version, revision }) => ({ ref, version, revision })),
        uses: view.uses.map(({ request, state, exitCode }) => ({ request, state, exitCode })),
        message: view.message,
        rules: view.rules.length,
        reads: view.reads.length,
        history: view.history.map(({ request, state }) => ({ request, state })),
      };
    };
    core.events.subscribe((channel) => {
      if (channel !== "inf:secrets:changed") return;
      const observed = pendingUi;
      void status().then((value) => {
        if (
          observed === pendingUi &&
          !confirming &&
          !value.uses.some((use) => use.state === "executing")
        )
          pendingUi = undefined;
        record({ event: "changed", ...value });
      });
    });
    const nativeClick = async (label: string, approval = false) => {
      pendingUi = {};
      const result = await click(label, approval);
      if (result && typeof result === "object" && "refused" in result) pendingUi = undefined;
      return result; // Clicked is not completed; status and native outcomes decide what happened.
    };
    const perform = async (operation: Exclude<FixtureCommand, "status">): Promise<unknown> => {
      switch (operation) {
        case "prepare": {
          // Exclusive creation is durable: a restart or lost reply cannot run this stimulus again.
          if (preparing) return { refused: "Preparation was already attempted." };
          preparing = true;
          await writeFile(join(root, "preparation-attempted"), "requested\n", {
            flag: "wx",
            mode: 0o600,
          });
          const before = await core.services.secrets.view();
          if (before.entries.length || before.uses.length)
            return { refused: "The fixture is not empty." };
          await core.services.secrets.put({
            ref: "native-proof",
            label: "Mac fixture",
            value: "inf1109-public-mac-fixture",
            expectedVersion: 0,
            expectedRevision: null,
            environment: "Disposable",
          });
          const recipient = join(home, "recipient");
          await mkdir(recipient, { recursive: true });
          await writeFile(
            join(recipient, "check.sh"),
            '#!/bin/sh\nset -eu\n[ "$SERVICE_TOKEN" = "inf1109-public-mac-fixture" ]\nprintf "accepted\\n" >> "$PWD/recipient-runs"\n',
            { flag: "wx", mode: 0o700 },
          );
          const receipt = await command.inject({
            id: "signed-native-proof",
            reason: "Verify one disposable Mac recipient",
            env: { SERVICE_TOKEN: "native-proof" },
            argv: ["/bin/sh", join(recipient, "check.sh")],
            cwd: recipient,
          });
          request = receipt.request;
          record({ event: "requested", receipt });
          return receipt;
        }
        case "decisions":
        case "phone":
        case "history":
        case "copy":
          return showArea(operation);
        case "capture":
          return photograph();
        case "settings":
          return openSettings();
        case "secrets":
          return click(SECRETS_WORDS.title);
        case "review":
          return click(SECRETS_WORDS.waiting);
        case "allow-once":
          return nativeClick(SECRETS_WORDS.once, true);
        case "deny":
          return nativeClick(SECRETS_WORDS.deny, true);
        case "backup":
          return nativeClick(SECRETS_RECOVERY_WORDS.saveButton);
        case "restore":
          return nativeClick(SECRETS_RECOVERY_WORDS.restoreButton);
        case "unlock":
          return core.services.secrets.action({ kind: "unlock" }).then(() => status());
        case "quit": {
          const receipt = request ? await command.status(request) : undefined;
          if (receipt?.state === "executing") return { refused: "The recipient is still running." };
          setImmediate(() => app.quit());
          return { closing: true };
        }
      }
    };
    void serveFixtureControls(
      fixtureControls({ confirming: () => confirming || !!pendingUi, status, perform }),
    ).then((server) => {
      app.once("will-quit", () => server.close());
      record({ event: "ready", pid: process.pid });
    });
  },
});
