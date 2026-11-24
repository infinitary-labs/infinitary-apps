import type { CustomApiView } from "@shared/customApi";
import type { CustomApiFileView, CustomFileConnection } from "@shared/customApiFile";
import * as m from "@shared/i18n/messages.generated";
import { useState } from "react";
import { useShellStore } from "../app/store";
import { Button, Input } from "../design";
import { useCutWords } from "../design/core/overflowTitle";
import { isView } from "../devices/viewWords";
import { CustomApiDialog, CustomApiForm } from "./CustomApiForm";

/** Why the newest read of the file failed; the last good reading still stands. */
const FAILURE_WORDS: Record<NonNullable<CustomApiFileView["failure"]>, () => string> = {
  missing: () => m.accountsCustomApiFileMissing(),
  unreadable: () => m.accountsCustomApiFileUnreadable(),
  invalid: () => m.accountsCustomApiFileInvalid(),
};

const REFUSAL_WORDS: Record<
  NonNullable<CustomFileConnection["refused"]>,
  (name: string) => string
> = {
  "built-in": (name) => m.accountsCustomApiFileBuiltIn({ name }),
  address: () => m.accountsCustomApiFileNoAddress(),
  protocol: () => m.accountsCustomApiFileNoProtocol(),
  invalid: () => m.accountsCustomApiFileInvalidEntry(),
};

/**
 * The Connection file row (Settings → Intelligence): which file this computer
 * reads custom connections from, how its newest read went, and Choose file.
 * A view window takes the path typed, since a picker here shows only this
 * computer's files, not those where the first mate lives.
 */
