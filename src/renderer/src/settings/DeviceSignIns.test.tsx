import type { AccountView } from "@shared/accounts";
import {
  KEYCHAIN_VALUE_FAILURE_DETAIL,
  KEYCHAIN_VALUE_FAILURE_THERE,
  type QuotaProviderView,
} from "@shared/quota";
import { returnsToLoopback, signInPlace } from "@shared/signIns";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeviceSignInAside, type Flow, OutOfReachNote } from "./DeviceSignIns";
import { AccountRow } from "./SubscriptionsTab";

/**
 * A sign-in on a computer that runs work, as the captain reads it in
 * Settings -> Intelligence (design skill components/devices/SignInOnAMac):
 * a key or a code typed here and where it goes, a code to read, and the
 * ways it ends.
 */

const MINI = signInPlace({ name: "Mac mini", onThisMac: false });
const BUILDER = signInPlace({ name: "This computer", user: "builder", onThisMac: true });
const noop = () => {};

function render(flow: Partial<Flow>, place = MINI, providerName = "Codex", typed = "") {
  return renderToStaticMarkup(
    <DeviceSignInAside
      flow={{ signInId: "s1", deviceId: "mini", providerId: "openai-codex", ...flow }}
      providerName={providerName}
      place={place}
      onThisMac={place === BUILDER}
      typed={typed}
      onTyped={noop}
      onAnswer={noop}
      onStop={noop}
    />,
  );
}

describe("a sign-in on a computer that runs work", () => {
  it("names another Mac by its name, and another user on this Mac as the design does", () => {
    expect(MINI).toEqual({ label: "Mac mini", where: "on Mac mini", who: "Mac mini" });
    expect(BUILDER).toEqual({
      label: "Running as Builder",
      where: "as Builder",
      who: "Builder",
    });
  });

  it("asks for a key for that computer, and says where it goes and that nothing stays here", () => {
    const html = render(
      {
        prompt: { promptId: "p1", providerId: "openrouter", kind: "secret", message: "Enter key" },
      },
      BUILDER,
      "OpenRouter",
    );
    expect(html).toContain("Sign in to OpenRouter as Builder");
    expect(html).toContain("Paste an OpenRouter API key for Builder.");
    expect(html).toContain('type="password"');
    expect(html).toContain("It goes to Builder once. This computer keeps no copy.");
    // Nothing to send while the box is empty.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send to Builder<\/button>/);
  });

  /** A browser sign-in waiting for what the captain pastes, after `link` opened here. */
  const pasteBack = (link: string, place = MINI, providerName = "Codex") =>
    render(
      {
        link,
        notice: { providerId: "p", kind: "auth_url", message: "", url: link },
        prompt: { promptId: "p2", providerId: "p", kind: "manual_code", message: "Paste" },
      },
      place,
      providerName,
    );
  /** Codex's link, as Pi makes it: it sends the browser back to the Mac it opens on. */
  const CODEX_LINK =
    "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s1";

  it("asks for the code Claude's page shows, with the link to open here", () => {
    const html = pasteBack(
      "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1",
      MINI,
      "Claude",
    );
    expect(html).toContain(
      "Open the link in your browser here and sign in. Then paste the code it shows.",
    );
    expect(html).toContain(">Open the link<");
    expect(html).toContain('placeholder="paste the code"');
    expect(html).toContain('aria-label="The code for Mac mini"');
    expect(html).toContain("It goes to Mac mini once. This computer keeps no copy.");
  });

  it("asks another Mac's browser sign-in for the address the page ends on, never a code", () => {
    const html = pasteBack(CODEX_LINK);
    expect(html).toContain(
      "Open the link in your browser here and sign in. Your browser then ends on a page that cannot be reached. Copy that page&#x27;s address and paste it here.",
    );
    expect(html).not.toContain("paste the code");
    expect(html).toContain(">Open the link<");
    expect(html).toContain('placeholder="paste the address"');
    expect(html).toContain('aria-label="The address for Mac mini"');
    expect(html).toContain("It goes to Mac mini once. This computer keeps no copy.");
  });

  it("says another user on this Mac finishes a browser sign-in itself, with the address as the way back", () => {
    const html = pasteBack(CODEX_LINK, BUILDER);
    expect(html).toContain(
      "Open the link in your browser here and sign in. Builder finishes the sign-in itself when your browser comes back. If the page your browser ends on cannot be reached, copy its address and paste it here.",
    );
    expect(html).toContain('aria-label="The address for Builder"');
  });

  it("knows a link sends the browser back to the Mac it opens on by any address there", () => {
    expect(returnsToLoopback(CODEX_LINK)).toBe(true);
    // OpenRouter's, back to a port of its own.
    expect(
      returnsToLoopback(
        "https://openrouter.ai/auth?callback_url=http%3A%2F%2F127.0.0.1%3A53121%2Foauth%2Fcallback%2Fu1&code_challenge=c",
      ),
    ).toBe(true);
    expect(
      returnsToLoopback("https://example.com/a?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A80%2F"),
    ).toBe(true);
    // A page elsewhere, a lookalike, no address at all, or no link.
    expect(
      returnsToLoopback(
        "https://example.com/a?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback",
      ),
    ).toBe(false);
    expect(
      returnsToLoopback("https://example.com/a?redirect_uri=http%3A%2F%2Flocalhost.example.com%2F"),
    ).toBe(false);
    expect(returnsToLoopback("https://auth.openai.com/oauth/authorize")).toBe(false);
    expect(returnsToLoopback("not a link")).toBe(false);
    expect(returnsToLoopback(undefined)).toBe(false);
  });

  it("shows a code to read, which that computer finishes itself", () => {
    const html = render(
      {
        link: "https://accounts.x.ai/device",
        notice: {
          providerId: "xai",
          kind: "device_code",
          message: "Enter code",
          url: "https://accounts.x.ai/device",
          userCode: "WXYZ-1234",
        },
      },
      MINI,
      "Grok",
    );
    expect(html).toContain(
      "Open the link in your browser here and enter this code. Mac mini finishes the sign-in itself.",
    );
    expect(html).toContain("WXYZ-1234");
    expect(html).toContain("waiting for you to finish in the browser");
    expect(html).not.toContain("This computer keeps no copy.");
  });

  it("says where to log in to Claude Code when there is no login there to use", () => {
    const html = render({ ended: { kind: "ended", outcome: "signs-in-there" } }, MINI, "Claude");
    expect(html).toContain(
      "Claude Code signs in on Mac mini itself. Log in to it there once, and Infinitary uses that login.",
    );
  });

  it("says why a sign-in failed or could not start", () => {
    expect(
      render({
        ended: {
          kind: "ended",
          outcome: "failed",
          error: "Mac mini went out of reach, so the sign-in stopped.",
        },
      }),
    ).toContain("Mac mini went out of reach, so the sign-in stopped.");
    expect(render({ refused: "Mac mini is out of reach, so no sign-in started." })).toContain(
      "Mac mini is out of reach, so no sign-in started.",
    );
    expect(render({})).toContain("Mac mini is signing in to Codex.");
  });
});

