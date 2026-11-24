import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CONNECTION_PORT } from "../../../shared/connection";
import * as m from "../../../shared/i18n/messages.generated";
import { NEARBY_OFF } from "../../../shared/nearbyMacs";
import { remoteLoginWords } from "../../../shared/remoteLogin";
import { type HomePhase, SetUpThereView, type SetUpThereViewProps } from "./SetUpThere";

/**
 * INF-6207's approved plan, part 2, as the person reads it on the welcome
 * screen: the seven steps with the one under way lit and what each done
 * step found, and a stop with its three ways on and how many steps it left.
 */

const noop = () => {};

function draw(phase: HomePhase): string {
  const props: SetUpThereViewProps = {
    phase,
    address: "sam@studio",
    port: "",
    account: "",
    nearby: NEARBY_OFF,
    asked: "sam@studio",
    onAddress: noop,
    onPort: noop,
    onAccount: noop,
    onContinueAddress: noop,
    onKeyYes: noop,
    onPassword: noop,
    onAccountYes: noop,
    onConnect: noop,
    onCancel: noop,
    onAskAgain: noop,
    onBack: noop,
    onCommands: noop,
  };
  return renderToStaticMarkup(<SetUpThereView {...props} />);
}

const states = (markup: string) =>
  [...markup.matchAll(/data-home-step="([a-z-]+)" data-state="([a-z]+)"/g)].map(
    ([, step, state]) => `${step}:${state}`,
  );

describe("setting the first mate up on another computer", () => {
  it("lights the step under way and says what each done step found", () => {
    const sending = draw({ at: "working", step: "send", name: "studio", sentMb: 42 });
    expect(sending).toContain(m.devicesHomeTitle({ computer: "studio" }));
    expect(states(sending)).toEqual([
      "key:done",
      "sign-in:done",
      "look:done",
      "send:current",
      "start:next",
      "connect:next",
      "sign-up:next",
    ]);
    // With no port typed, the step names none: the person's SSH settings may name another.
    expect(sending).toContain(m.devicesHomeStepKeyAny());
    expect(sending).toContain(m.devicesHomeSentMb({ mb: "42" }));
    expect(sending).toContain(m.devicesHomePort({ port: String(CONNECTION_PORT) }));
    expect(sending).toContain(`>${m.devicesJoinCancel()}<`);
  });

  it("asks for the password to install the Ubuntu package with the install question", () => {
    const asked = draw({
      at: "password",
      question: { asks: "password", address: "sam@studio", user: "sam", for: "install" },
    });
    expect(asked).toContain(remoteLoginWords.passwordInstallQuestion("sam@studio")[0]);
    expect(asked).not.toContain(remoteLoginWords.passwordQuestion("sam@studio")[0]);
  });

  it("stops with Ask again, Set it up with commands and Back, and says nothing changed there", () => {
    const stopped = draw({
      at: "stopped",
      step: "sign-in",
      name: "studio",
      lines: ["Could not sign in.", "Then ask again."],
      running: false,
      changed: false,
    });
    expect(states(stopped).slice(0, 3)).toEqual(["key:done", "sign-in:stopped", "look:next"]);
    for (const way of [m.devicesHomeAskAgain(), m.devicesHomeCommands(), m.devicesHomeBack()])
      expect(stopped).toContain(`>${way}<`);
    expect(stopped).toContain(m.devicesHomeLeftNothing({ count: 5, computer: "studio" }));
    // After the first mate started there, the footer says it keeps running instead.
    const connecting = draw({
      at: "stopped",
      step: "connect",
      name: "studio",
      lines: ["Could not reach studio.", ""],
      running: true,
      changed: true,
    });
    expect(connecting).toContain(m.devicesHomeLeftRunning({ count: 1, computer: "studio" }));
  });
});
