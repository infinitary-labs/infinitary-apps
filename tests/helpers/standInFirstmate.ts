import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellWord } from "../../src/core/devices/joinCommand";
import { RETIRED_PROFILE_MARKER } from "../../src/core/storage/retiredProfile";
import {
  type BackgroundState,
  type WorkOutcome,
  workOutcomeLine,
} from "../../src/shared/remoteLogin";
import { scratchDir } from "./scratchDirs";

/**
 * A stand-in Firstmate bundle, for the home adding a Mac by its address
 * over Remote Login (docs/devices.md, "Adding a computer by its address"). Its
 * program does at the wire what the work mode does when the home starts it:
 * `work join --fetched <app> --from-home` reads the join's message from its
 * input - the link, and the private socket the home's SSH session forwards
 * there - and uses the link through that socket as a computer that runs
 * work, under `uid`, with a key of its own and the Mac's own curl and
 * openssl; `work update` and `work remove` answer as the work mode does, and
 * `work connect` speaks the controller's side of the home's SSH connection
 * (`src/shared/sshConnection.ts`) - its socket, then its route once the
 * forward is in place, each beat written down - without keeping a route
 * itself, or hands it to the built app (`connect`); `agent` is what it says
 * of the work there. Every
 * start, and the bundle's marker, is written
 * down in `record`, and so are the arguments curl was started with, through
 * a stand-in curl in the bundle that hands them to the Mac's own; the
 * pairing code goes to curl on its input, never in those arguments, as the
 * work mode's join does. `background` is what it answers of the background:
 * by default a join starts at the next login and an update runs at once;
 * `removed` what a removal answers, by default all of it removed.
 *
 * Joined, it keeps its grant where the work mode keeps it, in
 * `$INFINITARY_HELPER_DATA_DIR/home.json`, with its key beside it, so a later
 * link from that same home finds the home again with the key it was paired
 * with, as the work mode does (docs/helper.md, "Finding the home again"),
 * and one the home removed since joins anew. The real work mode is
 * `tests/e2e/run-work.spec.ts`.
 */
