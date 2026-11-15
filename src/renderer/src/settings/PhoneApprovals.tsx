import { SECRET_DEVICE_WORDS, type SecretAction, type SecretsView } from "@shared/secrets";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Switch } from "../design";
import { SecretQuestion } from "./SecretQuestion";

/**
 * Whether a paired phone approves secret uses (INF-1690 piece 4; docs/secrets.md,
 * "Remote decisions"): Settings -> Devices shows it as a switch on the phone's
 * own row. Turning it on asks the phone to offer its approval key, and the card
 * whose code the captain compares stays the one confirmation; turning it off
 * asks under the switch, the question that stops its approvals (docs/secrets.md,
 * "Asking in place"). A build without protected storage,
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
function useOpenSecrets(): [SecretsView | null, (action: SecretAction) => void, boolean] {
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
  const [busy, setBusy] = useState(false);
  const act = useCallback((action: SecretAction) => {
    setBusy(true);
    void window.infinitary.secrets
      .action(action)
      .then(
        (next) => setView(next.availability === "available" ? next : null),
        () => undefined,
      )
      .finally(() => setBusy(false));
  }, []);
  return [view, act, busy];
}

/** The line under a paired phone's or Mac's summary and its switch, or nothing while Secrets are not open. */
export function PhoneApprovals({ paired, name }: { paired: string; name: string }) {
  const [view, act, busy] = useOpenSecrets();
  const approval = view ? phoneApprovalOf(view, paired) : null;
  const question =
    approval?.state === "on" &&
    view?.question?.about.kind === "device" &&
    view.question.about.device === approval.device
      ? view.question
      : null;
  // Leaving Settings drops this phone's open question: its Keep pass changes nothing.
  const open = useRef(question);
  const wrapper = useRef<HTMLSpanElement>(null);
  // Once the question is answered, focus goes back to the switch that asked it.
  const answered = useRef(false);
  useLayoutEffect(() => {
    if (question || !answered.current) return;
    answered.current = false;
    // Only focus the question took with it: a person who moved on keeps where they are.
    const active = wrapper.current?.ownerDocument.activeElement;
    if (active && active !== active.ownerDocument.body && active.isConnected) return;
    wrapper.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
  }, [question]);
  open.current = question;
  useEffect(
    () => () => {
      if (open.current)
        void window.infinitary.secrets
          .action({ kind: "answer", pass: open.current.keep.pass })
          .catch(() => undefined);
    },
    [],
  );
  if (!view || !approval) return null;
  const checked = approval.state !== "off";
  const line =
    approval.state === "waiting"
      ? SECRET_DEVICE_WORDS.waiting(name)
      : approval.state === "comparing"
        ? SECRET_DEVICE_WORDS.comparing(name)
        : approval.state === "on" && !question
          ? SECRET_DEVICE_WORDS.on(approval.code)
          : null;
  return (
    <span ref={wrapper} className="fm-devices-approvals" data-phone-approvals={approval.state}>
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
      {question && (
        <SecretQuestion
          question={question}
          answering={busy}
          onAnswer={(pass) => {
            answered.current = true;
            act({ kind: "answer", pass });
          }}
        />
      )}
    </span>
  );
}
