import { splitCardAddresses } from "@shared/linkify";
import { KeyedText } from "./TaskKey";

/**
 * A card thread's words with each address the safe opener takes a link, and
 * every recorded task's key in the rest linked as `KeyedText` links it
 * (INF-7045's plan, part 2). Addresses come first, so a key inside an
 * address never cuts it short. A click or Enter - only the captain's own -
 * opens the address in the default browser through the app's opener, never
 * by the window following the link.
 */
export function LinkedText({ text }: { text: string }) {
  let offset = 0;
  return (
    <>
      {splitCardAddresses(text).map((part) => {
        const at = offset;
        offset += part.value.length;
        if (part.type === "text") return <KeyedText key={at} text={part.value} />;
        return (
          <a
            key={at}
            href={part.value}
            data-thread-address=""
            onClick={(event) => {
              event.preventDefault();
              if (!event.nativeEvent.isTrusted) return;
              void window.infinitary.app.openExternal(part.value).catch(() => {});
            }}
            style={{
              color: "var(--accent)",
              textDecoration: "underline",
              textUnderlineOffset: 2,
              overflowWrap: "anywhere",
            }}
          >
            {part.value}
          </a>
        );
      })}
    </>
  );
}
