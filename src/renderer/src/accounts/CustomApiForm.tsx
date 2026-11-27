import {
  CUSTOM_API_MAX_HEADERS,
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
  customExactProfile,
  customNetworkLabel,
  customUnprofiledRetentions,
} from "@shared/customApi";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShellStore } from "../app/store";
import { Button, IconButton, StatusDot, type StatusDotTone } from "../design";
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
import type { CustomFileDefinition } from "@shared/customApiFile";
import { HERE } from "@shared/deviceNames";
import { formatList } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { FirstmateChoice } from "./CustomApiFirstmate";
import { CustomModelPrice, type PriceText, priceText, typedCost } from "./CustomModelPrice";
import { FormInput } from "./FormInput";

type RowState = "run" | "ok" | "bad";
const emptyModel = (): FormModel => ({ id: "", context: 0, output: 0, uiId: crypto.randomUUID() });
type FormModel = {
  id: string;
  context: number;
  output: number;
  uiId: string;
  state?: RowState;
  reasoningProfile?: string;
  /** A person chose this line's profile, or it was saved: an exact ID match never replaces it. */
  profileChosen?: boolean;
  cacheRetention?: "none" | "short" | "long";
  name?: string;
  prices?: PriceText;
};
/** A line nobody chose a profile for takes its exact catalog match, or none. */
function withExactProfile(
  row: FormModel,
  protocol: CustomApiView["protocol"],
  profiles: readonly CustomCapabilityProfile[],
): FormModel {
  if (row.profileChosen) return row;
  const pick = customExactProfile(profiles, protocol, row.id);
  if (pick === row.reasoningProfile) return row;
  return { ...row, reasoningProfile: pick, cacheRetention: customDefaultCacheRetention(protocol) };
}
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
type RowError = { text: string; at: "id" | "sizes" | "model" | "price" };
/** An approval holds for the address it was given for, and returns with that address. */
type Approvals = { http?: string; storage?: string; certificates?: string; exception?: string };

const sizesUnknown = () => placeCustomApiFailure("limits", { address: "", stage: "check" }).text;
const ROW_DOT: Record<RowState | "none", { tone: StatusDotTone; readonly label: string }> = {
  none: {
    tone: "ring",
    get label() {
      return m.accountsCustomApiRowNotChecked();
    },
  },
  run: {
    tone: "busy",
    get label() {
      return m.accountsCustomApiRowChecking();
    },
  },
  ok: {
    tone: "ok",
    get label() {
      return m.accountsCustomApiRowChecked();
    },
  },
  bad: {
    tone: "danger",
    get label() {
      return m.accountsCustomApiRowFailed();
    },
  },
};
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
/** Marks where a part drawn in its own type sits in a sentence, so the sentence stays one message. */
const PART_MARK = "\u0000";
const aroundPart = (text: string): [string, string] => {
  const [before = "", after = ""] = text.split(PART_MARK);
  return [before, after];
};

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

/** The calls the form makes on a computer that runs work: they ask it there, through the home. */
export function deviceCustomClient(deviceId: string): CustomApiClient {
  const custom = window.infinitary.devices.custom;
  return {
    profiles: () => custom.profiles(deviceId),
    address: (baseUrl) => custom.address(deviceId, baseUrl),
    connect: (input) => custom.connect(deviceId, input),
    check: (draftId, modelId) => custom.check(deviceId, draftId, modelId),
    save: (draftId, paused) => custom.save(deviceId, draftId, paused),
    cancel: (draftId) => custom.cancel(deviceId, draftId),
    review: (baseUrl, mode, pem) => custom.review(deviceId, baseUrl, mode, pem),
  };
}

