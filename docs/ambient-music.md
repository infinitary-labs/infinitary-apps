# Ambient music

The desktop window can play calm music it composes itself, following the crew, in one of ten styles or a style of the person's own ("Your own styles" below).
It is the captain's choice from INF-4741: rules in the app, off until someone turns it on, and the desktop app only.
Nine styles are the ones the captain kept from INF-5056's prototypes, with Star cruise the default; the tenth, Cold sleep, is the piano style the captain kept from INF-4749's.
Nothing is downloaded and no recorded sample plays: every sound is an oscillator made on the computer, and nothing leaves it.

## Turning it on

Settings → Appearance has a Sound group: an Ambient music switch, off on a fresh install, a Style picker on Star cruise, and a Volume slider at 40%.
Both are part of the window's look (`ambientMusic` and `ambientVolume` in `src/shared/preferences.ts`), which the core keeps in a row of their own, `ambient-music`, so an older build never meets them (`src/core/storage/settingsStore.ts`).
The style is `ambientStyle`, kept in its own row, `ambient-style`, for the same reason; a style this build does not know, saved by a newer one, is kept and plays as Star cruise.
A Mac controlling another keeps its own, as it keeps the rest of its look (`docs/view.md`), and a view from before the change is never sent them (`src/shared/contract-changes/ambient-music.md`, `ambient-style.md`).
While enabled, a 32 px sound button appears 6 px before Settings on the main screen.
Press it to pause or resume; the pause survives a restart, and turning the switch off removes the button and clears the pause.
Rest the pointer on it or Tab to it for the shared volume slider, and use the left and right arrows to change volume by 5 percentage points.
The top bar drags the window, and on a Mac a pointer over a drag point leaves the page, so the open slider and the gap before it are marked `-webkit-app-region: no-drag` at the button's full height; once the slider closes, that strip drags the window again (`tests/e2e/dragRegions.ts` reads the regions by Electron's rule).
Play or pause ambient music (`ambient.toggle`, `docs/keyboard.md`) is ⌥⌘P, Ctrl+Alt+P on Linux and Windows, which the button's label shows; command search lists it too.
It turns the switch on if it was off, and otherwise pauses or resumes without turning the switch off.
The separate `ambient-paused` row leaves the enable and volume row readable by older builds.
On a Mac or a Windows PC the group's last row is a Pause when you're away switch, on until turned off ("When nobody is at the computer" below).
The first mate switches it, sets its volume or picks its style when asked, through its `ambient-music` setting, and turns Pause when you're away on or off through `ambient-away` (`src/shared/ambientActions.ts`), with no tool of its own.

## The styles

The picker lists them under the four kinds of journey they come from (`src/renderer/src/ambient/styles/`):

| Kind | Style | Sound |
| --- | --- | --- |
| Space | Star cruise | A soft repeating pattern echoing left and right over a slow low pulse; the default |
| Space | Deep drift | No drums: slow wide chords and high pings with long echoes |
| Space | Cold sleep | Mostly piano: a felt piano in a vast, cold room over a low drone; a slow heartbeat and a broken chord as the crew works, a high answer with three or more |
| Pirate | Quiet cove | A slow rocking rhythm: concertina, plucked lute, a whistle tune |
| Pirate | Tavern embers | A quiet minor-key waltz: plucked strings, accordion, a fiddle tune |
| Pirate | Moonlit deck | A low drone, a music box tune, a slow harp, a distant whistle |
| Nautical | Harbor dawn | Soft brass chords, a harp, a ship's bell struck in pairs, a distant bugle |
| Nautical | Fair winds | A shanty rhythm on guitar; a whistle calls and a concertina answers |
| Island | Wayfinder night | Humming voices, a thumb piano, a slow two-beat drum, a falling flute |
| Island | Island morning | The brightest: a marimba pattern, a lilting bass, a flute tune |

Picking another style while it plays fades the old one out and starts the new one from its first bar.
Every style was rendered one layer at a time and each layer's level set in dB, so all ten play as loud as each other.
The pirate, nautical and island styles play soft waves under the music, at 40% of the wave level the prototypes allowed.

## How it plays

