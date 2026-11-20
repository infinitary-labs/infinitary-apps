import type { CardMessage, RevisionTarget } from "@shared/cards";
import { formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { isRevisedLine } from "@shared/threadLines";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShellStore } from "../app/store";
import { focusWithRing } from "../design/focus";

export type RevealBody = (offer: string, start: number, keyboard: boolean) => Promise<boolean>;
type Navigation = {
  offerId?: string;
  body: React.MutableRefObject<RevealBody | null>;
  returnFocus: () => boolean;
  go: (
    message: CardMessage,
    target: RevisionTarget,
    opener: HTMLElement,
    keyboard: boolean,
  ) => Promise<boolean | undefined>;
};
const Context = createContext<Navigation | null>(null);
export const useRevisionNavigation = () => useContext(Context);

const scrolling = new WeakMap<HTMLElement, () => void>();
/** The shell's height measurement preserves scrollTop; it cancels native smooth scrolling.
 * Drive this one deliberate scroll on the frame clock instead, using the surface duration. */
function scrollRevision(
  scroller: HTMLElement,
  top: number,
  admitted: () => boolean = () => true,
): void {
  scrolling.get(scroller)?.();
  const value = getComputedStyle(scroller).getPropertyValue("--dur-med").trim();
  const duration = (Number.parseFloat(value) || 0) * (value.endsWith("ms") ? 1 : 1000);
  const from = scroller.scrollTop;
  const to = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
  if (!duration) {
    scroller.scrollTop = to;
    return;
  }
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    scroller.removeEventListener("wheel", stop);
    scrolling.delete(scroller);
  };
  scrolling.set(scroller, stop);
  scroller.addEventListener("wheel", stop, { once: true, passive: true });
  const began = performance.now();
  const move = (now: number) => {
    if (!scroller.isConnected || !admitted()) {
      stop();
      return;
    }
    const t = Math.min(1, (now - began) / duration);
    scroller.scrollTop = from + (to - from) * (1 - (1 - t) ** 3);
    if (t < 1) frame = requestAnimationFrame(move);
    else stop();
  };
  frame = requestAnimationFrame(move);
}

/** Only this card's scroller moves; the frame and the thread never scroll themselves. */
export function revealInCard(
  element: HTMLElement,
  top = 0,
  keyboard = false,
  admitted: () => boolean = () => true,
): boolean {
  const card = element.closest<HTMLElement>("[data-response-card]");
  const scroll = card?.querySelector<HTMLElement>("[data-card-body]");
  if (!scroll) return false;
  const rect = element.getBoundingClientRect();
  const scale = element.offsetWidth ? rect.width / element.offsetWidth : 1;
  const context = Number.parseFloat(getComputedStyle(scroll).getPropertyValue("--space-6")) || 24;
  const y =
    scroll.scrollTop + rect.top - scroll.getBoundingClientRect().top + top * scale - context;
  scrollRevision(scroll, y, admitted);
  if (keyboard && !(element instanceof HTMLIFrameElement)) {
    element.tabIndex = -1;
    focusWithRing(element, { preventScroll: true });
  }
  return true;
}

