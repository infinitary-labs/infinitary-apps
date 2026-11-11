import {
  CUSTOM_API_MAX_HEADERS,
  CUSTOM_READS_PICTURES,
  CUSTOM_TOKEN_FAILURE,
  type CustomApiAddress,
  type CustomApiConnectInput,
  type CustomApiConnectResult,
  type CustomApiFailureCategory,
  type CustomApiReview,
  type CustomApiView,
  type CustomCapabilityProfile,
  type CustomListedModel,
  type CustomNetworkMode,
  customDefaultCacheRetention,
  customNetworkLabel,
  customUnprofiledRetentions,
} from "@shared/customApi";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShellStore } from "../app/store";
import {
  Badge,
  Button,
  IconButton,
  Input,
  type InputProps,
  StatusDot,
  type StatusDotTone,
  useRestLabel,
} from "../design";
import { useModalKeys } from "../design/core/modalKeys";
import { focusWithRing } from "../design/focus";
import { useFirstMatePlace } from "../devices/useFirstMatePlace";
import {
  CUSTOM_EXCEPTION_WORDS,
  destinationWords,
  type FailureContext,
  type PlacedFailure,
  placeCustomApiFailure,
} from "./customApiFailures";
import "./customApi.css";
import { HERE } from "@shared/deviceNames";

type RowState = "run" | "ok" | "bad";
const emptyModel = (): FormModel => ({ id: "", context: 0, output: 0, uiId: crypto.randomUUID() });
type FormModel = {
  id: string;
  context: number;
  output: number;
  uiId: string;
  state?: RowState;
  reasoningProfile?: string;
  cacheRetention?: "none" | "short" | "long";
};
/** `saved`: a secret value the owner already holds; left empty, it is kept at the same address. */
const emptyHeader = () => ({
  name: "",
  value: "",
  secret: true,
  saved: false,
  uiId: crypto.randomUUID(),
});
type FormHeader = ReturnType<typeof emptyHeader>;
type Field = "name" | "address" | "http" | "key" | "headers" | "certificates" | "models" | "save";
type Errors = Partial<Record<Field, string>>;
/** A row's failure, and whether its ID, its sizes or the model itself is at fault. */
type RowError = { text: string; at: "id" | "sizes" | "model" };
/** An approval holds for the address it was given for, and returns with that address. */
type Approvals = { http?: string; storage?: string; certificates?: string; exception?: string };

const SIZES_UNKNOWN = placeCustomApiFailure("limits", { address: "", stage: "check" }).text;
const ROW_DOT: Record<RowState | "none", { tone: StatusDotTone; label: string }> = {
  none: { tone: "ring", label: "Not checked yet" },
  run: { tone: "busy", label: "Checking" },
  ok: { tone: "ok", label: "Checked" },
  bad: { tone: "danger", label: "Failed its check" },
};
/** The standard design input, marked at fault in danger. */
function FormInput({ invalid = false, ...rest }: InputProps & { invalid?: boolean }) {
  return (
    <Input
      {...rest}
      aria-invalid={invalid || undefined}
      style={{
        ...(invalid ? { borderColor: "var(--danger)" } : {}),
      }}
    />
  );
}
/** The address as typed, the key an approval is remembered under. */
const addressKey = (value: string) => value.trim().replace(/\/+$/, "");
/** The host an address names, as the exception's words call it. */
const hostOf = (value: string) => {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
};
const digits = (value: string) => Number(value.replace(/[^0-9]/g, "")) || 0;

/**
 * Add and Edit, in one dialog at every entry point. Save checks everything:
 * it reads the address's network, reaches the server, fills blank sizes from
 * its model list and tests each model, then saves checked. A failure stays on
 * the form beside the field at fault. No key or header enters the shell store.
 */
/** The calls the form makes. This Mac's client is the default; a computer's forwards there. */
export type CustomApiClient = {
  profiles: () => Promise<CustomCapabilityProfile[]>;
  address: (baseUrl: string) => Promise<CustomApiAddress>;
  connect: (input: CustomApiConnectInput) => Promise<CustomApiConnectResult>;
  check: (draftId: string, modelId: string) => Promise<CustomApiView>;
  save: (draftId: string, paused: boolean) => Promise<CustomApiView>;
  cancel: (draftId: string) => Promise<unknown>;
  review: (baseUrl: string, mode: CustomNetworkMode, pem?: string) => Promise<CustomApiReview>;
};

const hereClient: CustomApiClient = {
  profiles: () => window.infinitary.accounts.custom.profiles(),
  address: (baseUrl) => window.infinitary.accounts.custom.address(baseUrl),
  connect: (input) => window.infinitary.accounts.custom.connect(input),
  check: (draftId, modelId) => window.infinitary.accounts.custom.check(draftId, modelId),
  save: (draftId, paused) => window.infinitary.accounts.custom.save(draftId, paused),
  cancel: (draftId) => window.infinitary.accounts.custom.cancel(draftId),
  review: (baseUrl, mode, pem) => window.infinitary.accounts.custom.review(baseUrl, mode, pem),
};