`src/renderer/src/ambient/composer.ts` composes: pure, seeded and time-injected, like the notice pulse.
A style is data and one function (`Style` in `player.ts`): its tempo, key and scale, the chords and which may follow which, how loud each layer plays at each crew level, its voices, and a `compose` function that writes each bar's notes.
From a seed and the crew level the composer gives each bar's chord, the pad's notes, the layers' loudness and every note in beats, and the style's tunes repeat and vary short motifs, so a phrase comes back.
Each session starts from a new seed, so the music does not loop; one seed gives the same bars.
`src/renderer/src/ambient/player.ts` turns the bars into sound with Web Audio, about a second ahead, in any audio context, so the same code renders offline for a check; `instruments.ts` holds the instruments, each made of oscillators alone.
Its piano is three voices per note: a bright strike that fades first, and a pair of string tones a few cents apart, one falling fast and one ringing on, through a filter that closes as the note rings.
A style may tilt its whole mix darker or brighter above 1.4 kHz (`tilt`); Cold sleep is 6 dB darker, the tone the captain set.
The window plays it at 24 kHz, half the usual rate, which halves what it costs; the mix is cut at 11 kHz, so nothing it plays is lost.
A bar whose start already passed, after a stalled window or slowed timers, is skipped, leaving a short gap rather than starting its notes all at once.
`src/renderer/src/ambient/ambient.ts` follows the switch, the style and the volume and runs the player in the window, marking where it stands on the document as `data-ambient-music`: `off`, `paused`, `away`, `playing` or `hushed`, and `playing` or `hushed` only once its audio context runs; while its player runs, `data-ambient-style` names the style.

The mark reads four frequency bands from the music before the volume gain and measures each against its own quietest and loudest level of about the last 3.3 seconds, so every bar uses its full height.
It is the captain's Calm look from INF-5053: on the 24-unit icon a bar rests at 4 units and peaks at 16, rising slowly and falling more slowly, at the same height at any volume above zero, and still at zero.
It samples up to 30 times a second only while visible, holds still under reduced motion, dims while hushed and becomes four dots while paused.

The crew level is the number of crewmates working on every computer, read from the crew ring (`workingCrew` in `character/crew/crewSignal.ts`):

| Working | Level | What plays |
| --- | --- | --- |
| none | 0 | The style's pad, its main instrument and bass, unhurried, with no drums |
| one or two | 1 | The music warms; the style's soft drum comes in |
| three or more | 2 | The rest of its rhythm and its tune come in |

A layer's loudness ramps over about a bar when the level changes.
Two moments get a cue in the style's own instruments, heard from the character's own signals (`onCharacterCue` in `character/emoteSignal.ts`):

- A card landing unseen, the notice pulse's moment, plays the waiting chime on the next beat, at most once every two bars: three notes up the home chord, then a held note on the notice pulse's own curve (`noticeFrame`), spreading from the center to both sides.
- A task merging, the celebrate emote's moment, plays a rising run of sparks on the next beat and steers the next chords through the style's cadence home.

The shipped styles' only noise is the sea styles' waves: a dark wash, cut well below the treble.
They have no crackle or hiss, and every drum, tick and rim is made of tones alone.
A person's own style may also bring soft rain or wind, the captain's choice for INF-5541 ("Your own styles" below); nothing else plays noise.
Loudness is one fixed gain and a gentle compressor, never a step that lifts quiet parts.
Every note's nodes are disconnected when it ends, so memory stays flat however long it plays.

## Your own styles

It is INF-5541's approved plan: a person describes the music they want, and the first mate writes it as a style for the app's own instruments.
Asked "play lofi beats to code to", the first mate saves a new style and plays it in the same reply; asked "make it slower", it saves the same style again under its name, and the music starts again from its first bar.
The first mate does it through its `ambient-own-style` setting (`src/shared/ambientActions.ts`), whose line teaches what the instruments can make: tones, the sea's waves, soft rain and wind, and never voices singing words, recorded instruments or sounds such as birds, so asked for those it says so and offers the nearest it can play.
No code judges the person's words; the line is the whole of that teaching.

A style is settings, never code: `ownStyleSchema` in `src/shared/ambientOwn.ts` holds every value to a range, and `ownStyleFaults` checks what a range cannot, such as a part playing a voice the style never defines, a step past the bar, a preset its instrument lacks, or more than 96 notes a bar.
A faulty style is refused with each fault in words the first mate can act on, and nothing is saved.
A style may start from a shipped one (`like`) and change only what the words name, such as its tempo, key or the loudness of a layer; or it writes every field: its chords and which may follow which, its hands' range, its pad, its room, its voices from the app's own instruments and their named presets, its three crew levels, its cue, and its parts.
Each part kind is one fixed way of writing a bar's notes (`src/renderer/src/ambient/own.ts`): a held note, steps on the grid, a pattern over the chord, a strum, random pings, or a tune of repeating motifs, each with a condition on the crew level, a layer, the bar or chance.
Every style keeps the waiting chime and the merge sparks, so a style that defines its own voices must define `chime` and `spark` on the cue bus.