export function RevisionNavigation({
  cardId,
  offerId,
  active,
  onOpen,
  children,
}: {
  cardId: string;
  offerId?: string;
  active: boolean;
  onOpen?: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<RevealBody | null>(null);
  const origin = useRef<HTMLElement | null>(null);
  const request = useRef(0);
  const selected = useRef<{ message: number; target: number } | null>(null);
  const latest = useRef({ offerId, active });
  latest.current = { offerId, active };
  const messages = useShellStore((s) => s.threads[cardId]);
  const value = useMemo<Navigation>(
    () => ({
      offerId,
      body,
      returnFocus: () => {
        const link = origin.current;
        origin.current = null;
        if (!link?.isConnected || !latest.current.active) return false;
        focusWithRing(link, { preventScroll: true });
        return true;
      },
      go: async (message, target, opener, keyboard) => {
        const attempt = ++request.current;
        if (
          !latest.current.active ||
          !message.revision?.released ||
          !message.revisionShown ||
          message.revisionShown?.offerId !== latest.current.offerId
        )
          return undefined;
        selected.current = { message: message.id, target: target.id };
        const current = message.revisionShown.targets.find((t) => t.id === target.id);
        if (!current) return false;
        // The newest navigation owns the way back from its start: the body
        // puts the keyboard on its destination before the reveal settles
        // here, and an Escape from there returns to this link, never an
        // earlier one.
        origin.current = keyboard ? opener : null;
        let found = false;
        if (current.region === "body" && current.start !== undefined) {
          found =
            (await body.current?.(message.revisionShown.offerId, current.start, keyboard)) ?? false;
        } else {
          const selector =
            current.region === "buttons"
              ? "[data-card-actions]"
              : current.region === "title"
                ? "[data-card-title]"
                : "[data-card-body]";
          const place = root.current?.querySelector<HTMLElement>(selector);
          if (place) {
            if (current.region === "whole" || current.region === "preview") {
              scrollRevision(
                place,
                0,
                () => latest.current.offerId === offerId && latest.current.active,
              );
            } else if (current.region === "title") {
              const middle = place.closest<HTMLElement>("[data-card-middle]");
              if (middle) middle.scrollTop = -middle.scrollHeight;
            }
            if (keyboard) {
              place.tabIndex = -1;
              focusWithRing(place, { preventScroll: true });
            }
            found = true;
            place.setAttribute("data-revision-destination", "");
            place.setAttribute("data-revision-highlight", "");
            window.setTimeout(() => place.removeAttribute("data-revision-highlight"), 1000);
          }
        }
        if (attempt !== request.current || latest.current.offerId !== message.revisionShown.offerId)
          return undefined;
        if (!found && keyboard) {
          origin.current = null;
          focusWithRing(opener, { preventScroll: true });
        }
        return found;
      },
    }),
    [offerId],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new offer invalidates the return destination
  useEffect(() => {
    origin.current = null;
  }, [offerId]);
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const next = () => {
      if (!active) return;
      const lists =
        messages?.filter(
          (message) => message.revision?.released && message.revision.targets.length,
        ) ?? [];
      const row = lists.find((message) => message.id === selected.current?.message) ?? lists.at(-1);
      const targets = row?.revision?.targets;
      if (!row || !targets?.length) return;
      const previous =
        row.id === selected.current?.message
          ? targets.findIndex((t) => t.id === selected.current?.target)
          : -1;
      const target = targets[(previous + 1) % targets.length]!;
      onOpen?.();
      const reach = (tries: number) => {
        const link = host.querySelector<HTMLButtonElement>(
          `[data-revision-link="${row.id}:${target.id}"]`,
        );
        if (link) {
          link.click();
          return;
        }
        const more = host.querySelector<HTMLButtonElement>(`[data-revision-more="${row.id}"]`);
        if (more?.getAttribute("aria-expanded") === "false") more.click();
        if (tries) requestAnimationFrame(() => reach(tries - 1));
      };
      requestAnimationFrame(() => reach(6));
    };
    host.addEventListener("fm-next-revision", next);
    return () => host.removeEventListener("fm-next-revision", next);
  }, [active, messages, onOpen]);
  return (
    <Context.Provider value={value}>
      <div
        ref={root}
        data-revision-navigation=""
        style={{ display: "contents" }}
        onKeyDownCapture={(e) => {
          if (
            e.key === "Escape" &&
            origin.current &&
            e.target instanceof HTMLElement &&
            e.target.matches("[data-revision-destination]")
          ) {
            if (value.returnFocus()) {
              e.preventDefault();
              e.stopPropagation();
            }
          }
        }}
      >
        {children}
      </div>
    </Context.Provider>
  );
}

export function RevisionLinks({ message }: { message: CardMessage }) {
  const navigation = useRevisionNavigation();
  const [expanded, setExpanded] = useState(false);
  const [missing, setMissing] = useState(false);
  const revision = message.revision;
  if (!revision)
    return message.who === "host" && isRevisedLine(message.text) ? (
      <span data-revision-unavailable="">{m.cardRevisionLinksUnavailable()}</span>
    ) : null;
  if (!revision.released) return null;
  return (
    <div data-revision-links={message.id}>
      <div className="revision-links">
        {(expanded ? revision.targets : revision.targets.slice(0, 3)).map((target) => (
          <button
            type="button"
            key={target.id}
            data-revision-link={`${message.id}:${target.id}`}
            className="revision-link"
            onMouseDown={(e) => e.preventDefault()}
            onClick={async (e) => {
              e.preventDefault();
              const shown = await navigation?.go(message, target, e.currentTarget, e.detail === 0);
              if (shown !== undefined) setMissing(!shown);
            }}
          >
            {target.label}
          </button>
        ))}
        {revision.targets.length > 3 && (
          <button
            type="button"
            className="revision-link"
            data-revision-more={message.id}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? m.cardRevisionShowFewer()
              : m.cardRevisionMore({ count: formatNumber(revision.targets.length - 3) })}
          </button>
        )}
      </div>
      {revision.removed > 0 && (
        <span>{m.cardRevisedPartsRemoved({ count: revision.removed })}</span>
      )}
      {missing && <div role="status">{m.cardRevisionAreaGone()}</div>}
    </div>
  );
}