export function standInFirstmate(
  record: string,
  uid: number,
  background: {
    joined: BackgroundState;
    updated: BackgroundState;
    removed?: WorkOutcome;
    agent?: string;
    /**
     * The other Firstmate a user that runs its work already still answers,
     * so a join told to leave it refuses (`joined`), as the work mode does.
     */
    otherAnswers?: boolean;
    /**
     * The program `work connect` hands itself to, with its own words: the
     * built app, so the controller there is the real one; absent, the
     * stand-in speaks the controller's side itself.
     */
    connect?: string;
  } = {
    joined: "at-login",
    updated: "running",
  },
): string {
  // On Linux the copy is one AppImage file, which carries its marker and
  // its stand-in curl inside itself; on a Mac it is a bundle beside them.
  const linux = process.platform === "linux";
  const bundle = join(scratchDir("infinitary-remote-app-"), STAND_IN_APP);
  const curlLines = [`printf "curl: %s\\n" "$*" >> ${shellWord(record)}`, '/usr/bin/curl "$@"'];
  if (!linux) {
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(bundle, "Contents", "Resources", "marker"), "the home's own copy\n");
    const curl = join(bundle, "Contents", "Resources", "curl");
    writeFileSync(curl, ["#!/bin/sh", curlLines[0], `exec ${curlLines[1]}`, ""].join("\n"));
    chmodSync(curl, 0o755);
  }
  const program = linux ? bundle : standInProgram(bundle);
  writeFileSync(
    program,
    [
      "#!/bin/sh",
      ...(linux ? ["# marker: the home's own copy"] : []),
      `R=${shellWord(record)}`,
      'printf "started: %s\\n" "$*" >> "$R"',
      linux
        ? '[ "$3" = --fetched ] && sed -n \'s/^# marker: //p\' "$4" >> "$R"'
        : '[ "$3" = --fetched ] && cat "$4/Contents/Resources/marker" >> "$R"',
      // The curl that writes down how it was started, then hands its words to the system's own.
      linux
        ? `stand_in_curl() { ${curlLines.join("; ")}; }; CURL=stand_in_curl`
        : 'CURL="$(dirname "$0")/../Resources/curl"',
      `if [ "$2" = update ]; then echo '{"firstmate":"updated","background":"${background.updated}"}'; exit 0; fi`,
      `if [ "$2" = remove ]; then echo ${shellWord(workOutcomeLine(background.removed ?? { firstmate: "removed", kept: [] }))}; exit 0; fi`,
      ...(background.connect
        ? [`if [ "$2" = connect ]; then exec ${shellWord(background.connect)} "$@"; fi`]
        : []),
      // The far end of the home's SSH connection: its socket, then its route once forwarded.
      'if [ "$2" = connect ]; then',
      '  S="$(mktemp -d /tmp/infinitary-r-XXXXXX)" || exit 3',
      '  trap \'rm -rf "$S"; echo "connect ended" >> "$R"\' EXIT',
      '  printf \'{"firstmate":"socket","v":1,"socket":"%s"}\\n\' "$S/s"',
      "  while IFS= read -r M; do",
      '    case "$M" in',
      `      *'"forwarded"'*) echo "forwarded $S/s" >> "$R"; printf '{"firstmate":"route","v":1,"agent":"%s"}\\n' ${shellWord(background.agent ?? "running")};;`,
      // Its folder retired - moved into a newer app's - it says so and ends, as the real controller does.
      `      *'"beat"'*) echo "beat" >> "$R"; if [ -f "$(dirname "$INFINITARY_HELPER_DATA_DIR")/${RETIRED_PROFILE_MARKER}" ]; then printf '{"firstmate":"refused","reason":"moved"}\\n'; exit 0; fi;;`,
      "    esac",
      "  done",
      "  exit 0",
      "fi",
      // The join's message: the link, and the socket the home forwards for it.
      "IFS= read -r M",
      String.raw`L="$(printf '%s' "$M" | sed -n 's/.*"link":"\([^"]*\)".*/\1/p')"`,
      String.raw`SOCK="$(printf '%s' "$M" | sed -n 's/.*"socket":"\([^"]*\)".*/\1/p')"`,
      'case "$L" in infinitary://* | firstmate3000://*) echo "link on its input" >> "$R";; esac',
      '[ -n "$SOCK" ] && echo "socket on its input" >> "$R"',
      "Q=\"$(printf '%s' \"$L\" | sed 's/^[^?]*?//')\"",
      "get() { printf '%s' \"$Q\" | tr '&' '\\n' | sed -n \"s/^$1=//p\"; }",
      'AT="$(get at | sed "s/%3A/:/g")"; KEY="$(get key)"; CODE="$(get code)"; VIA="$(get via)"; AS="$(get as)"',
      // The code it was given, so a test can look for it where it must never be.
      'echo "code: $CODE" >> "$R"',
      "PIN=\"sha256//$(printf '%s=' \"$KEY\" | tr '_-' '/+')\"",
      'D="$(mktemp -d)"',
      // Where the work mode keeps its grant: a link from the home it names
      // finds that home again with the key it was paired with.
      'W="$INFINITARY_HELPER_DATA_DIR"',
      'AGAIN=""',
      String.raw`if [ -n "$W" ] && [ -f "$W/stand-in/k" ] && grep -q "\"homeKey\": \"$KEY\"" "$W/home.json" 2>/dev/null; then AGAIN=yes; echo "again" >> "$R"; fi`,
      // Another home's: it stays unless the home's captain agreed to leave
      // it and it does not answer; leaving keeps one working copy, as the
      // work mode keeps one holding unmerged work.
      'LEFT=""',
      `case "$M" in *'"leave":true'*) LEAVE=yes; echo "leave on its input" >> "$R";; *) LEAVE="";; esac`,
      'if [ -z "$AGAIN" ] && [ -n "$W" ] && [ -f "$W/home.json" ]; then',
      `  if [ -z "$LEAVE" ] || [ -n ${shellWord(background.otherAnswers ? "yes" : "")} ]; then rm -rf "$D"; echo '{"firstmate":"refused","reason":"joined"}'; exit 1; fi`,
      '  rm -rf "$W/stand-in" "$W/home.json"; echo "left the other home" >> "$R"',
      `  LEFT=',"left":{"kept":1,"unremoved":0}'`,
      "fi",
      "pair() {",
      '  if [ -n "$AGAIN" ]; then K="$W/stand-in/k"; C="$W/stand-in/c"; A=",\\"again\\":true"; else',
      '    /usr/bin/openssl ecparam -name prime256v1 -genkey -noout -out "$D/k0" 2>/dev/null',
      '    /usr/bin/openssl pkcs8 -topk8 -nocrypt -in "$D/k0" -out "$D/k" 2>/dev/null',
      '    /usr/bin/openssl req -new -x509 -key "$D/k" -out "$D/c" -subj /CN=device -days 1 2>/dev/null',
      '    K="$D/k"; C="$D/c"; A=""',
      "  fi",
      `  BODY="{\\"code\\":\\"$CODE\\",\\"kind\\":\\"$AS\\",\\"name\\":\\"Mac mini\\",\\"user\\":{\\"name\\":\\"sam\\",\\"uid\\":${uid}},\\"found\\":{\\"git\\":true,\\"claudeCode\\":true}$A}"`,
      // printf is the shell's own, so the body with its code reaches curl on its input alone.
      // Through the socket alone when the home sent one, as the work mode dials it.
      '  if [ -n "$SOCK" ]; then THROUGH="--unix-socket $SOCK"; else THROUGH=""; fi',
      '  S="$(printf \'%s\' "$BODY" | "$CURL" -sS -k $THROUGH --pinnedpubkey "$PIN" --cert "$C" --key "$K" -o "$D/a" -w \'%{http_code}\' -H \'Content-Type: application/json\' --data-binary @- "https://$AT/pair" 2>/dev/null)"',
      "}",
      "pair",
      // Removed while out of reach: it lets that home go, then joins anew with the same link.
      `if [ -n "$AGAIN" ] && [ "$S" = 410 ] && grep -q '"removed"' "$D/a"; then rm -rf "$W/stand-in" "$W/home.json"; echo "removed earlier" >> "$R"; AGAIN=""; pair; fi`,
      'if [ "$S" = 201 ]; then',
      String.raw`  ID="$(sed -n 's/.*"deviceId":"\([^"]*\)".*/\1/p' "$D/a")"`,
      // The kind the home answered: a Mac, or another user on its own Mac.
      String.raw`  KIND="$(sed -n 's/.*"kind":"\([^"]*\)".*/\1/p' "$D/a")"`,
      '  if [ -n "$W" ]; then',
      '    mkdir -p "$W/stand-in"',
      '    [ -n "$AGAIN" ] || { cp "$D/k" "$W/stand-in/k"; cp "$D/c" "$W/stand-in/c"; }',
      // The copy it was started from is kept, as the work mode keeps it, for the home's controller.
      '    [ "$3" = --fetched ] && { mkdir -p "$W/app"; rm -rf "$W/app/$(basename "$4")"; cp -R "$4" "$W/app/"; }',
      // The grant as the work mode keeps it (`JoinedHome`), dialing where the link says.
      String.raw`    esc() { awk 'BEGIN{ORS=""} {print $0 "\\n"}' "$1"; }`,
      'if [ "$VIA" = ssh ]; then V=\',\n    "via": "ssh"\'; else V=""; fi',
      String.raw`    printf '{\n  "version": 1,\n  "grant": {\n    "at": "%s",\n    "homeKey": "%s",\n    "deviceId": "%s",\n    "kind": "%s",\n    "key": "%s",\n    "cert": "%s"%s\n  },\n  "name": null,\n  "joinedAt": 0\n}\n' "$AT" "$KEY" "$ID" "$KIND" "$(esc "$W/stand-in/k")" "$(esc "$W/stand-in/c")" "$V" > "$W/home.json"`,
      "  fi",
      `  rm -rf "$D"; echo '{"firstmate":"joined","background":"${background.joined}"'"$LEFT"'}'; exit 0`,
      "fi",
      'WHY="$(sed -n \'s/.*"refused":"\\([a-z-]*\\)".*/\\1/p\' "$D/a" 2>/dev/null)"',
      'rm -rf "$D"',
      '[ -n "$WHY" ] || WHY=unreachable',
      'echo "{\\"firstmate\\":\\"refused\\",\\"reason\\":\\"$WHY\\"}"',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(program, 0o755);
  return bundle;
}

/**
 * The stand-in's own name, as a copy of Firstmate is named on this system:
 * a Mac's bundle, or the AppImage a Linux computer keeps
 * (src/core/devices/farSystems.ts).
 */
export const STAND_IN_APP = process.platform === "linux" ? "infinitary.AppImage" : "Infinitary.app";

/** The stand-in's own program: inside a Mac's bundle, or the AppImage itself on Linux. */
export function standInProgram(app: string): string {
  return process.platform === "linux" ? app : join(app, "Contents", "MacOS", "Infinitary");
}

/**
 * Bytes that do not compress, added to the stand-in so its copy is about as
 * big as they are: in the bundle's resources on a Mac, and after the
 * AppImage's last line on Linux, where its shell never reads them.
 */
export function addStandInPayload(app: string, bytes: Buffer): void {
  if (process.platform === "linux") appendFileSync(app, bytes);
  else writeFileSync(join(app, "Contents", "Resources", "payload"), bytes);
}

/** What the stand-in wrote down: the pairing code it was given, and every curl start's arguments. */
export function standInRecord(record: string): { code: string; curl: string[] } {
  const text = readFileSync(record, "utf8");
  return {
    code: /^code: (\S+)$/m.exec(text)?.[1] ?? "",
    curl: [...text.matchAll(/^curl: (.*)$/gm)].map((match) => match[1] ?? ""),
  };
}
