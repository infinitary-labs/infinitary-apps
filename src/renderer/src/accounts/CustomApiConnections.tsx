import { CUSTOM_READS_PICTURES, CUSTOM_TOKEN_FAILURE, type CustomApiView } from "@shared/customApi";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { Badge, Button, StatusDot } from "../design";
import { CUSTOM_EXCEPTION_WORDS } from "./customApiFailures";
import "./customApi.css";
import type { CustomApiFileView } from "@shared/customApiFile";
import { HERE } from "@shared/deviceNames";
import * as m from "@shared/i18n/messages.generated";
import { CustomApiFileRow, FileApproval, FileConnectionRow, FileWarnings } from "./CustomApiFile";
import { type FirstmateModel, FirstmateRadio } from "./CustomApiFirstmate";
import { type CustomApiClient, CustomApiDialog, CustomApiForm } from "./CustomApiForm";

/**
 * One connection saved on a computer that runs work: status, Edit, Pause or
 * Resume, and Disconnect. No Firstmate choice — that model stays on this Mac.
 */
export function RemoteCustomConnection({
  view,
  client,
  place,
  onDisconnect,
  onSetEnabled,
  pauseOff,
}: {
  view: CustomApiView;
  client: CustomApiClient;
  place: { who: string; on: string };
  onDisconnect: (accountId: string) => void;
  /** Pauses or resumes it, saved on that computer. */
  onSetEnabled: (accountId: string, enabled: boolean) => void;
  /** Why Pause is off while that computer's Infinitary cannot take it yet. */
  pauseOff?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const accountId = view.accountId ?? "";
  const checked = view.models.length > 0 && view.models.every((model) => model.checked);
  const ready = view.enabled && checked;
  return (
    <section className="fm-custom-conn" data-custom-account={accountId}>
      <div className="fm-custom-conn-head">
        <h3>{view.label}</h3>
        <span className="fm-custom-mono fm-custom-address">{view.baseUrl}</span>
        {view.baseUrl.startsWith("http:") && (
          <span className="fm-custom-tag" data-tone="warn">
            {m.accountsCustomApiUnencrypted()}
          </span>
        )}
        <span
          className="fm-custom-tag"
          data-tone={view.tokenCommandFailed ? "danger" : ready ? "ok" : "idle"}
        >
          {view.tokenCommandFailed
            ? CUSTOM_TOKEN_FAILURE.status
            : ready
              ? m.accountsCustomApiStatusReady()
              : view.enabled
                ? m.accountsCustomApiStatusNotChecked()
                : checked
                  ? m.accountsCustomApiStatusPaused()
                  : m.accountsCustomApiStatusPausedNotChecked()}
        </span>
        <span className="fm-custom-acts">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            {m.accountsCustomApiEdit()}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            off={Boolean(pauseOff) || (!view.enabled && !checked)}
            note={
              pauseOff ??
              (!view.enabled && !checked ? m.accountsCustomApiResumeNeedsCheck() : undefined)
            }
            onClick={() => onSetEnabled(accountId, !view.enabled)}
          >
            {view.enabled ? m.accountsCustomApiPause() : m.accountsCustomApiResume()}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArmed(true)}>
            {m.accountsCustomApiDisconnect()}
          </Button>
        </span>
      </div>
      {view.tokenCommandFailed && (
        <p role="alert" className="fm-custom-field-error">
          {CUSTOM_TOKEN_FAILURE.row}
        </p>
      )}
      <div className="fm-custom-lrow fm-custom-lcols" aria-hidden="true">
        <span>{m.accountsCustomApiColumnModel()}</span>
        <span>{m.accountsCustomApiColumnStatus()}</span>
      </div>
      {view.models.map((model) => (
        <div className="fm-custom-lrow" key={model.id} data-custom-model={model.id}>
          <span className="fm-custom-mono fm-custom-model-id">{model.id}</span>
          <span className="fm-custom-status">
            <StatusDot
              tone={model.checked && view.enabled ? "ok" : "ring"}
              label={
                model.checked && view.enabled
                  ? m.accountsCustomApiStatusReady()
                  : m.accountsCustomApiStatusNotChecked()
              }
              nativeTitle={false}
            />
            {model.checked && view.enabled
              ? m.accountsCustomApiStatusReady()
              : m.accountsCustomApiStatusNotChecked()}
            {model.readsPictures && <Badge tone="accent">{CUSTOM_READS_PICTURES}</Badge>}
          </span>
        </div>
      ))}
      <p className="fm-custom-lock">{m.accountsCustomApiCrewUseRemote({ who: place.who })}</p>
      {armed && (
        <div className="fm-custom-disconnect">
          <p>{m.accountsCustomApiDisconnectRemote({ who: place.who, here: HERE.This })}</p>
          <div className="fm-custom-acts">
            <Button variant="secondary" size="sm" onClick={() => onDisconnect(accountId)}>
              {m.accountsCustomApiDisconnect()}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
              {m.accountsCustomApiKeepConnection()}
            </Button>
          </div>
        </div>
      )}
      {editing && (
        <CustomApiDialog
          label={m.accountsCustomApiEditTitle({ name: view.label })}
          onClose={() => setEditing(false)}
        >
          <CustomApiForm
            original={view}
            client={client}
            place={place}
            onClose={() => setEditing(false)}
          />
        </CustomApiDialog>
      )}
    </section>
  );
}

