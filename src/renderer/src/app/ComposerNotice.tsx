import { COMPOSER_NOTICE_WORDS, type ComposerNotice as ComposerNoticeKind } from "@shared/composer";
import { Button } from "../design";
import { isView, namedNoticeWords } from "../devices/viewWords";
import { NoticeStrip } from "./NoticeStrip";
import { useShellStore } from "./store";

/**
 * The composer's one quiet line under the input: why a draft was kept or a
 * pasted picture was refused. Plain words, no error color - nothing was
 * lost, and this says where it went. Hidden when there is nothing to say.
 */
export function ComposerNotice({ width }: { width: string }) {
  const notice = useShellStore((s) => s.composerNotice);
  const dismiss = useShellStore((s) => s.dismissComposerNotice);
  if (!notice) return null;
  return <ComposerNoticeView width={width} notice={notice} onDismiss={dismiss} />;
}

/** The same notice and dismiss control in the main composer and a card reply. */
export function ComposerNoticeView({
  width,
  notice,
  onDismiss,
}: {
  width: string;
  notice: ComposerNoticeKind;
  onDismiss: () => void;
}) {
  // On an app controlling another Mac, a notice about that Mac names it.
  const thisMac = useShellStore((s) => s.thisMac);
  const words =
    (isView(thisMac) ? namedNoticeWords(notice, thisMac) : null) ?? COMPOSER_NOTICE_WORDS[notice];
  return (
    <NoticeStrip width={width} data-composer-notice={notice}>
      <span style={{ flex: 1, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>{words}</span>
      <Button variant="ghost" size="sm" onClick={onDismiss} style={{ flexShrink: 0 }}>
        Dismiss notice
      </Button>
    </NoticeStrip>
  );
}