export function CustomApiFileRow({
  file,
  onChanged,
}: {
  file: CustomApiFileView | undefined;
  onChanged: (file: CustomApiFileView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState<string | null>(null);
  const there = useShellStore((s) => (isView(s.thisMac) ? s.thisMac.name : null));
  const pathCut = useCutWords(file?.path ?? undefined);

  const set = (path: string | null) => {
    setBusy(true);
    setError("");
    return window.infinitary.accounts.custom
      .setFile(path)
      .then((next) => {
        setTyped(null);
        onChanged(next);
      })
      .catch(() => setError(m.accountsCustomApiFileReadFailed()))
      .finally(() => setBusy(false));
  };
  const choose = () => {
    if (there) {
      setTyped(file?.path ?? "");
      return;
    }
    setBusy(true);
    setError("");
    void window.infinitary.app
      .chooseFile(file?.path ?? undefined)
      .then(
        (picked) => (picked ? set(picked) : undefined),
        () => setError(m.accountsCustomApiFilePickerFailed()),
      )
      .finally(() => setBusy(false));
  };

  const count = file?.connections.length ?? 0;
  return (
    <div className="fm-custom-file" data-setting="custom-connection-file">
      <div className="fm-custom-file-line">
        <span className="fm-custom-file-title">{m.accountsCustomApiFileTitle()}</span>
        {there && typed !== null ? (
          <form
            className="fm-custom-file-typed"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.trim()) void set(typed.trim());
            }}
          >
            <Input
              aria-label={m.accountsCustomApiFilePathOn({ computer: there })}
              mono
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={busy}
              autoFocus
            />
            <Button type="submit" size="sm" disabled={!typed.trim() || busy}>
              {m.accountsCustomApiFileReadThis()}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setTyped(null)}>
              {m.accountsCustomApiCancel()}
            </Button>
          </form>
        ) : (
          <>
            {file?.path ? (
              <span
                className="fm-custom-mono fm-custom-file-path"
                data-custom-file-path
                {...pathCut}
              >
                {file.path}
              </span>
            ) : (
              <span className="fm-custom-hint">{m.accountsCustomApiFileNone()}</span>
            )}
            <span className="fm-custom-acts">
              <Button
                variant="ghost"
                size="sm"
                disabled={!file}
                pending={busy}
                pendingLabel={m.accountsCustomApiFileChoosing()}
                onClick={choose}
              >
                {m.accountsCustomApiFileChoose()}
              </Button>
              {file?.path && (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void set(null)}>
                  {m.accountsCustomApiFileStop()}
                </Button>
              )}
            </span>
          </>
        )}
      </div>
      {file?.path && (
        <p className="fm-custom-hint" data-custom-file-status>
          {file.failure ? FAILURE_WORDS[file.failure]() : m.accountsCustomApiFileRead({ count })}
        </p>
      )}
      {!file?.path && <p className="fm-custom-hint">{m.accountsCustomApiFileHint()}</p>}
      {error && (
        <p role="alert" className="fm-custom-field-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** What the file sets that Infinitary does not use, said once per connection. */
export function FileWarnings({
  connection,
  approved = false,
}: {
  connection: CustomFileConnection;
  /** Approved here already: its key was typed then, so only what goes unused is said. */
  approved?: boolean;
}) {
  const keyed = !approved && connection.warnings.some((warning) => warning.kind === "key");
  const unused = connection.warnings
    .filter((warning) => warning.kind !== "compaction" && warning.kind !== "key" && warning.key)
    .map((warning) => (warning.model ? `${warning.model}: ${warning.key}` : (warning.key ?? "")));
  const tight = connection.warnings.filter((warning) => warning.kind === "compaction");
  if (!keyed && !unused.length && !tight.length) return null;
  return (
    <div data-custom-file-warnings>
      {keyed && <p className="fm-custom-hint">{m.accountsCustomApiFileKey()}</p>}
      {unused.length > 0 && (
        <p className="fm-custom-hint">
          {m.accountsCustomApiFileUnused({ keys: [...new Set(unused)].join(", ") })}
        </p>
      )}
      {tight.map((warning) => (
        <p className="fm-custom-hint" key={warning.model ?? ""}>
          {m.accountsCustomApiFileCompaction({ model: warning.model ?? "" })}
        </p>
      ))}
    </div>
  );
}

/**
 * A connection the file defines that this computer has not approved: what it
 * sets, what Infinitary leaves unused, and Approve, which opens the
 * connection form with the file's settings locked.
 */
export function FileConnectionRow({
  connection,
  onSaved,
}: {
  connection: CustomFileConnection;
  onSaved: () => void;
}) {
  const [approving, setApproving] = useState(false);
  const definition = connection.definition;
  return (
    <section className="fm-custom-conn" data-custom-file-connection={connection.name}>
      <div className="fm-custom-conn-head">
        <h3>{definition?.label ?? connection.name}</h3>
        {definition && (
          <span className="fm-custom-mono fm-custom-address">{definition.baseUrl}</span>
        )}
        <span className="fm-custom-tag" data-tone={connection.refused ? "danger" : "idle"}>
          {connection.refused ? m.accountsCustomApiFileNotRead() : m.accountsCustomApiFileNew()}
        </span>
        {definition && !connection.refused && (
          <span className="fm-custom-acts">
            <Button variant="secondary" size="sm" onClick={() => setApproving(true)}>
              {m.accountsCustomApiFileApprove()}
            </Button>
          </span>
        )}
      </div>
      {connection.refused ? (
        <p className="fm-custom-hint">{REFUSAL_WORDS[connection.refused](connection.name)}</p>
      ) : (
        <>
          {definition && (
            <p className="fm-custom-hint fm-custom-mono">
              {definition.models.map((model) => model.id).join(", ")}
            </p>
          )}
          <FileWarnings connection={connection} />
        </>
      )}
      {approving && definition && (
        <FileApproval
          connection={connection}
          onClose={() => {
            setApproving(false);
            onSaved();
          }}
          onSaved={onSaved}
        />
      )}
    </section>
  );
}

/** The connection form for one of the file's connections, new here or approved again. */
export function FileApproval({
  connection,
  original,
  onClose,
  onSaved,
}: {
  connection: CustomFileConnection;
  /** The connection this computer saved from it before, approved again after a change. */
  original?: CustomApiView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const definition = connection.definition;
  if (!definition) return null;
  return (
    <CustomApiDialog
      label={m.accountsCustomApiApproveTitle({ name: definition.label })}
      onClose={onClose}
    >
      <CustomApiForm
        {...(original ? { original } : {})}
        fromFile={{ name: connection.name, definition }}
        onClose={onClose}
        onSaved={onSaved}
      />
    </CustomApiDialog>
  );
}
