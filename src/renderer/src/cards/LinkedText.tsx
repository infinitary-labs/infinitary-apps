import { splitCardBodyUrls } from "@shared/linkify";

/**
 * Plain-text card body with http(s) URLs as accent links. Clicks go through
 * the app IPC opener (system browser); they do not rely on window.open.
 */
export function LinkedText({ text }: { text: string }) {
  const parts = splitCardBodyUrls(text);
  let offset = 0;
  return (
    <span style={{ whiteSpace: "pre-wrap" }}>
      {parts.map((part) => {
        const key = `${offset}:${part.type}:${part.value}`;
        offset += part.value.length;
        if (part.type !== "url") return part.value;
        return (
          <a
            key={key}
            href={part.value}
            onClick={(event) => {
              event.preventDefault();
              void window.infinitary.app.openExternal(part.value).catch(() => {});
            }}
            style={{
              color: "var(--accent)",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {part.value}
          </a>
        );
      })}
    </span>
  );
}