export function CustomApiForm({
  original,
  firstSetup = false,
  onClose,
  onSaved,
  client,
  place,
}: {
  original?: CustomApiView;
  /** First setup asks which model Firstmate answers with once the connection is saved. */
  firstSetup?: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** Absent, the form talks to this Mac. A computer's client keeps the key there. */
  client?: CustomApiClient;
  /**
   * The computer the form is for. Absent, this Mac. `who` names it in the
   * form's words; `on` is the title's place ("on Mac mini", "as Builder").
   */
  place?: { who: string; on: string };
}) {
  const api = client ?? hereClient;
  const apiRef = useRef(api);
  apiRef.current = api;
  // The first mate keeps its connections where it lives.
  const home = useFirstMatePlace();
  const who = place?.who ?? home.this;
  const [profiles, setProfiles] = useState<CustomCapabilityProfile[]>([]);
  const [profileFailure, setProfileFailure] = useState(false);
  useEffect(() => {
    let active = true;
    void api
      .profiles()
      .then((rows) => {
        if (active) setProfiles(rows);
      })
      .catch(() => {
        if (active) setProfileFailure(true);
      });
    return () => {
      active = false;
    };
  }, [api]);
  const id = useId();
  const [label, setLabel] = useState(original?.label ?? "");
  const [baseUrl, setBase] = useState(original?.baseUrl ?? "");
  const [protocol, setProtocol] = useState<CustomApiView["protocol"]>(
    original?.protocol ?? "openai-completions",
  );
  const [key, setKey] = useState("");
  const [keyRemoved, setKeyRemoved] = useState(false);
  const [auth, setAuth] = useState(original?.tokenCommand ? "command" : "key");
  const [command, setCommand] = useState(original?.tokenCommand?.command ?? "");
  const [refreshSeconds, setRefreshSeconds] = useState(
    original?.tokenCommand?.refreshSeconds ?? 300,
  );
  const [headers, setHeaders] = useState<FormHeader[]>(
    original?.headers.map((header) => ({
      ...emptyHeader(),
      name: header.name,
      value: header.value ?? "",
      secret: header.secret,
      saved: header.secret,
    })) ?? [],
  );
  const [headersOpen, setHeadersOpen] = useState(Boolean(original?.headers.length));
  // After Add or Remove, the keyboard lands on that row's name, a neighbor's, or the section.
  const focusHeaderRow = useRef<number | undefined>(undefined);
  const headersSummary = useRef<HTMLElement>(null);
  useEffect(() => {
    const at = focusHeaderRow.current;
    if (at === undefined) return;
    focusHeaderRow.current = undefined;
    const row = Math.min(at, headers.length - 1);
    const target =
      (row >= 0 ? document.getElementById(`${id}-header-name-${row}`) : null) ??
      headersSummary.current;
    if (target) focusWithRing(target);
  }, [headers, id]);
  const [models, setModels] = useState<FormModel[]>(
    original?.models.map(({ id, context, output, checked, reasoningProfile, cacheRetention }) => ({
      reasoningProfile,
      cacheRetention,
      id,
      context,
      output,
      uiId: crypto.randomUUID(),
      ...(checked ? { state: "ok" as const } : {}),
    })) ?? [],
  );
  // After Add by hand or a remove, the keyboard lands on that row's ID, or Add by hand.
  const focusModelRow = useRef<number | undefined>(undefined);
  const addByHand = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const at = focusModelRow.current;
    if (at === undefined) return;
    focusModelRow.current = undefined;
    const row = Math.min(at, models.length - 1);
    const target =
      (row >= 0 ? document.getElementById(`${id}-model-${row}`) : null) ?? addByHand.current;
    if (target) focusWithRing(target);
  }, [models.length, id]);
  const [listed, setListed] = useState<CustomListedModel[]>();
  const [noList, setNoList] = useState(false);
  const [line, setLine] = useState<CustomApiAddress>(
    original ? { destination: original.baseUrl, network: original.mode } : {},
  );
  const [approvals, setApprovals] = useState<Approvals>({
    ...(original?.baseUrl.startsWith("http:") ? { http: original.baseUrl } : {}),
    ...(original?.allowStorageDefault ? { storage: original.baseUrl } : {}),
    ...(original?.certificates.length ? { certificates: original.baseUrl } : {}),
    ...(original?.addressException ? { exception: original.baseUrl } : {}),
  });
  const [pem, setPem] = useState("");
  const [keepCertificates, setKeepCertificates] = useState(Boolean(original?.certificates.length));
  const [certificates, setCertificates] = useState<CustomApiReview["certificates"]>(
    original?.certificates ?? [],
  );
  const [certificateAsked, setCertificateAsked] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [fix, setFix] = useState<string>();
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({});
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState<"" | "fetch" | "save">("");
  const [progress, setProgress] = useState("");
  const [pausedDraft, setPausedDraft] = useState<string>();
  const [savedView, setSavedView] = useState<CustomApiView>();
  const draftId = useRef<string | undefined>(undefined);
  // Cancelled or gone: a draft that answers after that is let go, never saved.
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (draftId.current) void apiRef.current.cancel(draftId.current);
    };
  }, []);
  // The live line under the address: where Save sends, and the network its name points to.
  useEffect(() => {
    const typed = baseUrl.trim();
    if (!typed) {
      setLine({});
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void apiRef.current
        .address(typed)
        .then((next) => {
          if (alive) setLine(next);
        })
        .catch(() => {});
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [baseUrl]);

  const typedKey = addressKey(baseUrl);
  const sameAddress = Boolean(original && typedKey === original.baseUrl);
  // A saved connection keeps the network it was saved with.
  const network: CustomNetworkMode | undefined =
    sameAddress && original ? original.mode : line.network;
  const http = /^http:\/\//i.test(baseUrl.trim());
  const approved = (what: keyof Approvals) => approvals[what] === typedKey;
  const httpRemembered = http && sameAddress;
  const keySaved = Boolean(original?.keyPresent) && sameAddress && !keyRemoved;
  const keyed = auth === "command" || Boolean(key) || keySaved;
  const namedHeaders = headers.filter((header) => header.name.trim());
  const sameAddressEdit = Boolean(original) && sameAddress;
  const showCertificates =
    network === "private" && !http && (certificateAsked || Boolean(pem) || keepCertificates);

  // Any change to the form makes the last attempt's draft stale.
  const edited = (...fields: Field[]) => {
    setPausedDraft(undefined);
    setSummary("");
    if (fields.length)
      setErrors((current) => {
        const next = { ...current };
        for (const field of fields) delete next[field];
        delete next.save;
        return next;
      });
  };
  const approve = (what: keyof Approvals, on: boolean) => {
    edited(
      what === "http"
        ? "http"
        : what === "certificates"
          ? "certificates"
          : what === "exception"
            ? "address"
            : "save",
    );
    setApprovals((current) => ({ ...current, [what]: on ? typedKey : undefined }));
  };
  const changeHeader = (uiId: string, change: Partial<FormHeader>) => {
    edited("headers");
    setHeaders((current) =>
      current.map((header) => (header.uiId === uiId ? { ...header, ...change } : header)),
    );
  };
  const changeModel = (uiId: string, change: Partial<FormModel>) => {
    edited("models");
    setRowErrors(({ [uiId]: _, ...rest }) => rest);
    setModels((current) =>
      current.map((model) =>
        model.uiId === uiId ? { ...model, ...change, state: undefined } : model,
      ),
    );
  };
  const cancel = () => {
    closed.current = true;
    setKey("");
    if (draftId.current) void api.cancel(draftId.current);
    draftId.current = undefined;
    onClose();
  };

  const connectInput = (rows: FormModel[], destination: string): CustomApiConnectInput => {
    const certificatesKept = keepCertificates && sameAddress;
    return {
      label: label.trim() || "Custom API",
      baseUrl: baseUrl.trim(),
      protocol,
      key: auth === "command" ? "" : key,
      noKey: auth !== "command" && !key && !keySaved,
      ...(auth === "command" ? { tokenCommand: { command, refreshSeconds } } : {}),
      headers: headers
        .filter((header) => header.name.trim() || header.value)
        .map(({ name, value, secret }) => ({ name: name.trim(), value, secret })),
      // Save, with this address shown above it, is the approval to send to it.
      approvedDestination: destination,
      unencryptedLocalApproved: approved("http") || httpRemembered,
      // The person's exception for this address's DNS answers, bound to the address shown.
      ...(approved("exception") ? { addressException: destination } : {}),
      ...(pem || certificatesKept
        ? {
            certificates: {
              pem,
              fingerprints: approved("certificates")
                ? certificates.map((certificate) => certificate.fingerprint)
                : [],
            },
          }
        : {}),
      useExistingCertificates: certificatesKept,
      allowStorageDefault: protocol === "openai-responses" && approved("storage"),
      storageApproved: protocol === "openai-responses" && approved("storage"),
      models: rows
        .filter((model) => model.id.trim())
        .map(({ id, context, output, reasoningProfile, cacheRetention }) => ({
          id: id.trim(),
          context,
          output,
          reasoningProfile,
          cacheRetention,
        })),
      ...(draftId.current ? { sourceDraftId: draftId.current } : {}),
      ...(original?.accountId ? { replaceAccountId: original.accountId } : {}),
    };
  };
  /** The line as of now, so the address Save approves is the one it shows. */
  const readLine = async (): Promise<CustomApiAddress> => {
    const next = await api.address(baseUrl.trim());
    setLine(next);
    return next;
  };
  const show = (placed: PlacedFailure, into: Errors) => {
    if (placed.at === "row" || !placed.text) return;
    into[placed.at] = placed.text;
    if (placed.fix) setFix(placed.fix);
    if (placed.askCertificate) setCertificateAsked(true);
  };
  /** What DNS answered for a refused name, for the sentence that says so. */
  const answered = (read: CustomApiAddress): Partial<FailureContext> => ({
    who,
    ...(read.answers ? { answers: read.answers } : {}),
    ...(read.exceptionOffered ? { exceptionOffered: true } : {}),
  });
  const addressFailure = (read: CustomApiAddress, into: Errors) =>
    show(
      placeCustomApiFailure(read.failure ?? "address", {
        address: baseUrl,
        stage: "address",
        ...answered(read),
        ...(read.suggestion ? { suggestion: read.suggestion } : {}),
      }),
      into,
    );
  /** Blank sizes take the server's, as the draft now holds them; a typed number stands. */
  const filled = (rows: FormModel[], view: CustomApiView) =>
    rows.map((row) => {
      const found = view.models.find((model) => model.id === row.id.trim());
      return found && (!row.context || !row.output)
        ? { ...row, context: row.context || found.context, output: row.output || found.output }
        : row;
    });
  const startAttempt = () => {
    setErrors({});
    setRowErrors({});
    setSummary("");
    setFix(undefined);
    setPausedDraft(undefined);
  };
  /** Holds the draft the server's reach prepared; false, and lets it go, once the form was cancelled. */
  const keep = (view?: CustomApiView): boolean => {
    if (closed.current) {
      if (view?.draftId) void apiRef.current.cancel(view.draftId);
      return false;
    }
    if (view?.draftId) draftId.current = view.draftId;
    return true;
  };

  const validCommand = () => {
    if (
      auth !== "command" ||
      (command.trim() && Number.isSafeInteger(refreshSeconds) && refreshSeconds > 0)
    )
      return true;
    setErrors({ key: "Enter a token command and a positive whole number of seconds." });
    return false;
  };

  const fetchModels = () =>
    void (async () => {
      startAttempt();
      if (!validCommand()) return;
      setNoList(false);
      const found: Errors = {};
      if (!baseUrl.trim()) {
        setErrors({ address: "Enter the server's address." });
        return;
      }
      setBusy("fetch");
      try {
        const read = await readLine();
        if (!read.destination) {
          addressFailure(read, found);
          return;
        }
        if (http && !approved("http") && !httpRemembered) {
          found.http = "Approve unencrypted HTTP first: fetching sends your key to this address.";
          return;
        }
        const result = await api.connect(connectInput(models, read.destination));
        if (!keep(result.view)) return;
        if (result.failure) {
          const placed = placeCustomApiFailure(result.failure.category, {
            address: read.destination,
            stage: result.failure.stage,
            keyed,
            tokenCommand: auth === "command",
            ...answered(read),
            ...(result.view?.mode || network ? { network: result.view?.mode ?? network } : {}),
            ...(result.failure.suggestion ? { suggestion: result.failure.suggestion } : {}),
          });
          // Without a list, Fetch says so, or offers the address's /v1 when it lacks one.
          if (placed.noList && !placed.fix) setNoList(true);
          else show(placed, found);
          return;
        }
        setListed(result.listed ?? []);
        if (result.view) {
          const view = result.view;
          setModels((current) => filled(current, view));
        }
      } catch (caught) {
        found.save = caught instanceof Error ? caught.message : "Could not reach this server.";
      } finally {
        setErrors(found);
        setBusy("");
      }
    })();

  const finish = (view: CustomApiView) => {
    draftId.current = undefined;
    setKey("");
    void useShellStore.getState().loadFirstRun();
    onSaved?.();
    if (firstSetup && view.enabled && view.models.some((model) => model.checked))
      setSavedView(view);
    else onClose();
  };

  const save = () =>
    void (async () => {
      startAttempt();
      if (!validCommand()) return;
      const found: Errors = {};
      const rows: Record<string, RowError> = {};
      let failedDraft: string | undefined;
      const stop = () => {
        setErrors(found);
        setRowErrors(rows);
        setSummary(
          Object.keys(rows).length && !Object.keys(found).length
            ? "Not saved. Fix the marked row and press Save again."
            : "Not saved. Fix the marked field and press Save again.",
        );
        setPausedDraft(failedDraft);
      };
      // 1 · The form itself; nothing is sent.
      if (!label.trim()) found.name = "Name this connection.";
      if (!baseUrl.trim()) found.address = "Enter the server's address.";
      if (!models.length) found.models = "Add at least one model, or fetch the server's list.";
      const seen = new Set<string>();
      for (const model of models) {
        const modelId = model.id.trim();
        if (!modelId)
          rows[model.uiId] = { text: "Enter the model's ID, or remove this row.", at: "id" };
        else if (seen.has(modelId))
          rows[model.uiId] = { text: "This model is already in the list.", at: "id" };
        else if (model.context && model.output && model.output >= model.context)
          rows[model.uiId] = {
            text: "Enter an output size smaller than the context size.",
            at: "sizes",
          };
        seen.add(modelId);
      }
      if (Object.keys(found).length || Object.keys(rows).length) return stop();
      setBusy("save");
      setProgress("Reaching the server…");
      try {
        const read = await readLine();
        if (!read.destination) {
          addressFailure(read, found);
          return stop();
        }
        if (http && !approved("http") && !httpRemembered) {
          found.http = "Approve unencrypted HTTP to save this address.";
          return stop();
        }
        // 2 · Reach the server: its network, a draft, and its model list.
        const result = await api.connect(connectInput(models, read.destination));
        if (!keep(result.view)) return;
        failedDraft = result.view?.draftId;
        if (result.listed) setListed(result.listed);
        const context: Omit<FailureContext, "stage"> = {
          address: read.destination,
          keyed,
          tokenCommand: auth === "command",
          ...answered(read),
          listed: Boolean(result.listed),
          ...(result.view?.mode || network ? { network: result.view?.mode ?? network } : {}),
        };
        // A server with no model list still saves: its models' checks tell.
        let noListHint: PlacedFailure | undefined;
        if (result.failure) {
          const placed = placeCustomApiFailure(result.failure.category, {
            ...context,
            stage: result.failure.stage,
            ...(result.failure.suggestion ? { suggestion: result.failure.suggestion } : {}),
          });
          if (placed.noList && result.view) noListHint = placed;
          else {
            show(placed, found);
            if (!Object.keys(found).length)
              found.save = placed.text || "This server could not be reached.";
            return stop();
          }
        }
        const view = result.view;
        if (!view?.draftId) {
          found.save = "Your first mate could not prepare this connection. Try again.";
          return stop();
        }
        let current = filled(models, view);
        const mark = (uiId: string, state: RowState) => {
          current = current.map((row) => (row.uiId === uiId ? { ...row, state } : row));
          setModels(current);
        };
        setModels(current);
        // 3 · Test each model, one at a time, with its progress on its row.
        const testable = current.filter((row) => row.id.trim());
        let tested = false;
        for (const [index, row] of testable.entries()) {
          if (!row.context || !row.output) {
            rows[row.uiId] = { text: SIZES_UNKNOWN, at: "sizes" };
            mark(row.uiId, "bad");
            continue;
          }
          tested = true;
          const modelId = row.id.trim();
          mark(row.uiId, "run");
          setProgress(`Checking ${modelId} (${index + 1} of ${testable.length})…`);
          const checked = await api.check(view.draftId, modelId);
          const after = checked.models.find((model) => model.id === modelId);
          if (after?.checked) {
            mark(row.uiId, "ok");
            continue;
          }
          mark(row.uiId, "bad");
          const category: CustomApiFailureCategory = after?.category ?? "malformed";
          const placed = placeCustomApiFailure(category, {
            ...context,
            stage: "check",
            model: modelId,
          });
          if (placed.at === "row")
            rows[row.uiId] = { text: placed.text, at: category === "limits" ? "sizes" : "model" };
          else {
            // The address or the key is at fault, so the other models would fail the same way.
            show(placed, found);
            break;
          }
        }
        // Nothing could be tested, and the list did not answer at this path either.
        if (!tested && noListHint) show(noListHint, found);
        if (Object.keys(found).length || Object.keys(rows).length) return stop();
        // 4 · Saved and ready, unless the form was cancelled meanwhile.
        if (closed.current) return;
        setProgress("Saving…");
        finish(await api.save(view.draftId, false));
      } catch (caught) {
        found.save =
          caught instanceof Error ? caught.message : "This connection could not be saved.";
        stop();
      } finally {
        setBusy("");
        setProgress("");
      }
    })();

  const savePaused = () =>
    void (async () => {
      if (!pausedDraft) return;
      setBusy("save");
      try {
        finish(await api.save(pausedDraft, true));
      } catch (caught) {
        setErrors({
          save: caught instanceof Error ? caught.message : "This connection could not be saved.",
        });
      } finally {
        setBusy("");
      }
    })();

  if (savedView) return <FirstmateChoice view={savedView} onDone={onClose} />;

  const fieldError = (field: Field, extra?: ReactNode) =>
    errors[field] ? (
      <p role="alert" className="fm-custom-field-error" data-custom-error={field}>
        {errors[field]}
        {extra}
      </p>
    ) : null;
  const sent = [
    ...(keyed ? [auth === "command" ? "the token" : "your key"] : []),
    ...(namedHeaders.length
      ? [`your headers (${namedHeaders.map((header) => header.name.trim()).join(", ")})`]
      : []),
    "a short test",
  ];
  const footHint =
    progress ||
    `Save sends ${sent.length > 1 ? `${sent.slice(0, -1).join(", ")} and ${sent.at(-1)}` : sent[0]} to this address, then checks each model. It may use a few tokens.`;

  return (
    <section className="fm-custom-api fm-custom-form" data-custom-api-form>
      <h3>
        {original
          ? `Edit ${original.label}`
          : place
            ? `Add a custom API ${place.on}`
            : "Add a custom API"}
      </h3>
      <p className="fm-custom-hint">
        Connect only a server you trust. It receives your key and what Infinitary sends, may charge
        for requests, and its model can direct work on {who}. Keys are kept in private files on{" "}
        {who}, not encrypted storage.
      </p>
      {/* Held still while Save runs, so what is checked is what is saved. */}
      <fieldset className="fm-custom-body" disabled={busy === "save"}>
        <div className="fm-custom-field">
          <label htmlFor={`${id}-label`}>Name</label>
          <FormInput
            id={`${id}-label`}
            value={label}
            invalid={Boolean(errors.name)}
            onChange={(event) => {
              edited("name");
              setLabel(event.target.value);
            }}
          />
          {fieldError("name")}
        </div>
        <div className="fm-custom-field">
          <label htmlFor={`${id}-address`}>Address</label>
          <FormInput
            id={`${id}-address`}
            mono
            spellCheck={false}
            autoComplete="off"
            value={baseUrl}
            invalid={Boolean(errors.address)}
            placeholder="https://api.example.com/v1"
            onChange={(event) => {
              edited("address", "http");
              setFix(undefined);
              setBase(event.target.value);
            }}
          />
          {errors.address
            ? fieldError(
                "address",
                fix ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    style={{ marginLeft: "var(--space-2)" }}
                    onClick={() => {
                      edited("address");
                      // The app's own correction for the same server keeps what was approved for it.
                      const next = addressKey(fix);
                      setApprovals((current) =>
                        Object.fromEntries(
                          Object.entries(current).map(([what, at]) => [
                            what,
                            at === typedKey ? next : at,
                          ]),
                        ),
                      );
                      setBase(fix);
                      setFix(undefined);
                    }}
                  >
                    Use {fix}
                  </Button>
                ) : null,
              )
            : line.destination && (
                <p className="fm-custom-hint" data-custom-sends-to>
                  Sends to <b className="fm-custom-mono">{line.destination}</b>
                  {approved("exception")
                    ? ` · ${CUSTOM_EXCEPTION_WORDS.line}`
                    : network
                      ? ` · ${customNetworkLabel(network, who)}`
                      : ""}
                </p>
              )}
          {!errors.address &&
            !approved("exception") &&
            line.failure === "destination" &&
            Boolean(line.answers?.length) && (
              <p className="fm-custom-hint" data-custom-answers>
                {destinationWords(answered(line))}
              </p>
            )}
        </div>
        {((line.failure === "destination" && line.exceptionOffered) || approved("exception")) && (
          <div className="fm-custom-http" data-custom-exception>
            <label className="fm-custom-choice">
              <input
                type="checkbox"
                checked={approved("exception")}
                onChange={(event) => approve("exception", event.target.checked)}
              />
              <span>
                Make an exception for {hostOf(line.destination ?? typedKey)}: send to it whatever
                DNS answers, apart from {who} itself, link-local and cloud metadata addresses. Do
                this only if you know why DNS answers this way, such as a proxy app.
              </span>
            </label>
          </div>
        )}
        {http &&
          (httpRemembered ? (
            <p className="fm-custom-hint">Unencrypted HTTP is approved for this address.</p>
          ) : (
            <div className="fm-custom-http" data-invalid={Boolean(errors.http) || undefined}>
              <label className="fm-custom-choice">
                <input
                  type="checkbox"
                  checked={approved("http")}
                  onChange={(event) => approve("http", event.target.checked)}
                />
                <span>
                  Send over unencrypted HTTP. Anyone on the network path can read the key, prompts,
                  project code and replies, or change replies that direct work on {who}.
                  {network === "public" &&
                    " This includes the public internet; use only a server and network path you trust."}
                  {network === "private" &&
                    " On shared Wi-Fi, another private server may answer for your organization's name."}
                </span>
              </label>
              {fieldError("http")}
            </div>
          ))}
        <div className="fm-custom-two">
          <div className="fm-custom-field">
            <label htmlFor={`${id}-auth`}>Connect with</label>
            <select
              id={`${id}-auth`}
              value={auth}
              onChange={(event) => {
                edited("key");
                setAuth(event.target.value);
              }}
            >
              <option value="key">API key (or no key)</option>
              <option value="command">Token command</option>
            </select>
            {auth === "command" ? (
              <>
                <label htmlFor={`${id}-command`}>Token command</label>
                <FormInput
                  id={`${id}-command`}
                  mono
                  value={command}
                  autoComplete="off"
                  invalid={Boolean(errors.key)}
                  onChange={(event) => {
                    edited("key");
                    setCommand(event.target.value);
                  }}
                />
                <label htmlFor={`${id}-refresh`}>Refresh after (seconds)</label>
                <FormInput
                  id={`${id}-refresh`}
                  type="number"
                  min={1}
                  value={String(refreshSeconds)}
                  onChange={(event) => {
                    edited("key");
                    setRefreshSeconds(Number(event.target.value));
                  }}
                />
                <span className="fm-custom-hint">
                  Runs on {who} with your access. Prints only the token. Renew your organization’s
                  sign-in outside Infinitary when needed.
                </span>
              </>
            ) : (
              <>
                <div className="fm-custom-keyrow">
                  <label htmlFor={`${id}-key`}>
                    API key <span className="fm-custom-hint">· optional</span>
                  </label>
                  {keySaved && (
                    <button
                      type="button"
                      className="fm-custom-link"
                      onClick={() => {
                        edited("key");
                        setKeyRemoved(true);
                      }}
                    >
                      Remove saved key
                    </button>
                  )}
                </div>
                <FormInput
                  id={`${id}-key`}
                  type="password"
                  autoComplete="off"
                  value={key}
                  invalid={Boolean(errors.key)}
                  placeholder={
                    keySaved
                      ? "Saved key kept · type to replace"
                      : "Leave empty if the server needs none"
                  }
                  onChange={(event) => {
                    edited("key");
                    setKey(event.target.value);
                  }}
                />
                {place && (
                  <span className="fm-custom-hint">
                    It goes to {who} once. {HERE.This} keeps no copy.
                  </span>
                )}
              </>
            )}
            {fieldError("key")}
          </div>
          <div className="fm-custom-field">
            <label htmlFor={`${id}-protocol`}>API protocol</label>
            <select
              id={`${id}-protocol`}
              value={protocol}
              onChange={(event) => {
                edited();
                const next = event.target.value as CustomApiView["protocol"];
                setProtocol(next);
                setModels((rows) =>
                  rows.map((row) => ({
                    ...row,
                    reasoningProfile: undefined,
                    cacheRetention: customDefaultCacheRetention(next),
                    state: undefined,
                  })),
                );
              }}
            >
              <option value="openai-completions">Chat Completions</option>
              <option value="openai-responses">Responses</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </div>
        </div>
        <details
          className="fm-custom-headers"
          open={headersOpen}
          onToggle={(event) => setHeadersOpen(event.currentTarget.open)}
        >
          <summary ref={headersSummary}>Extra request headers</summary>
          <p className="fm-custom-hint">
            Headers your organization’s server needs on every request. A secret value is masked,
            never shown again, and refused if a reply repeats it.
          </p>
          {headers.map((header, index) => (
            <div className="fm-custom-header" key={header.uiId} data-custom-header={index}>
              <div className="fm-custom-field">
                <label htmlFor={`${id}-header-name-${index}`}>Header name</label>
                <FormInput
                  id={`${id}-header-name-${index}`}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  value={header.name}
                  placeholder="X-Example-Header"
                  onChange={(event) =>
                    changeHeader(header.uiId, { name: event.target.value, saved: false })
                  }
                />
              </div>
              <div className="fm-custom-field">
                <label htmlFor={`${id}-header-value-${index}`}>Header value</label>
                <FormInput
                  id={`${id}-header-value-${index}`}
                  mono
                  type={header.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={header.value}
                  placeholder={
                    header.saved && sameAddress
                      ? "Saved value kept; type to replace it"
                      : "Enter the value"
                  }
                  onChange={(event) =>
                    changeHeader(header.uiId, { value: event.target.value, saved: false })
                  }
                />
              </div>
              <div className="fm-custom-header-actions">
                <label className="fm-custom-choice">
                  <input
                    type="checkbox"
                    checked={header.secret}
                    onChange={(event) =>
                      // A saved secret is never shown, so a visible value is typed afresh.
                      changeHeader(header.uiId, {
                        secret: event.target.checked,
                        ...(header.saved ? { value: "", saved: false } : {}),
                      })
                    }
                  />
                  Secret
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    edited("headers");
                    focusHeaderRow.current = index;
                    setHeaders(headers.filter((entry) => entry.uiId !== header.uiId));
                  }}
                >
                  Remove header
                </Button>
              </div>
            </div>
          ))}
          {headers.length < CUSTOM_API_MAX_HEADERS && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                edited("headers");
                focusHeaderRow.current = headers.length;
                setHeaders([...headers, emptyHeader()]);
              }}
            >
              Add header
            </Button>
          )}
          {fieldError("headers")}
        </details>
        {showCertificates && (
          <fieldset className="fm-custom-box" data-custom-certificates>
            <legend>Organization certificates</legend>
            <p className="fm-custom-hint">
              A public CA certificate from your organization, trusted only for this connection.
              Private keys and client certificates are not supported. Server name, chain and expiry
              checks stay on.
            </p>
            <label htmlFor={`${id}-ca`}>Choose a local PEM CA file</label>
            <input
              id={`${id}-ca`}
              type="file"
              accept=".pem,.crt,.cer"
              onChange={(event) => {
                const file = event.target.files?.[0];
                edited("certificates");
                if (!file || file.size > 65536) {
                  setPem("");
                  setErrors((current) => ({
                    ...current,
                    certificates: "Choose a public CA file no larger than 64 KiB.",
                  }));
                  return;
                }
                void file.text().then(async (text) => {
                  setPem(text);
                  setKeepCertificates(false);
                  setApprovals((current) => ({ ...current, certificates: undefined }));
                  try {
                    const reviewed = await api.review(
                      line.destination ?? baseUrl.trim(),
                      "private",
                      text,
                    );
                    setCertificates(reviewed.certificates);
                  } catch (caught) {
                    setCertificates([]);
                    setErrors((current) => ({
                      ...current,
                      certificates:
                        caught instanceof Error
                          ? caught.message
                          : "This certificate file could not be read.",
                    }));
                  }
                });
              }}
            />
            {certificates.length > 0 && (
              <>
                <ul className="fm-custom-certificates">
                  {certificates.map((certificate) => (
                    <li key={certificate.fingerprint}>
                      <p>{certificate.subject}</p>
                      <p className="fm-custom-hint">
                        Issuer: {certificate.issuer} · {certificate.validFrom} –{" "}
                        {certificate.validTo}
                      </p>
                      <p className="fm-custom-mono">{certificate.fingerprint}</p>
                    </li>
                  ))}
                </ul>
                <label className="fm-custom-choice">
                  <input
                    type="checkbox"
                    checked={approved("certificates")}
                    onChange={(event) => approve("certificates", event.target.checked)}
                  />
                  I approve these certificates only for this private connection
                </label>
              </>
            )}
            {(pem || keepCertificates) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  edited("certificates");
                  setPem("");
                  setKeepCertificates(false);
                  setCertificates([]);
                  setApprovals((current) => ({ ...current, certificates: undefined }));
                }}
              >
                Remove certificate
              </Button>
            )}
            {fieldError("certificates")}
          </fieldset>
        )}
        {protocol === "openai-responses" && (
          <label className="fm-custom-choice" data-custom-storage>
            <input
              type="checkbox"
              checked={approved("storage")}
              onChange={(event) => approve("storage", event.target.checked)}
            />
            <span>
              Allow this server’s storage defaults. Requests otherwise ask the server not to save
              responses; with this, it may keep them. No server-saved conversation is used.
            </span>
          </label>
        )}
        <div className="fm-custom-models">
          <div className="fm-custom-models-head">
            <span className="fm-custom-models-title">Models</span>
            <Button
              variant="secondary"
              size="sm"
              pending={busy === "fetch"}
              pendingLabel="Fetching…"
              disabled={busy !== ""}
              onClick={fetchModels}
            >
              {listed ? "Fetch again" : "Fetch from server"}
            </Button>
          </div>
          {noList && (
            <p className="fm-custom-hint" data-custom-no-list>
              This server doesn’t list its models. Add them by hand.
            </p>
          )}
          {listed && (
            <div className="fm-custom-avail" data-custom-listed-models>
              <p className="fm-custom-hint">
                {listed.length
                  ? `This server lists ${listed.length} ${listed.length === 1 ? "model" : "models"}. Pick the ones you would like to use:`
                  : "This server lists no models. Add them by hand."}
              </p>
              {listed.map((entry) => {
                const added = models.some((model) => model.id.trim() === entry.id);
                return (
                  <button
                    type="button"
                    key={entry.id}
                    className="fm-custom-pick"
                    data-custom-listed={entry.id}
                    aria-pressed={added}
                    disabled={added || busy !== ""}
                    onClick={() => {
                      edited("models");
                      setModels((current) => [
                        ...current,
                        {
                          ...emptyModel(),
                          id: entry.id,
                          context: entry.context ?? 0,
                          output: entry.output ?? 0,
                        },
                      ]);
                    }}
                  >
                    {added ? "✓ " : "+ "}
                    {entry.id}
                  </button>
                );
              })}
            </div>
          )}
          {models.length ? (
            <div className="fm-custom-rows">
              <div className="fm-custom-cols" aria-hidden="true">
                <span />
                <span>Model ID</span>
                <span>Context</span>
                <span>Output</span>
                <span />
              </div>
              {models.map((model, index) => {
                const dot = ROW_DOT[model.state ?? "none"];
                const name = model.id.trim() || "this model";
                return (
                  <div
                    className="fm-custom-row"
                    key={model.uiId}
                    data-custom-model-row={model.id.trim()}
                    data-state={model.state}
                  >
                    <span className="fm-custom-row-dot">
                      <StatusDot tone={dot.tone} label={`${name}: ${dot.label}`} focusable />
                    </span>
                    <FormInput
                      id={`${id}-model-${index}`}
                      mono
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Model ID"
                      invalid={rowErrors[model.uiId]?.at === "id"}
                      value={model.id}
                      onChange={(event) => changeModel(model.uiId, { id: event.target.value })}
                    />
                    <FormInput
                      mono
                      inputMode="numeric"
                      aria-label={`Context tokens for ${name}`}
                      invalid={rowErrors[model.uiId]?.at === "sizes" && !model.context}
                      placeholder="Context"
                      value={model.context ? String(model.context) : ""}
                      onChange={(event) =>
                        changeModel(model.uiId, { context: digits(event.target.value) })
                      }
                    />
                    <FormInput
                      mono
                      inputMode="numeric"
                      aria-label={`Output tokens for ${name}`}
                      invalid={
                        rowErrors[model.uiId]?.at === "sizes" &&
                        (!model.output || model.output >= model.context)
                      }
                      placeholder="Output"
                      value={model.output ? String(model.output) : ""}
                      onChange={(event) =>
                        changeModel(model.uiId, { output: digits(event.target.value) })
                      }
                    />
                    <IconButton
                      label={`Remove ${name}`}
                      size={28}
                      onClick={() => {
                        edited("models");
                        focusModelRow.current = index;
                        setRowErrors(({ [model.uiId]: _, ...rest }) => rest);
                        setModels((current) =>
                          current.filter((entry) => entry.uiId !== model.uiId),
                        );
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        aria-hidden="true"
                      >
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </IconButton>
                    <div className="fm-custom-capabilities">
                      <label className="fm-custom-field">
                        <span>Reasoning profile</span>
                        <select
                          aria-label={`Reasoning profile for ${name}`}
                          value={model.reasoningProfile ?? ""}
                          onChange={(event) =>
                            changeModel(model.uiId, {
                              reasoningProfile: event.target.value || undefined,
                              cacheRetention: customDefaultCacheRetention(protocol),
                            })
                          }
                        >
                          <option value="">Off</option>
                          {profiles
                            .filter((profile) => profile.protocol === protocol)
                            .map((profile) => (
                              <option key={profile.id} value={profile.id}>
                                {profile.label}
                              </option>
                            ))}
                          {model.reasoningProfile &&
                            !profiles.some((profile) => profile.id === model.reasoningProfile) && (
                              <option value={model.reasoningProfile}>
                                {model.reasoningProfile}
                              </option>
                            )}
                        </select>
                      </label>
                      <label className="fm-custom-field">
                        <span>Cache retention</span>
                        <select
                          aria-label={`Cache retention for ${name}`}
                          value={model.cacheRetention ?? customDefaultCacheRetention(protocol)}
                          onChange={(event) =>
                            changeModel(model.uiId, {
                              cacheRetention: event.target.value as FormModel["cacheRetention"],
                            })
                          }
                        >
                          {(["none", "short", "long"] as const).map((retention) => (
                            <option
                              key={retention}
                              value={retention}
                              disabled={
                                !(
                                  profiles.find((profile) => profile.id === model.reasoningProfile)
                                    ?.cacheRetentions ?? customUnprofiledRetentions(protocol)
                                ).includes(retention)
                              }
                            >
                              {retention === "none"
                                ? "None"
                                : retention === "short"
                                  ? "Short"
                                  : "Long"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="fm-custom-hint">
                        Save checks the chosen profile and cache setting. Checks may incur charges;
                        they do not prove reasoning or a cache hit. Your server may cache
                        automatically, even with None.
                      </p>
                      {profileFailure && (
                        <p role="alert" className="fm-custom-hint">
                          Capability profiles could not be read. Close and reopen this form to try
                          again.
                        </p>
                      )}
                    </div>
                    {rowErrors[model.uiId] && (
                      <p role="alert" className="fm-custom-field-error fm-custom-row-error">
                        {rowErrors[model.uiId]?.text}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="fm-custom-hint">
              No models yet. Fetch them from the server, or add one by hand.
            </p>
          )}
          {fieldError("models")}
          <div>
            <button
              ref={addByHand}
              type="button"
              className="fm-custom-link"
              onClick={() => {
                edited("models");
                focusModelRow.current = models.length;
                setModels([...models, emptyModel()]);
              }}
            >
              + Add by hand
            </button>
          </div>
        </div>
      </fieldset>
      {original && !sameAddress && (
        <p className="fm-custom-hint">
          A different address saves a separate connection. The original stays until you disconnect
          it.
        </p>
      )}
      {(summary || errors.save) && (
        <div className="fm-custom-summary" role="status" data-custom-summary>
          {errors.save && (
            <p role="alert" className="fm-custom-field-error" data-custom-error="save">
              {errors.save}
            </p>
          )}
          {summary && <span>{summary}</span>}
          {pausedDraft && !sameAddressEdit && (
            <button
              type="button"
              className="fm-custom-link"
              disabled={busy !== ""}
              onClick={savePaused}
            >
              Save paused without checking
            </button>
          )}
        </div>
      )}
      {auth === "command" && (
        <div className="fm-custom-command-approval" data-custom-command-approval>
          <p className="fm-custom-hint">
            Save or Fetch from server runs this command to get a token. Infinitary runs it again
            after the refresh interval or one refusal.
          </p>
          <pre>{command}</pre>
        </div>
      )}
      <div className="fm-custom-foot">
        <span className="fm-custom-hint" aria-live="polite">
          {footHint}
        </span>
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          pending={busy === "save"}
          pendingLabel="Checking…"
          disabled={busy !== ""}
          onClick={save}
        >
          Save
        </Button>
      </div>
    </section>
  );
}

/** First setup's last question: which checked model Firstmate answers with. */
function FirstmateChoice({ view, onDone }: { view: CustomApiView; onDone: () => void }) {
  const [provider, setProvider] = useState("");
  const [error, setError] = useState("");
  const [choosing, setChoosing] = useState(false);
  useEffect(() => {
    void window.infinitary.accounts
      .list()
      .then((accounts) =>
        setProvider(accounts.find((account) => account.id === view.accountId)?.providerId ?? ""),
      )
      .catch(() => setError("Could not read this connection."));
  }, [view.accountId]);
  return (
    <section className="fm-custom-api fm-custom-form" data-custom-api-form data-custom-choose>
      <h3>{view.label} is ready</h3>
      <p>Which model should your first mate answer with?</p>
      <div className="fm-custom-choices">
        {view.models
          .filter((model) => model.checked)
          .map((model) => (
            <Button
              key={model.id}
              variant="secondary"
              size="sm"
              disabled={!provider || choosing}
              onClick={() => {
                setChoosing(true);
                void window.infinitary.settings
                  .setFirstmateModel({ provider, id: model.id })
                  .then(() => {
                    void useShellStore.getState().loadFirstRun();
                    onDone();
                  })
                  .catch((caught: unknown) => {
                    setChoosing(false);
                    setError(
                      caught instanceof Error ? caught.message : "Could not choose this model.",
                    );
                  });
              }}
            >
              Use {model.id}
            </Button>
          ))}
      </div>
      <p className="fm-custom-hint">
        Crew use for these models is set on the Models board in Settings, under Intelligence.
      </p>
      {error && (
        <p role="alert" className="fm-custom-field-error">
          {error}
        </p>
      )}
      <div className="fm-custom-foot">
        <span />
        <Button variant="ghost" size="sm" onClick={onDone}>
          Choose later
        </Button>
      </div>
    </section>
  );
}

type FirstmateModel = { provider: string; id: string } | null;

/**
 * One connection saved on a computer that runs work: status, Edit and
 * Disconnect. No Pause, and no Firstmate choice — that model stays on this Mac.
 */
export function RemoteCustomConnection({
  view,
  client,
  place,
  onDisconnect,
}: {
  view: CustomApiView;
  client: CustomApiClient;
  place: { who: string; on: string };
  onDisconnect: (accountId: string) => void;
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
            Unencrypted
          </span>
        )}
        <span
          className="fm-custom-tag"
          data-tone={view.tokenCommandFailed ? "danger" : ready ? "ok" : "idle"}
        >
          {view.tokenCommandFailed ? CUSTOM_TOKEN_FAILURE.status : ready ? "Ready" : "Not checked"}
        </span>
        <span className="fm-custom-acts">
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setArmed(true)}>
            Disconnect
          </Button>
        </span>
      </div>
      {view.tokenCommandFailed && (
        <p role="alert" className="fm-custom-field-error">
          {CUSTOM_TOKEN_FAILURE.row}
        </p>
      )}
      <div className="fm-custom-lrow fm-custom-lcols" aria-hidden="true">
        <span>MODEL</span>
        <span>STATUS</span>
      </div>
      {view.models.map((model) => (
        <div className="fm-custom-lrow" key={model.id} data-custom-model={model.id}>
          <span className="fm-custom-mono fm-custom-model-id">{model.id}</span>
          <span className="fm-custom-status">
            <StatusDot
              tone={model.checked && view.enabled ? "ok" : "ring"}
              label={model.checked && view.enabled ? "Ready" : "Not checked"}
              nativeTitle={false}
            />
            {model.checked && view.enabled ? "Ready" : "Not checked"}
            {model.readsPictures && <Badge tone="accent">{CUSTOM_READS_PICTURES}</Badge>}
          </span>
        </div>
      ))}
      <p className="fm-custom-lock">
        Crew use for these models is set on the Models board, further down Intelligence. A model
        here runs only on {place.who}.
      </p>
      {armed && (
        <div className="fm-custom-disconnect">
          <p>
            Disconnect removes this connection on {place.who}. {HERE.This} keeps no copy of its key.
          </p>
          <div className="fm-custom-acts">
            <Button variant="secondary" size="sm" onClick={() => onDisconnect(accountId)}>
              Disconnect
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setArmed(false)}>
              Keep connection
            </Button>
          </div>
        </div>
      )}
      {editing && (
        <CustomApiDialog label={`Edit ${view.label}`} onClose={() => setEditing(false)}>
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

/**
 * A connection's model chosen to run the first mate. One that cannot run it
 * yet stays a stop of its own, marked off (`aria-disabled`) rather than
 * disabled, with its reason on rest, the pointer's or the keyboard's focus,
 * and as its description; choosing it does nothing (docs/keyboard.md, "Facts
 * shown on rest").
 */
function FirstmateRadio({
  model,
  chosen,
  off,
  onChoose,
}: {
  model: string;
  chosen: boolean;
  /** Why it cannot be chosen yet; absent while it can. */
  off: string | undefined;
  onChoose: () => void;
}) {
  const rest = useRestLabel(off, { fact: true });
  return (
    <label className="fm-custom-choice">
      <input
        type="radio"
        name="custom-api-firstmate"
        aria-label={`Use ${model} for your first mate`}
        aria-description={off}
        aria-disabled={off === undefined ? undefined : "true"}
        checked={chosen}
        {...rest}
        onClick={(event) => {
          if (off !== undefined) event.preventDefault();
        }}
        onChange={() => {
          if (off === undefined) onChoose();
        }}
      />
      First mate
    </label>
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
      .catch(() => setError("Could not read your custom connections."));
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
  return (
    <div className="fm-custom-list" data-custom-api-accounts>
      {views.map((view) => {
        const accountId = view.accountId ?? "";
        const provider = providers[accountId] ?? "";
        const checked = view.models.length > 0 && view.models.every((model) => model.checked);
        const ready = view.enabled && checked;
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
                  Unencrypted
                </span>
              )}
              {view.tokenCommand && <span className="fm-custom-tag">Token command</span>}
              {view.addressException && (
                <span className="fm-custom-tag" data-tone="warn">
                  {CUSTOM_EXCEPTION_WORDS.tag}
                </span>
              )}
              <span
                className="fm-custom-tag"
                data-tone={view.tokenCommandFailed ? "danger" : ready ? "ok" : "idle"}
              >
                {view.tokenCommandFailed
                  ? CUSTOM_TOKEN_FAILURE.status
                  : ready
                    ? "Ready"
                    : checked
                      ? "Paused"
                      : "Paused · not checked"}
              </span>
              <span className="fm-custom-acts">
                <Button variant="ghost" size="sm" onClick={() => setEditing(view)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  off={!view.enabled && !checked}
                  note={
                    !view.enabled && !checked
                      ? "Edit and Save to check these models before resuming."
                      : undefined
                  }
                  onClick={() =>
                    void window.infinitary.accounts
                      .setEnabled(accountId, !view.enabled)
                      .then(refresh)
                      .catch(failed("Could not change this connection."))
                  }
                >
                  {view.enabled ? "Pause" : "Resume"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setArmed(accountId)}>
                  Disconnect
                </Button>
              </span>
            </div>
            <div className="fm-custom-lrow fm-custom-lcols" aria-hidden="true">
              <span>MODEL</span>
              <span>STATUS</span>
              <span>FIRSTMATE</span>
            </div>
            {view.models.map((model) => {
              const usable = Boolean(provider) && view.enabled && model.checked;
              const isChosen = chosen?.provider === provider && chosen.id === model.id;
              return (
                <div className="fm-custom-lrow" key={model.id} data-custom-model={model.id}>
                  <span className="fm-custom-mono fm-custom-model-id">{model.id}</span>
                  <span className="fm-custom-status">
                    <StatusDot
                      tone={model.checked ? (view.enabled ? "ok" : "idle") : "ring"}
                      label={model.checked ? (view.enabled ? "Ready" : "Checked") : "Not checked"}
                      nativeTitle={false}
                    />
                    {model.checked ? (view.enabled ? "Ready" : "Checked") : "Not checked"}
                    {model.readsPictures && <Badge tone="accent">{CUSTOM_READS_PICTURES}</Badge>}
                  </span>
                  <FirstmateRadio
                    model={model.id}
                    chosen={isChosen}
                    off={
                      usable
                        ? undefined
                        : model.checked
                          ? "Resume this connection to use it."
                          : "Edit and Save to check this model first."
                    }
                    onChoose={() => {
                      const before = chosen;
                      choosing.current = true;
                      setChosen({ provider, id: model.id });
                      void window.infinitary.settings
                        .setFirstmateModel({ provider, id: model.id })
                        .then(setChosen, (caught: unknown) => {
                          setChosen(before);
                          failed("Could not choose this model.")(caught);
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
            {!checked ? (
              <p className="fm-custom-lock">Edit and Save to check these models before use.</p>
            ) : !view.enabled ? (
              <p className="fm-custom-lock">Paused. Resume to use these models.</p>
            ) : null}
            <p className="fm-custom-lock">
              Crew use for these models is set on the Models board, further down Intelligence.
            </p>
            {armed === accountId && (
              <div className="fm-custom-disconnect">
                <p>
                  Disconnect immediately stops matching work and your first mate if it uses this
                  connection. It removes only this connection locally, keeps your task history, and
                  does not move stopped work to another server. It cannot revoke the server’s key or
                  erase content already sent.
                </p>
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
                        .catch(failed("Could not disconnect this connection."))
                    }
                  >
                    Stop work and disconnect
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setArmed(undefined)}>
                    Keep connection
                  </Button>
                </div>
              </div>
            )}
          </section>
        );
      })}
      {editing && (
        <CustomApiDialog
          label={`Edit ${editing.label}`}
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

/** The same bounded, focus-contained aside at every entry point: first setup, Add and Edit. */
export function CustomApiDialog({
  children,
  label = "Custom API connection",
  onClose,
}: {
  children: ReactNode;
  label?: string;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useModalKeys(root, onClose);
  return createPortal(
    <div className="fm-custom-overlay">
      <div
        ref={root}
        className="fm-custom-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
