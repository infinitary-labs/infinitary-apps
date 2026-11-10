import { SECRET_DEVICE_WORDS, type SecretAction, type SecretsView } from "@shared/secrets";
import { useCallback, useEffect, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Switch } from "../design";

/**
 * Whether a paired phone approves secret uses (INF-1690 piece 4; docs/secrets.md,
 * "Remote decisions"): Settings -> Devices shows it as a switch on the phone's
 * own row. Turning it on asks the phone to offer its approval key, and the card
 * whose code the captain compares stays the one confirmation; turning it off
 * raises the card that stops its approvals. A build without protected storage,
 * or storage that is not open, shows no switch.
 */
export type PhoneApproval =
  | { state: "off" }
  | { state: "waiting" }
  | { state: "comparing"; card?: string }
  | { state: "on"; device: string; code: string; stopping: boolean };

/** Where one paired phone stands, from the Secrets view the home answers. */
export function phoneApprovalOf(view: SecretsView, paired: string): PhoneApproval {
  const enrolled = view.devices.find((device) => device.paired === paired);
  const setup = view.phones?.find((phone) => phone.paired === paired);
  if (setup)
    return setup.state === "comparing"
      ? { state: "comparing", card: setup.card }
      : { state: "waiting" };
  if (enrolled)
    return {
      state: "on",
      device: enrolled.device,
      code: enrolled.code,
      stopping: !!enrolled.stopping,
    };
  return { state: "off" };
}

/** Shows a card the captain decides on next: home, with that card in front. */
function showCard(card: string): void {
  const shell = useShellStore.getState();
  shell.setView("home");
  shell.focusCard(card);
}

/** The Secrets view while storage is open, read again whenever Secrets change; null otherwise. */
function useOpenSecrets(): [SecretsView | null, (action: SecretAction) => void] {
  const [view, setView] = useState<SecretsView | null>(null);
  const read = useCallback(async () => {
    const secrets = window.infinitary.secrets;
    if (!(await secrets.shown().catch(() => ({ shown: false }))).shown) return setView(null);
    const next = await secrets.view().catch(() => null);
    setView(next?.availability === "available" ? next : null);
  }, []);
  useEffect(() => {
    void read();
    return window.infinitary.secrets.onChange(() => void read());
  }, [read]);
  const act = useCallback((action: SecretAction) => {
    void window.infinitary.secrets.action(action).then(
      (next) => {
        setView(next.availability === "available" ? next : null);
        // Turning approvals off asks once more, on the card that stops them.
        if (next.offeredCard) showCard(next.offeredCard);
      },
      () => undefined,
    );
  }, []);
  return [view, act];
}

/** The line under a paired phone's summary and its switch, or nothing while Secrets are not open. */
export function PhoneApprovals({ paired, name }: { paired: string; name: string }) {
  const [view, act] = useOpenSecrets();
  if (!view) return null;
  const approval = phoneApprovalOf(view, paired);
  const checked = approval.state !== "off";
  const line =
    approval.state === "waiting"
      ? SECRET_DEVICE_WORDS.waiting(name)
      : approval.state === "comparing"
        ? SECRET_DEVICE_WORDS.comparing(name)
        : approval.state === "on"
          ? approval.stopping
            ? SECRET_DEVICE_WORDS.stopping
            : SECRET_DEVICE_WORDS.on(approval.code)
          : null;
  return (
    <span className="fm-devices-approvals" data-phone-approvals={approval.state}>
      <Switch
        checked={checked}
        label={SECRET_DEVICE_WORDS.approves}
        aria-label={`${name} ${SECRET_DEVICE_WORDS.approves.toLowerCase()}`}
        onChange={() =>
          act(
            approval.state === "on"
              ? { kind: "forget-device", device: approval.device }
              : approval.state === "off"
                ? { kind: "ask-phone", paired }
                : { kind: "cancel-phone", paired },
          )
        }
      />
      {line && (
        <span className="fm-devices-summary" role="status">
          {line}
        </span>
      )}
      {approval.state === "comparing" && approval.card && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => approval.card && showCard(approval.card)}
        >
          {SECRET_DEVICE_WORDS.compare}
        </Button>
      )}
      {approval.state === "on" && approval.stopping && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => showCard(`card-secrets-forget-device-${approval.device}`)}
        >
          {SECRET_DEVICE_WORDS.showCard}
        </Button>
      )}
    </span>
  );
}