/** The Settings list: one block per connection, one line per model. */
export function CustomApiAccountsSection() {
  const [views, setViews] = useState<CustomApiView[]>([]);
  const [providers, setProviders] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<FirstmateModel>(null);
  // A choice in flight is shown at once; the poll does not put the old one back meanwhile.
  const choosing = useRef(false);
  const [editing, setEditing] = useState<CustomApiView>();
  const [approving, setApproving] = useState<CustomApiView>();
  const [file, setFile] = useState<CustomApiFileView>();
  const [armed, setArmed] = useState<string>();
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    void useShellStore.getState().loadFirstRun();
    void Promise.all([
      window.infinitary.accounts.custom.list(),
      window.infinitary.accounts.list(),
      window.infinitary.settings.getFirstmateModel(),
    ])
      .then(([custom, accounts, selected]) => {
        setViews(custom);
        setProviders(
          Object.fromEntries(accounts.map((account) => [account.id, account.providerId])),
        );
        if (!choosing.current) setChosen(selected);
      })
      .catch(() => setError(m.accountsCustomApiListFailed()));
    // On its own: a home too old to read a connection file still lists every connection.
    window.infinitary.accounts.custom.file().then(setFile, () => setFile(undefined));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    // A connection saved from Add appears at once, not at the next poll.
    const off = window.infinitary.models.onChanged(refresh);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [refresh]);
  const failed = (fallback: string) => (caught: unknown) =>
    setError(caught instanceof Error ? caught.message : fallback);
  const fileConnection = (view: CustomApiView) =>
    view.file && file?.connections.find((entry) => entry.name === view.file?.name);
  // The file's connections no saved one follows yet.
  const pending =
    file?.connections.filter(
      (entry) =>
        !views.some((view) => view.file?.name === entry.name && view.file.state !== "missing"),
    ) ?? [];
  return (
    <div className="fm-custom-list" data-custom-api-accounts>
      <CustomApiFileRow
        file={file}
        onChanged={(next) => {
          setFile(next);
          refresh();
        }}
      />
      {views.map((view) => {
        const accountId = view.accountId ?? "";
        const provider = providers[accountId] ?? "";
        const checked = view.models.length > 0 && view.models.every((model) => model.checked);
        // A change in the file to its address, protocol or headers holds it until approved again.
        const held = Boolean(view.file && view.file.state !== "current");
        // Held by the file, it runs nothing, though its checks still stand.
        const running = view.enabled && !held;
        const ready = running && checked;
        const fromFile = fileConnection(view);
        // Approved again as a new connection, the same entry already runs; this one only waits to be disconnected.
        const replaced =
          view.file?.state === "changed" &&
          views.some(
            (other) =>
              other !== view &&
              other.file?.name === view.file?.name &&
              other.file?.state === "current",
          );
        return (
          <section className="fm-custom-conn" data-custom-account={accountId} key={accountId}>
            {view.tokenCommandFailed && (
              <p role="alert" className="fm-custom-field-error">
                {CUSTOM_TOKEN_FAILURE.row}
              </p>
            )}
            <div className="fm-custom-conn-head">
              <h3>{view.label}</h3>
              <span className="fm-custom-mono fm-custom-address">{view.baseUrl}</span>
              {view.baseUrl.startsWith("http:") && (
                <span className="fm-custom-tag" data-tone="warn">
                  {m.accountsCustomApiUnencrypted()}
                </span>
              )}
              {view.tokenCommand && (
                <span className="fm-custom-tag">{m.accountsCustomApiTokenCommand()}</span>
              )}
              {view.addressException && (
                <span className="fm-custom-tag" data-tone="warn">
                  {CUSTOM_EXCEPTION_WORDS.tag}
                </span>
              )}
              {view.file && (
                <span className="fm-custom-tag" data-custom-file-tag>
                  {m.accountsCustomApiFileTag()}
                </span>
              )}
              <span
                className="fm-custom-tag"
                data-tone={view.tokenCommandFailed ? "danger" : ready ? "ok" : "idle"}
              >
                {view.tokenCommandFailed
                  ? CUSTOM_TOKEN_FAILURE.status
                  : ready
                    ? m.accountsCustomApiStatusReady()
                    : checked
                      ? m.accountsCustomApiStatusPaused()
                      : m.accountsCustomApiStatusPausedNotChecked()}
              </span>
              <span className="fm-custom-acts">
                {replaced ? null : view.file?.state === "changed" && fromFile?.definition ? (
                  <Button variant="secondary" size="sm" onClick={() => setApproving(view)}>
                    {m.accountsCustomApiFileApproveAgain()}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => (fromFile?.definition ? setApproving(view) : setEditing(view))}
                  >
                    {m.accountsCustomApiEdit()}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  off={!view.enabled && !checked}
                  note={
                    !view.enabled && !checked ? m.accountsCustomApiResumeNeedsCheck() : undefined
                  }
                  onClick={() =>
                    void window.infinitary.accounts
                      .setEnabled(accountId, !view.enabled)
                      .then(refresh)
                      .catch(failed(m.accountsCustomApiChangeFailed()))
                  }
                >
                  {view.enabled ? m.accountsCustomApiPause() : m.accountsCustomApiResume()}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setArmed(accountId)}>
                  {m.accountsCustomApiDisconnect()}
                </Button>
              </span>
            </div>
            <div className="fm-custom-lrow fm-custom-lcols" aria-hidden="true">
              <span>{m.accountsCustomApiColumnModel()}</span>
              <span>{m.accountsCustomApiColumnStatus()}</span>
              <span>{m.accountsCustomApiColumnFirstmate()}</span>
            </div>
            {view.models.map((model) => {
              const usable = Boolean(provider) && running && model.checked;
              const isChosen = chosen?.provider === provider && chosen.id === model.id;
              return (
                <div className="fm-custom-lrow" key={model.id} data-custom-model={model.id}>
                  <span className="fm-custom-mono fm-custom-model-id">{model.id}</span>
                  <span className="fm-custom-status">
                    <StatusDot
                      tone={model.checked ? (running ? "ok" : "idle") : "ring"}
                      label={
                        model.checked
                          ? running
                            ? m.accountsCustomApiStatusReady()
                            : m.accountsCustomApiStatusChecked()
                          : m.accountsCustomApiStatusNotChecked()
                      }
                      nativeTitle={false}
                    />
                    {model.checked
                      ? running
                        ? m.accountsCustomApiStatusReady()
                        : m.accountsCustomApiStatusChecked()
                      : m.accountsCustomApiStatusNotChecked()}
                    {model.readsPictures && <Badge tone="accent">{CUSTOM_READS_PICTURES}</Badge>}
                  </span>
                  <FirstmateRadio
                    model={model.id}
                    chosen={isChosen}
                    off={
                      held
                        ? m.accountsCustomApiFileApproveToUse()
                        : usable
                          ? undefined
                          : model.checked
                            ? m.accountsCustomApiResumeToUse()
                            : m.accountsCustomApiCheckModelFirst()
                    }
                    onChoose={() => {
                      const before = chosen;
                      choosing.current = true;
                      setChosen({ provider, id: model.id });
                      void window.infinitary.settings
                        .setFirstmateModel({ provider, id: model.id })
                        .then(setChosen, (caught: unknown) => {
                          setChosen(before);
                          failed(m.accountsCustomApiChooseFailed())(caught);
                        })
                        .finally(() => {
                          choosing.current = false;
                          refresh();
                        });
                    }}
                  />
                </div>
              );
            })}
            {view.file?.state === "changed" && (
              <p className="fm-custom-lock" data-custom-file-held>
                {replaced ? m.accountsCustomApiFileReplaced() : m.accountsCustomApiFileChanged()}
              </p>
            )}
            {view.file?.state === "missing" && (
              <p className="fm-custom-lock" data-custom-file-held>
                {m.accountsCustomApiFileGone()}
              </p>
            )}
            {fromFile && <FileWarnings connection={fromFile} approved />}
            {held ? null : !checked ? (
              <p className="fm-custom-lock">{m.accountsCustomApiCheckBeforeUse()}</p>
            ) : !view.enabled ? (
              <p className="fm-custom-lock">{m.accountsCustomApiPausedHint()}</p>
            ) : null}
            <p className="fm-custom-lock">{m.accountsCustomApiCrewUse()}</p>
            {armed === accountId && (
              <div className="fm-custom-disconnect">
                <p>{m.accountsCustomApiDisconnectWarning()}</p>
                <div className="fm-custom-acts">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void window.infinitary.accounts
                        .remove(accountId)
                        .then(() => {
                          setArmed(undefined);
                          refresh();
                        })
                        .catch(failed(m.accountsCustomApiDisconnectFailed()))
                    }
                  >
                    {m.accountsCustomApiStopAndDisconnect()}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setArmed(undefined)}>
                    {m.accountsCustomApiKeepConnection()}
                  </Button>
                </div>
              </div>
            )}
          </section>
        );
      })}
      {pending.map((connection) => (
        <FileConnectionRow key={connection.name} connection={connection} onSaved={refresh} />
      ))}
      {approving &&
        (() => {
          const connection = fileConnection(approving);
          return connection ? (
            <FileApproval
              connection={connection}
              original={approving}
              onClose={() => {
                setApproving(undefined);
                refresh();
              }}
              onSaved={refresh}
            />
          ) : null;
        })()}
      {editing && (
        <CustomApiDialog
          label={m.accountsCustomApiEditTitle({ name: editing.label })}
          onClose={() => {
            setEditing(undefined);
            refresh();
          }}
        >
          <CustomApiForm
            original={editing}
            onClose={() => {
              setEditing(undefined);
              refresh();
            }}
            onSaved={refresh}
          />
        </CustomApiDialog>
      )}
      {error && (
        <p role="alert" className="fm-custom-field-error">
          {error}
        </p>
      )}
    </div>
  );
}