describe("a computer's Claude account row", () => {
  const claude: AccountView = {
    id: "acct-claude",
    providerId: "anthropic-claude",
    kind: "subscription_oauth",
    label: "Personal",
    enabled: true,
    connected: true,
    pinned: false,
    createdAt: 0,
  };
  const refused = (detail: string): QuotaProviderView => ({
    provider: "claude",
    label: "Claude",
    accountId: claude.id,
    status: "unavailable",
    stale: false,
    reason: "keychain_needs_grant",
    detail,
    windows: [],
  });
  const row = (quotaRow: QuotaProviderView, onRetry?: () => void) =>
    renderToStaticMarkup(
      <AccountRow
        account={claude}
        providerName="Claude"
        quotaRow={quotaRow}
        isFlagship={false}
        hasModels={false}
        renaming={false}
        signingIn={false}
        refreshing={false}
        onStartRename={noop}
        onRename={noop}
        onCancelRename={noop}
        onTogglePin={noop}
        onSetEnabled={noop}
        onDisconnect={noop}
        onSignIn={noop}
        {...(onRetry ? { onRetry } : {})}
        onShowModels={noop}
        onResetSlots={noop}
      />,
    );

  it("says why its allowance is not read there, and offers no Retry it could not do", () => {
    const html = row(refused(KEYCHAIN_VALUE_FAILURE_THERE.keychain_needs_grant));
    expect(html).toContain(
      "Infinitary can&#x27;t read this allowance there: macOS asks before it may read your sign-in, and nobody may be at that screen to answer.",
    );
    expect(html).not.toContain("reading…");
    expect(html).not.toContain(">Retry<");
  });

  it("keeps this Mac's own Retry, which asks macOS here", () => {
    expect(row(refused(KEYCHAIN_VALUE_FAILURE_DETAIL.keychain_needs_grant), noop)).toContain(
      ">Retry<",
    );
  });
});

describe("the note under a computer that is not in reach", () => {
  const mini = { deviceId: "mini", name: "Mac mini", onThisMac: false, signIns: null };
  const note = (over: { inReach: boolean; connecting?: boolean }) =>
    renderToStaticMarkup(<OutOfReachNote device={{ ...mini, ...over }} />);
  it("says connecting while its connection is being made, out of reach otherwise, and nothing in reach", () => {
    expect(note({ inReach: false, connecting: true })).toContain(">connecting<");
    expect(note({ inReach: false })).toContain(">out of reach<");
    expect(note({ inReach: true })).toBe("");
  });
});
