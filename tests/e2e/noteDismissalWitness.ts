import type { ElectronApplication, Page, TestInfo } from "@playwright/test";
import { FIRST_CREWMATE_TITLE } from "@shared/firstCrewmateNote";

export const NOTE_DISMISSAL_WITNESS = "first-crewmate-note-dismissal";

export async function watchFirstCrewmateDismissal(app: ElectronApplication, page: Page) {
  const readDismissals = await app.evaluateHandle(({ ipcMain }) => {
    const channel = "inf:cards:note-done";
    // Electron exposes registration but not lookup. Forward to the registered handler so the
    // witness sees validation and the real host result, not just the renderer's intent.
    const handler = (
      ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
      }
    )._invokeHandlers.get(channel);
    if (!handler) throw new Error("Note dismissal IPC handler missing");
    const calls: { at: number; cardId: unknown; phase: string; outcome?: unknown }[] = [];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const cardId = args[0];
      calls.push({ at: Date.now(), cardId, phase: "invoked" });
      try {
        const result = await handler(event, ...args);
        calls.push({ at: Date.now(), cardId, phase: "returned", outcome: result });
        return result;
      } catch (error) {
        calls.push({ at: Date.now(), cardId, phase: "rejected", outcome: String(error) });
        throw error;
      }
    });
    return () => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
      return calls;
    };
  });

  const readPointers = await page.evaluateHandle((title) => {
    const presses: unknown[] = [];
    const types = ["pointerdown", "pointerup", "pointercancel", "click"];
    const observe = (event: Event) => {
      if (!(event instanceof MouseEvent)) return;
      const { clientX: x, clientY: y } = event;
      const target = event.target instanceof Element ? event.target : null;
      const hit = document.elementFromPoint(x, y);
      const notes = [...document.querySelectorAll<HTMLElement>("[data-stage-entry]")].flatMap(
        (entry) => {
          if (entry.querySelector("[data-card-title]")?.textContent?.trim() !== title) return [];
          return [
            {
              id: entry.dataset.stageEntryId,
              role: entry.dataset.stageEntry,
              inert: entry.inert,
              button:
                entry.querySelector("[data-note-done]")?.getBoundingClientRect().toJSON() ?? null,
            },
          ];
        },
      );
      presses.push({
        at: Date.now(),
        type: event.type,
        trusted: event.isTrusted,
        x,
        y,
        targetNoteButton: Boolean(target?.closest("[data-note-done]")),
        targetEntry: target?.closest("[data-stage-entry]")?.getAttribute("data-stage-entry-id"),
        hitEntry: hit?.closest("[data-stage-entry]")?.getAttribute("data-stage-entry-id"),
        hitShield: hit?.hasAttribute("data-stage-shield") ?? false,
        stackCount: Number(
          document.querySelector("[data-card-pager]")?.getAttribute("data-pager-count") ?? 1,
        ),
        notes,
      });
    };
    for (const type of types)
      window.addEventListener(type, observe, { capture: true, passive: true });
    return () => {
      for (const type of types) window.removeEventListener(type, observe, true);
      return presses;
    };
  }, FIRST_CREWMATE_TITLE);

  return async (info?: TestInfo) => {
    const [pointers, dismissals, openNotes] = await Promise.allSettled([
      readPointers.evaluate((read) => read()),
      readDismissals.evaluate((read) => read()),
      info &&
        page.evaluate(
          async (title) =>
            (await window.infinitary.cards.list())
              .filter((card) => card.title === title)
              .map(({ id, status }) => ({ id, status })),
          FIRST_CREWMATE_TITLE,
        ),
    ]);
    if (!info) return;
    const reading = (result: PromiseSettledResult<unknown>) =>
      result.status === "fulfilled"
        ? { value: result.value }
        : { unavailable: String(result.reason) };
    await info.attach(NOTE_DISMISSAL_WITNESS, {
      contentType: "application/json",
      body: JSON.stringify(
        {
          pointers: reading(pointers),
          dismissals: reading(dismissals),
          openNotes: reading(openNotes),
        },
        null,
        2,
      ),
    });
  };
}