export function CustomApiForm({
  original,
  fromFile,
  fromHome,
  firstSetup = false,
  onClose,
  onSaved,
  client,
  place,
}: {
  original?: CustomApiView;
  /**
   * A connection the connection file defines, approved here: the file sets its
   * name, address, protocol, visible headers and models, so those stay locked,
   * and each computer types only its own key, secret header values and any
   * size the file leaves out.
   */
  fromFile?: { name: string; definition: CustomFileDefinition };
  /**
   * One of the first mate's computer's own connections, used on the computer
   * `place` names: its account id there and what it says now, locked as a
   * file's are, while that computer types its own key and secret values.
   */
  fromHome?: { name: string; definition: CustomFileDefinition };
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
  const id = useId();
  const defined = (fromFile ?? fromHome)?.definition;
  const locked = Boolean(defined);
  const [label, setLabel] = useState(defined?.label ?? original?.label ?? "");
  const [baseUrl, setBase] = useState(defined?.baseUrl ?? original?.baseUrl ?? "");
  const [protocol, setProtocol] = useState<CustomApiView["protocol"]>(
    defined?.protocol ?? original?.protocol ?? "openai-completions",
  );
  // The first ask starts the live catalogs' download; a protocol change asks
  // again, so models that landed meanwhile are listed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a protocol change is the cue to ask again.
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
  }, [api, protocol]);
  const [key, setKey] = useState("");
  const [keyRemoved, setKeyRemoved] = useState(false);
  const [auth, setAuth] = useState(original?.tokenCommand ? "command" : "key");
  const [command, setCommand] = useState(original?.tokenCommand?.command ?? "");
  const [refreshSeconds, setRefreshSeconds] = useState(
    original?.tokenCommand?.refreshSeconds ?? 300,
  );
  const [headers, setHeaders] = useState<FormHeader[]>(
    (defined?.headers ?? original?.headers)?.map((header) => ({
      ...emptyHeader(),
      name: header.name,
      value: header.value ?? "",
      secret: header.secret,
      // A secret this computer already keeps for the same header stays kept.
      saved:
        header.secret &&
        (!defined ||
          Boolean(
            original?.headers.some(
              (kept) => kept.secret && kept.name.toLowerCase() === header.name.toLowerCase(),
            ),
          )),
    })) ?? [],
  );
  const [headersOpen, setHeadersOpen] = useState(Boolean((defined ?? original)?.headers.length));
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
    defined?.models.map(
      ({ id, context, output, reasoningProfile, cacheRetention, name, cost }) => ({
        reasoningProfile,
        name,
        prices: priceText(cost),
        profileChosen: true,
        cacheRetention,
        id,
        context,
        output,
        uiId: crypto.randomUUID(),
      }),
    ) ??
      original?.models.map(
        ({ id, context, output, checked, reasoningProfile, cacheRetention, name, cost }) => ({
          reasoningProfile,
          name,
          prices: priceText(cost),
          profileChosen: true,
          cacheRetention,
          id,
          context,
          output,
          uiId: crypto.randomUUID(),
          ...(checked ? { state: "ok" as const } : {}),
        }),
      ) ??
      [],
  );
  // Profiles arrive after the form opens: lines typed meanwhile take their match then.
  useEffect(() => {
    setModels((rows) => {
      const next = rows.map((row) => withExactProfile(row, protocol, profiles));
      return next.some((row, index) => row !== rows[index]) ? next : rows;
    });
  }, [profiles, protocol]);
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
        model.uiId === uiId
          ? withExactProfile({ ...model, ...change, state: undefined }, protocol, profiles)
          : model,
      ),
    );
  };
  /** A name or price is no part of the model's check, so the line keeps its state. */
  const describeModel = (uiId: string, change: Pick<FormModel, "name" | "prices">) => {
    edited("models");
    setRowErrors(({ [uiId]: _, ...rest }) => rest);
    setModels((current) =>
      current.map((model) => (model.uiId === uiId ? { ...model, ...change } : model)),
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
      // The connection's name when none was typed, kept in the language it was saved in.
      label: label.trim() || m.accountsConnectCustomApi(),
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
        .map(({ id, context, output, reasoningProfile, cacheRetention, name, prices }) => {
          const cost = typedCost(prices);
          return {
            id: id.trim(),
            context,
            output,
            reasoningProfile,
            cacheRetention,
            ...(name?.trim() ? { name: name.trim() } : {}),
            ...(cost && cost !== "invalid" ? { cost } : {}),
            ...fileModelFacts(defined, id.trim()),
          };
        }),
      ...(defined?.compaction ? { compaction: defined.compaction } : {}),
      ...(fromFile ? { file: fromFile.name } : {}),
      ...(fromHome ? { home: fromHome.name } : {}),
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
    setErrors({ key: m.accountsCustomApiCommandNeeded() });
    return false;
  };

  const fetchModels = () =>
    void (async () => {
      startAttempt();
      if (!validCommand()) return;
      setNoList(false);
      const found: Errors = {};
      if (!baseUrl.trim()) {
        setErrors({ address: m.accountsCustomApiAddressNeeded() });
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
          found.http = m.accountsCustomApiHttpFirst();
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
        found.save = caught instanceof Error ? caught.message : m.accountsCustomApiFetchFailed();
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
        // The words beside Save mark no field, so they alone never ask for one to be fixed.
        const fields = Object.keys(found).filter((field) => field !== "save");
        setSummary(
          fields.length
            ? m.accountsCustomApiNotSavedField()
            : Object.keys(rows).length
              ? m.accountsCustomApiNotSavedRow()
              : m.accountsCustomApiNotSaved(),
        );
        setPausedDraft(failedDraft);
      };
      if (!label.trim()) found.name = m.accountsCustomApiNameNeeded();
      if (!baseUrl.trim()) found.address = m.accountsCustomApiAddressNeeded();
      if (!models.length) found.models = m.accountsCustomApiModelsNeeded();
      const seen = new Set<string>();
      for (const model of models) {
        const modelId = model.id.trim();
        if (!modelId) rows[model.uiId] = { text: m.accountsCustomApiModelIdNeeded(), at: "id" };
        else if (seen.has(modelId))
          rows[model.uiId] = { text: m.accountsCustomApiModelTwice(), at: "id" };
        else if (model.context && model.output && model.output >= model.context)
          rows[model.uiId] = {
            text: m.accountsCustomApiOutputTooLarge(),
            at: "sizes",
          };
        else if (typedCost(model.prices) === "invalid")
          rows[model.uiId] = { text: m.accountsCustomApiPriceInvalid(), at: "price" };
        seen.add(modelId);
      }
      if (Object.keys(found).length || Object.keys(rows).length) return stop();
      setBusy("save");
      setProgress(m.accountsCustomApiReaching());
      try {
        const read = await readLine();
        if (!read.destination) {
          addressFailure(read, found);
          return stop();
        }
        if (http && !approved("http") && !httpRemembered) {
          found.http = m.accountsCustomApiHttpToSave();
          return stop();
        }
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
              found.save = placed.text || m.accountsCustomApiNotReached();
            return stop();
          }
        }
        const view = result.view;
        if (!view?.draftId) {
          found.save = m.accountsCustomApiPrepareFailed();
          return stop();
        }
        let current = filled(models, view);
        const mark = (uiId: string, state: RowState) => {
          current = current.map((row) => (row.uiId === uiId ? { ...row, state } : row));
          setModels(current);
        };
        setModels(current);
        const testable = current.filter((row) => row.id.trim());
        let tested = false;
        for (const [index, row] of testable.entries()) {
          if (!row.context || !row.output) {
            rows[row.uiId] = { text: sizesUnknown(), at: "sizes" };
            mark(row.uiId, "bad");
            continue;
          }
          tested = true;
          const modelId = row.id.trim();
          // A saved check that still counts, such as after a name or price edit, is not sent again.
          if (view.models.find((model) => model.id === modelId)?.checked) {
            mark(row.uiId, "ok");
            continue;
          }
          mark(row.uiId, "run");
          setProgress(
            m.accountsCustomApiCheckingModel({
              model: modelId,
              index: String(index + 1),
              total: String(testable.length),
            }),
          );
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
            ...(after?.status !== undefined ? { status: after.status } : {}),
            ...(after?.reason ? { reason: after.reason } : {}),
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
        if (closed.current) return;
        setProgress(m.accountsCustomApiSaving());
        finish(await api.save(view.draftId, false));
      } catch (caught) {
        found.save = caught instanceof Error ? caught.message : m.accountsCustomApiSaveFailed();
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
          save: caught instanceof Error ? caught.message : m.accountsCustomApiSaveFailed(),
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
    ...(keyed
      ? [auth === "command" ? m.accountsCustomApiSentToken() : m.accountsCustomApiSentKey()]
      : []),
    ...(namedHeaders.length
      ? [
          m.accountsCustomApiSentHeaders({
            names: namedHeaders.map((header) => header.name.trim()).join(", "),
          }),
        ]
      : []),
    m.accountsCustomApiSentTest(),
  ];
  const footHint = progress || m.accountsCustomApiFootHint({ sent: formatList(sent) });
  const [sendsBefore, sendsAfter] = aroundPart(
    m.accountsCustomApiSendsTo({ destination: PART_MARK }),
  );

  return (
    <section className="fm-custom-api fm-custom-form" data-custom-api-form>
      <h3>
        {fromHome
          ? m.accountsCustomApiUseTitle({ name: label, on: place?.on ?? "" })
          : fromFile
            ? m.accountsCustomApiApproveTitle({ name: label })
            : original
              ? m.accountsCustomApiEditTitle({ name: original.label })
              : place
                ? m.accountsCustomApiAddTitleOn({ on: place.on })
                : m.accountsCustomApiAddTitle()}
      </h3>
      <p className="fm-custom-hint">{m.accountsCustomApiTrustHint({ who })}</p>
      {locked && (
        <p className="fm-custom-hint" data-custom-from-file>
          {fromHome
            ? m.accountsCustomApiHomeSets({ home: home.this, who })
            : m.accountsCustomApiFileSets({ who })}
        </p>
      )}
      {/* Held still while Save runs, so what is checked is what is saved. */}
      <fieldset className="fm-custom-body" disabled={busy === "save"}>
        <div className="fm-custom-field">
          <label htmlFor={`${id}-label`}>{m.accountsCustomApiNameLabel()}</label>
          <FormInput
            id={`${id}-label`}
            value={label}
            readOnly={locked}
            invalid={Boolean(errors.name)}
            onChange={(event) => {
              edited("name");
              setLabel(event.target.value);
            }}
          />
          {fieldError("name")}
        </div>
        <div className="fm-custom-field">
          <label htmlFor={`${id}-address`}>{m.accountsCustomApiAddressLabel()}</label>
          <FormInput
            id={`${id}-address`}
            mono
            spellCheck={false}
            autoComplete="off"
            value={baseUrl}
            readOnly={locked}
            invalid={Boolean(errors.address)}
            // i18n-exempt: a sample address
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
                    style={{ marginInlineStart: "var(--space-2)" }}
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
                    {m.accountsCustomApiUseFix({ address: fix })}
                  </Button>
                ) : null,
              )
            : line.destination && (
                <p className="fm-custom-hint" data-custom-sends-to>
                  {sendsBefore}
                  <b className="fm-custom-mono">{line.destination}</b>
                  {sendsAfter}

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
                {m.accountsCustomApiException({
                  host: hostOf(line.destination ?? typedKey),
                  who,
                })}
              </span>
            </label>
          </div>
        )}
        {http &&
          (httpRemembered ? (
            <p className="fm-custom-hint">{m.accountsCustomApiHttpApproved()}</p>
          ) : (
            <div className="fm-custom-http" data-invalid={Boolean(errors.http) || undefined}>
              <label className="fm-custom-choice">
                <input
                  type="checkbox"
                  checked={approved("http")}
                  onChange={(event) => approve("http", event.target.checked)}
                />
                <span>
                  {network === "public"
                    ? m.accountsCustomApiHttpPublic({ who })
                    : network === "private"
                      ? m.accountsCustomApiHttpPrivate({ who })
                      : m.accountsCustomApiHttp({ who })}
                </span>
              </label>
              {fieldError("http")}
            </div>
          ))}
        <div className="fm-custom-two">
          <div className="fm-custom-field">
            <label htmlFor={`${id}-auth`}>{m.accountsCustomApiConnectWith()}</label>
            <select
              id={`${id}-auth`}
              value={auth}
              onChange={(event) => {
                edited("key");
                setAuth(event.target.value);
              }}
            >
              <option value="key">{m.accountsCustomApiAuthKey()}</option>
              <option value="command">{m.accountsCustomApiTokenCommand()}</option>
            </select>
            {auth === "command" ? (
              <>
                <label htmlFor={`${id}-command`}>{m.accountsCustomApiTokenCommand()}</label>
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
                <label htmlFor={`${id}-refresh`}>{m.accountsCustomApiRefreshAfter()}</label>
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
                <span className="fm-custom-hint">{m.accountsCustomApiCommandHint({ who })}</span>
              </>
            ) : (
              <>
                <div className="fm-custom-keyrow">
                  <label htmlFor={`${id}-key`}>
                    {m.accountsCustomApiKeyLabel()}{" "}
                    <span className="fm-custom-hint">{m.accountsCustomApiKeyOptional()}</span>
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
                      {m.accountsCustomApiRemoveSavedKey()}
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
                    keySaved ? m.accountsCustomApiSavedKeyKept() : m.accountsCustomApiKeyEmpty()
                  }
                  onChange={(event) => {
                    edited("key");
                    setKey(event.target.value);
                  }}
                />
                {place && (
                  <span className="fm-custom-hint">
                    {m.accountsCustomApiKeyGoesTo({ who, here: HERE.This })}
                  </span>
                )}
              </>
            )}
            {fieldError("key")}
          </div>
          <div className="fm-custom-field">
            <label htmlFor={`${id}-protocol`}>{m.accountsCustomApiProtocol()}</label>
            <select
              id={`${id}-protocol`}
              value={protocol}
              disabled={locked}
              onChange={(event) => {
                edited();
                const next = event.target.value as CustomApiView["protocol"];
                setProtocol(next);
                setModels((rows) =>
                  rows.map((row) =>
                    withExactProfile(
                      {
                        ...row,
                        reasoningProfile: undefined,
                        profileChosen: false,
                        cacheRetention: customDefaultCacheRetention(next),
                        state: undefined,
                      },
                      next,
                      profiles,
                    ),
                  ),
                );
              }}
            >
              {/* i18n-exempt: the API protocols' own names */}
              <option value="openai-completions">Chat Completions</option>
              {/* i18n-exempt: the API protocols' own names */}
              <option value="openai-responses">Responses</option>
              {/* i18n-exempt: the API protocols' own names */}
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </div>
        </div>
        <details
          className="fm-custom-headers"
          open={headersOpen}
          onToggle={(event) => setHeadersOpen(event.currentTarget.open)}
        >
          <summary ref={headersSummary}>{m.accountsCustomApiHeadersTitle()}</summary>
          <p className="fm-custom-hint">{m.accountsCustomApiHeadersHint()}</p>
          {headers.map((header, index) => (
            <div className="fm-custom-header" key={header.uiId} data-custom-header={index}>
              <div className="fm-custom-field">
                <label htmlFor={`${id}-header-name-${index}`}>
                  {m.accountsCustomApiHeaderName()}
                </label>
                <FormInput
                  id={`${id}-header-name-${index}`}
                  mono
                  autoComplete="off"
                  spellCheck={false}
                  value={header.name}
                  readOnly={locked}
                  // i18n-exempt: a sample header name
                  placeholder="X-Example-Header"
                  onChange={(event) =>
                    changeHeader(header.uiId, { name: event.target.value, saved: false })
                  }
                />
              </div>
              <div className="fm-custom-field">
                <label htmlFor={`${id}-header-value-${index}`}>
                  {m.accountsCustomApiHeaderValue()}
                </label>
                <FormInput
                  id={`${id}-header-value-${index}`}
                  mono
                  type={header.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={header.value}
                  readOnly={locked && !header.secret}
                  placeholder={
                    header.saved && sameAddress
                      ? m.accountsCustomApiSavedValueKept()
                      : m.accountsCustomApiEnterValue()
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
                    disabled={locked}
                    onChange={(event) =>
                      // A saved secret is never shown, so a visible value is typed afresh.
                      changeHeader(header.uiId, {
                        secret: event.target.checked,
                        ...(header.saved ? { value: "", saved: false } : {}),
                      })
                    }
                  />
                  {m.accountsCustomApiSecret()}
                </label>
                {!locked && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      edited("headers");
                      focusHeaderRow.current = index;
                      setHeaders(headers.filter((entry) => entry.uiId !== header.uiId));
                    }}
                  >
                    {m.accountsCustomApiRemoveHeader()}
                  </Button>
                )}
              </div>
            </div>
          ))}
          {!locked && headers.length < CUSTOM_API_MAX_HEADERS && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                edited("headers");
                focusHeaderRow.current = headers.length;
                setHeaders([...headers, emptyHeader()]);
              }}
            >
              {m.accountsCustomApiAddHeader()}
            </Button>
          )}
          {fieldError("headers")}
        </details>
        {showCertificates && (
          <fieldset className="fm-custom-box" data-custom-certificates>
            <legend>{m.accountsCustomApiCertificatesTitle()}</legend>
            <p className="fm-custom-hint">{m.accountsCustomApiCertificatesHint()}</p>
            <label htmlFor={`${id}-ca`}>{m.accountsCustomApiChooseCertificate()}</label>
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
                    certificates: m.accountsCustomApiCertificateTooLarge(),
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
                          : m.accountsCustomApiCertificateUnreadable(),
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
                        {m.accountsCustomApiIssuer({
                          issuer: certificate.issuer,
                          from: certificate.validFrom,
                          to: certificate.validTo,
                        })}
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
                  {m.accountsCustomApiApproveCertificates()}
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
                {m.accountsCustomApiRemoveCertificate()}
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
            <span>{m.accountsCustomApiStorage()}</span>
          </label>
        )}
        {/* Not one disabled fieldset: a size the file leaves out stays open to type here. */}
        <fieldset className="fm-custom-body">
          <div className="fm-custom-models">
            <div className="fm-custom-models-head">
              <span className="fm-custom-models-title">{m.accountsCustomApiModelsTitle()}</span>
              {!locked && (
                <Button
                  variant="secondary"
                  size="sm"
                  pending={busy === "fetch"}
                  pendingLabel={m.accountsCustomApiFetching()}
                  disabled={busy !== ""}
                  onClick={fetchModels}
                >
                  {listed ? m.accountsCustomApiFetchAgain() : m.accountsCustomApiFetch()}
                </Button>
              )}
            </div>
            {noList && (
              <p className="fm-custom-hint" data-custom-no-list>
                {m.accountsCustomApiNoList()}
              </p>
            )}
            {listed && (
              <div className="fm-custom-avail" data-custom-listed-models>
                <p className="fm-custom-hint">
                  {listed.length
                    ? m.accountsCustomApiListed({ count: listed.length })
                    : m.accountsCustomApiListedNone()}
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
                      disabled={added || entry.notChat || busy !== "" || locked}
                      onClick={() => {
                        edited("models");
                        setModels((current) => [
                          ...current,
                          withExactProfile(
                            {
                              ...emptyModel(),
                              id: entry.id,
                              context: entry.context ?? 0,
                              output: entry.output ?? 0,
                            },
                            protocol,
                            profiles,
                          ),
                        ]);
                      }}
                    >
                      {entry.notChat ? "" : added ? "✓ " : "+ "}
                      {entry.id}
                      {entry.notChat && (
                        <span className="fm-custom-pick-note">
                          {" · "}
                          {m.accountsCustomApiNotChat()}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {models.length ? (
              <div className="fm-custom-rows">
                <div className="fm-custom-cols" aria-hidden="true">
                  <span />
                  <span>{m.accountsCustomApiModelId()}</span>
                  <span>{m.accountsCustomApiContext()}</span>
                  <span>{m.accountsCustomApiOutput()}</span>
                  <span />
                </div>
                {models.map((model, index) => {
                  const dot = ROW_DOT[model.state ?? "none"];
                  const name = model.id.trim() || m.accountsCustomApiThisModelLower();
                  const stated = defined?.models.find((entry) => entry.id === model.id.trim());
                  return (
                    <div
                      className="fm-custom-row"
                      key={model.uiId}
                      data-custom-model-row={model.id.trim()}
                      data-state={model.state}
                    >
                      <span className="fm-custom-row-dot">
                        <StatusDot
                          tone={dot.tone}
                          label={m.accountsCustomApiRowState({ name, state: dot.label })}
                          focusable
                        />
                      </span>
                      <FormInput
                        id={`${id}-model-${index}`}
                        mono
                        spellCheck={false}
                        autoComplete="off"
                        aria-label={m.accountsCustomApiModelId()}
                        invalid={rowErrors[model.uiId]?.at === "id"}
                        disabled={locked}
                        value={model.id}
                        onChange={(event) => changeModel(model.uiId, { id: event.target.value })}
                      />
                      <FormInput
                        mono
                        inputMode="numeric"
                        aria-label={m.accountsCustomApiContextFor({ name })}
                        invalid={rowErrors[model.uiId]?.at === "sizes" && !model.context}
                        placeholder={m.accountsCustomApiContext()}
                        disabled={locked && Boolean(stated?.context)}
                        value={model.context ? String(model.context) : ""}
                        onChange={(event) =>
                          changeModel(model.uiId, { context: digits(event.target.value) })
                        }
                      />
                      <FormInput
                        mono
                        inputMode="numeric"
                        aria-label={m.accountsCustomApiOutputFor({ name })}
                        invalid={
                          rowErrors[model.uiId]?.at === "sizes" &&
                          (!model.output || model.output >= model.context)
                        }
                        placeholder={m.accountsCustomApiOutput()}
                        disabled={locked && Boolean(stated?.output)}
                        value={model.output ? String(model.output) : ""}
                        onChange={(event) =>
                          changeModel(model.uiId, { output: digits(event.target.value) })
                        }
                      />
                      {locked ? (
                        // Its cell stays, so the row keeps its columns.
                        <span />
                      ) : (
                        <IconButton
                          label={m.accountsCustomApiRemoveModel({ name })}
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
                      )}
                      <div className="fm-custom-capabilities">
                        <label className="fm-custom-field">
                          <span>{m.accountsCustomApiReasoning()}</span>
                          <select
                            aria-label={m.accountsCustomApiReasoningFor({ name })}
                            disabled={locked}
                            value={model.reasoningProfile ?? ""}
                            onChange={(event) =>
                              changeModel(model.uiId, {
                                reasoningProfile: event.target.value || undefined,
                                profileChosen: true,
                                cacheRetention: customDefaultCacheRetention(protocol),
                              })
                            }
                          >
                            <option value="">
                              {fileModelFacts(defined, model.id.trim()).statedReasoning
                                ? m.accountsCustomApiFileReasoning()
                                : m.accountsCustomApiReasoningOff()}
                            </option>
                            {profiles
                              .filter((profile) => profile.protocol === protocol)
                              .map((profile) => (
                                <option key={profile.id} value={profile.id}>
                                  {profile.label}
                                </option>
                              ))}
                            {model.reasoningProfile &&
                              !profiles.some(
                                (profile) => profile.id === model.reasoningProfile,
                              ) && (
                                <option value={model.reasoningProfile}>
                                  {model.reasoningProfile}
                                </option>
                              )}
                          </select>
                        </label>
                        <label className="fm-custom-field">
                          <span>{m.accountsCustomApiCache()}</span>
                          <select
                            aria-label={m.accountsCustomApiCacheFor({ name })}
                            disabled={locked}
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
                                    profiles.find(
                                      (profile) => profile.id === model.reasoningProfile,
                                    )?.cacheRetentions ?? customUnprofiledRetentions(protocol)
                                  ).includes(retention)
                                }
                              >
                                {retention === "none"
                                  ? m.accountsCustomApiCacheNone()
                                  : retention === "short"
                                    ? m.accountsCustomApiCacheShort()
                                    : m.accountsCustomApiCacheLong()}
                              </option>
                            ))}
                          </select>
                        </label>
                        <p className="fm-custom-hint">{m.accountsCustomApiCapabilityHint()}</p>
                        {profileFailure && (
                          <p role="alert" className="fm-custom-hint">
                            {m.accountsCustomApiProfilesFailed()}
                          </p>
                        )}
                      </div>
                      <fieldset className="fm-custom-body" disabled={locked}>
                        <CustomModelPrice
                          idPrefix={`${id}-model-${index}`}
                          name={model.name ?? ""}
                          prices={model.prices}
                          invalid={rowErrors[model.uiId]?.at === "price"}
                          onChange={(change) => describeModel(model.uiId, change)}
                        />
                      </fieldset>
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
              <p className="fm-custom-hint">{m.accountsCustomApiNoModels()}</p>
            )}
            {fieldError("models")}
            <div hidden={locked}>
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
                {m.accountsCustomApiAddByHand()}
              </button>
            </div>
          </div>
        </fieldset>
      </fieldset>
      {original && !sameAddress && (
        <p className="fm-custom-hint">{m.accountsCustomApiSeparate()}</p>
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
              {m.accountsCustomApiSavePaused()}
            </button>
          )}
        </div>
      )}
      {auth === "command" && (
        <div className="fm-custom-command-approval" data-custom-command-approval>
          <p className="fm-custom-hint">{m.accountsCustomApiCommandApproval()}</p>
          <pre>{command}</pre>
        </div>
      )}
      <div className="fm-custom-foot">
        <span className="fm-custom-hint" aria-live="polite">
          {footHint}
        </span>
        <Button variant="ghost" size="sm" onClick={cancel}>
          {m.accountsCustomApiCancel()}
        </Button>
        <Button
          variant="primary"
          size="sm"
          pending={busy === "save"}
          pendingLabel={m.accountsCustomApiCheckingPending()}
          disabled={busy !== ""}
          onClick={save}
        >
          {m.accountsCustomApiSave()}
        </Button>
      </div>
    </section>
  );
}

/** What the file states for a model beyond the form's own fields. */
function fileModelFacts(defined: CustomFileDefinition | undefined, modelId: string) {
  const stated = defined?.models.find((model) => model.id === modelId);
  return {
    ...(stated?.input ? { input: stated.input } : {}),
    ...(stated?.statedReasoning ? { statedReasoning: stated.statedReasoning } : {}),
    ...(stated?.compaction ? { compaction: stated.compaction } : {}),
  };
}

/** The same bounded, focus-contained aside at every entry point: first setup, Add and Edit. */
export function CustomApiDialog({
  children,
  label = m.accountsCustomApiDialogLabel(),
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