The app sets the loudness, never the model (`src/renderer/src/ambient/balance.ts`).
The first time a style plays in a session, the window renders it silently, faster than it plays: each layer alone at the crew level where it plays loudest, moved to that layer's median across the shipped styles, and then the whole mix at level 1 moved to theirs and lowered if its loudest moment at level 2 would pass -1 dB.
A style that brings no voices of its own keeps the shipped style's layers and has only its whole mix measured.
The meter is the broadcast standard's (ITU-R BS.1770, `loudness.ts`), so each crew level plays within about 1 LUFS of the shipped medians, -18.1, -16.8 and -16.0.
The measurement takes one to nine seconds in the window, and the music starts once it ends; a style that cannot be read or measured plays Star cruise.
The person's own `mix` tilts a layer louder or quieter on top of the balance, and -60 silences it.

Rain is a dark, pink hush with many faint, rounded drops, some ringing as they land in water, kept between 250 Hz and 4.2 kHz, and wind a band of noise whose pitch and loudness drift in slow gusts (`player.ts`).
At its fullest each reads about -32.5 LUFS alone, 2 dB above the sea's waves, and the style sets how much of it plays.

The styles are `ambientOwnStyles` in the look, at most 12, kept in a row of their own, `ambient-own-styles`, so an older build never meets them, and a view from before the change is never sent them (`src/shared/contract-changes/ambient-own-styles.md`).
Each has an id made from its name, `own-` and a few lowercase words, which `ambientStyle` names while it plays.
Settings lists them under Yours in the Style picker, with the person's own words as the chosen style's description.
The Your own music row below it has Describe your own, which goes home and starts the ask to the first mate in the message box, and Remove while a style of the person's own is chosen, which deletes it and plays Star cruise.

## When it goes quiet

It fades to silence over 20 ms, so it is silent within 150 ms even with the audio's own delay through the window, while voice input listens, since the microphone would hear it, and while a card's sound clip or a demo recording with sound plays (`useCardSound`'s `playing` and `demo`), and comes back over about a second after.
It keeps playing while the window is hidden, and stops when the window closes or the app quits.
It does not take the keyboard's media keys or show in the system's Now Playing.

## When nobody is at the computer

It is INF-5528's answer and the captain's choice: by default the music stops while nobody is at the computer and starts again once someone is back, and turning off the Pause when you're away switch in Settings → Appearance keeps it playing instead.
Nobody is there while the screen is off or locked, the screen saver runs, or another person's session is in front; someone is back only once every one of those ended, so on a computer that asks for a password the music comes back at the unlock, not when the screen wakes.
`src/main/presence.ts` hears it in the main process and tells the window over `inf:window:presence`, `{ away, watched }`; `src/main/presenceWatch.ts` combines the reasons.

| Computer | What the app hears |
| --- | --- |
| Mac | the screens sleeping and waking (`NSWorkspaceScreensDidSleepNotification`, `NSWorkspaceScreensDidWakeNotification`), the lock and unlock, the screen saver starting and stopping (`com.apple.screensaver.didstart`, `didstop`, not in Apple's documents) and another session taking the screen (`user-did-resign-active`, `user-did-become-active`) |
| Windows | the lock and unlock, and the display's own state, which Windows tells only a window that asked: `RegisterPowerSettingNotification` with `GUID_SESSION_DISPLAY_STATUS` through koffi, read in `WM_POWERBROADCAST` (`src/main/windowsDisplay.ts`); a dimmed display still counts as on, and the screen saver has no event of its own |
| Linux | nothing: Electron hears no lock or screen there, so `watched` is false, the music never stops for this and Settings does not offer the switch |

While nobody is there it ends its player as the pause button does, closing its audio context, and starts a new one on the way back, from a new seed.
A hush would not do: a silent player still keeps the computer from sleeping on its own, and a closed audio context lets it go, so a computer set to sleep when idle sleeps by its own setting once nobody is there.
This pause is never saved: the `ambient-paused` row stays the pause button's alone.
Keep playing is `ambientPlaysWhenAway` in the look, in a row of its own, `ambient-away-plays`, kept only while on, and a view from before the change is never sent it (`src/shared/contract-changes/ambient-away.md`).
