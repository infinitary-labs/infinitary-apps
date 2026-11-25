import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { RowMenu } from "../../src/renderer/src/design/core/RowMenu";

// The approved plan for tags in Tasks: Group tasks opens a menu of By status
// and By tag, a check marks the current choice, focus starts on it, and a
// pick closes the menu (the design skill's RowMenu, "One of a few").

test("a one-of choice says which is current, takes focus first, and a pick closes the menu", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const picked: string[] = [];
  const item = (id: string) => document.querySelector<HTMLElement>(`[data-menu-item="${id}"]`);
  const open = () =>
    mount.querySelector('[aria-label="Group tasks"]')?.getAttribute("aria-expanded");
  try {
    flushSync(() =>
      root.render(
        <RowMenu
          label="Group tasks"
          items={[
            {
              id: "status",
              label: "By status",
              chosen: false,
              onSelect: () => picked.push("status"),
            },
            { id: "tag", label: "By tag", chosen: true, onSelect: () => picked.push("tag") },
          ]}
        />,
      ),
    );
    mount.querySelector<HTMLElement>('[aria-label="Group tasks"]')?.click();
    await expect
      .poll(() => item("tag") !== null && document.activeElement === item("tag"))
      .toBe(true);
    const roles = [...document.querySelectorAll("[data-menu-item]")].map((node) => [
      node.getAttribute("data-menu-item"),
      node.getAttribute("role"),
      node.getAttribute("aria-checked"),
      node.querySelector("[data-menu-check]")?.getAttribute("data-menu-check"),
    ]);
    expect(roles).toEqual([
      ["status", "menuitemradio", "false", "off"],
      ["tag", "menuitemradio", "true", "on"],
    ]);

    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(item("status"));
    await userEvent.keyboard("{Enter}");
    expect(picked).toEqual(["status"]);
    await expect.poll(open).toBe("false");
  } finally {
    root.unmount();
    mount.remove();
  }
});
