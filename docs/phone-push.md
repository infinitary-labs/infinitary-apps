# Card pushes to a phone

How a paired iPhone or iPad hears a card while Infinitary is closed there: the computer seals each card for that phone alone and posts it to Infinitary's relay, which wakes the phone through Apple's push service.
Only Apple's push service wakes a closed iPhone app, and Apple takes a push for Infinitary only from whoever holds Infinitary's push key, which never ships inside the desktop app.
So the relay holds the key and forwards bytes it cannot read; only the phone's own key opens them.
This page is the computer's half and the shapes the phone and the relay build on (`src/shared/phonePush.ts`); the phone's half is `docs/ios.md`, "Card pushes".

## What the phone hands its computer

A paired phone asks `inf:devices:push` (contract change `phone-push`) with its registration, or null to stop:

| Field | What it is |
| --- | --- |
| `token` | The phone's push address from Apple, in lowercase hexadecimal. |
| `environment` | `production` for TestFlight and App Store builds, or `development` for builds signed for development, which Apple serves from its sandbox. |
| `grant` | The relay's grant for that address and environment: its expiry, a dot and its signature. The computer only passes it on. |
| `key` | The phone's sealing key: 32 random bytes in base64url, for AES-256-GCM. |
| `withdrawals` | Optional, `true` when the phone removes the notifications a withdrawal names ("Withdrawals" below, contract change `phone-push-withdraw`). The phone sends it only to a computer that lists that change, since an older computer refuses a registration with a field it does not know. |

The phone gets its grant by asking the relay's `POST /v1/register` with its token and environment: the relay answers 202 and sends the grant to that push address as a background push, never in the answer, so only the phone that owns the address can hand it to a computer.
Each registration costs the phone one of Apple's background pushes, which Apple keeps to a few an hour, so the phone registers only when it holds no unexpired grant for its current push address and environment, when its grant nears its 30-day expiry, or when its computer answers that it did not keep the grant.
It hands the registration it holds on each welcome, which costs nothing.

The computer answers `{ "kept": true }` when it keeps the registration, and `{ "kept": false }` for null or for a grant the relay already refused this run (a 410 or a 403 below): then the phone registers anew and hands the new grant.
The refused grant is remembered only while the computer runs; after a restart it is kept again, the relay refuses it at the next card, and the phone hears `kept: false` at its next welcome.
The token and grant take the relay's own shapes, so the computer refuses a registration the relay would refuse.

A phone withdraws by handing null: the computer forgets its push address, grant and key, answers `{ "kept": false }`, and sends it nothing more until it hands a registration again.
The phone does this whenever notifications for Infinitary are off in its own Settings, checked each time Infinitary opens there, so a phone that turned them off stops its computer sending at its next open rather than only hiding what arrives.
It hands null on each welcome from its computer while they are off, as it hands its registration on each welcome while they are on, so a phone that opens away from its computer's network still stops it sending as soon as it next connects.

The dispatcher answers it only for the paired phone that asks, named by its connection (`answerPhoneAsk`, `src/core/phoneAsks.ts`): the computer's own window, the local door and a paired Mac are refused.
A computer without the change does not list `phone-push` in its welcome, so a phone asks nothing of it and says that computer needs an update.

## Where it is kept

`DevicePairing` keeps each phone's registration through `PairingPushRecords` (`src/core/devices/pairingPushRecords.ts`) in `devices/pushes.json`, `{ "version": 1, "devices": { "<device id>": { "token", "environment", "grant", "key", "at" } } }`, beside the device list, so a list an older app reads is still the list it knows (`docs/devices.md`, "The saved list").
Which phones take withdrawals is kept in `devices/push-withdrawals.json`, `{ "version": 1, "devices": { "<device id>": <when that registration was handed> } }`, a file of its own: an older app reads `pushes.json` strictly and would read a new field there as a file it cannot read, pushing to no phone.
It is set by each registration and dropped with it: a registration without the flag, null, the relay's refusal and the device's removal.
It is forgotten with the device: Remove, the phone's Leave, and a removal once the device is back all drop it.
A home move carries it with the list (`RECORD_ROOTS`, `src/core/homeMove/record.ts`), so a phone keeps its pushes when the first mate moves to another computer.
A `pushes.json` that cannot be read is never written over, and nothing is pushed until it can be; a `push-withdrawals.json` that cannot be read is never written over either, and no withdrawal goes until it can be.

## When the computer sends

A second `CardNotifier` (`src/core/notifications.ts`) sits beside the Mac's own on the same `inf:cards` broadcast seam (`cardNotifiers`, `src/core/phonePush.ts`), so a phone hears exactly the moments the Mac's notifications show: a new card on the stage, or a card whose author answered the captain's reply.
A body revision, an ended card and the cards found at start are not news.

- It sends only while the Notifications switch (Settings → General) is on.
- It sends nothing while a window of this computer is in front, as the Mac's own notifications stay quiet then.
- It sends nothing while a window in a program of its own says it is in front: the window opened beside a first mate a command started (`docs/run.md`, "The window opened beside it"), or a view on another Mac.
  Such a window asks `inf:window:front` with true when it comes to the front and false when it leaves it, on its own connection, and says it again at each welcome while it is in front.
  The first mate keeps each connection's latest word and forgets it when that connection drops (`WindowsInFront`, `src/core/windowsInFront.ts`), so a window closed or ended while in front never holds the phone quiet.
  A view does not ask a first mate that does not list the request (`window-front`, `src/shared/contract-changes/`), and that first mate's phone hears every card as before.
- It does not read whether this computer can show notifications itself, so a computer with no window, or one on Linux or Windows, still sends.
- It sends to every phone that handed a registration; with none it does nothing.

The phone shows nothing for a push while Infinitary is open, in front and in reach of its computer, and its in-app notice shows the card instead; away from its computer the push shows, and a computer the phone forgot may still show notifications while Infinitary is closed, reading only "A card is ready" (`docs/ios.md`, "Card pushes").

## What is sealed

The sealed text is the JSON `{ "v": 1, "kind": "card" | "reply", "cardId", "title", "body" }` (`phonePushCardSchema`), holding the same words the Mac's own notification shows, which `CardNotifier` writes in three parts (INF-5030's plan, arrangement A; the design skill's vocabulary page, "A notification's words"):

- The title is the ask line: what the card asks, then " · " and the project of the card's task when it has one, cut at 200 characters.
  The ask comes from typed facts alone: Ready to merge for a card with a merge button, Merges on its own for the story note of a task that merges by itself, Reply for an author's answer to the captain's reply, and otherwise the card's kind chip, Decision, Attention or Note.
- The body's first line names the work: for a card that shows its task's saved change story, whose title is a story revision's, the task's title; for every other card, its own title.
- After a line break, the body says what the card does: on a body with the completion headings, the first prose under What changed; on a reply, the author's newest thread message since the captain's reply; otherwise the body's first prose, found by its structure, never a heading, a drawing, a table, a folded section, a form control or the app's own facts strip, follow-ups or merge line.

The body is cut only at a whole word, with an ellipsis, at 600 characters (`NOTICE_BODY_LIMIT`): with a 200-character title of three-byte characters and a long card id, the relay's payload to Apple stays inside Apple's 4,096 bytes.
The phone and the Mac shorten what they draw themselves.
A view of another Mac reads no task record, so its notifications show the card's own title and no project.
`kind` says New card or Reply, and `cardId` is the card a tap opens.
The computer seals it with AES-256-GCM under the phone's key and a random 12-byte nonce, and sends base64url of the nonce, then the ciphertext, then the 16-byte tag.
The phone opens it in its notification part and shows the title and the body as they are; a push it cannot open keeps the relay's own words, "A card is ready".

## What the relay receives

The computer posts `{ "token", "environment", "grant", "sealed" }` as JSON to `PHONE_PUSH_RELAY` (`https://push.getinfinitary.com/v1/push`), with redirects refused and ten seconds to answer (`PhonePushes`, `src/core/phonePush.ts`).
The relay reads no card's words and no key: it checks the grant names that push address and environment and has not expired, and sends the sealed text to Apple as an alert the phone opens.
The relay's own contract is its project's push relay page; the answers mean:

- 204: Apple took the push.
- 410: Apple no longer takes that push address.
  403: the grant expired or does not name it.
  Either way the computer forgets the registration, unless the phone handed a new grant since, and the phone hands a new one at its next welcome.
- 429: over the relay's per-minute limit, or Apple asked it to slow down.
  That phone hears no push for a minute.
- 503: the relay holds no Apple key yet.
  No phone hears a push for a minute.
- 502: Apple refused the relay or could not be reached.
  413 or any other answer, or no answer: nothing more is done for that card.

Every answer but a 2xx, a 410 and a 403 is one log line naming the status, and no answer one line naming the error's kind, never a card's words.
Nothing is tried again and a card skipped while waiting is not sent later, since Apple keeps only the newest push for an app and the card stays on the stage for when the phone opens.

## Withdrawals

A notification for a card the captain has since seen, answered or closed is withdrawn from a phone that takes withdrawals (INF-5209's plan, piece 3), so the phone removes it while Infinitary is in the background there.
`PhonePushes` remembers which cards it pushed to each such phone, in memory only for this run, and reads each cards broadcast beside the notifiers (`PhonePushes.observe`).
A pushed card is withdrawn once its newest version was seen anywhere (`currentUpdateSeen`), or once it left the stage: gone, ended, or waiting on its author's answer to the captain's reply.
The record does not say which window or device saw a card, so a card seen on the phone itself or in a view of another Mac is withdrawn too.
A card seen before the relay answered its push is withdrawn once the relay takes it, against the newest cards broadcast; a push whose card was seen or left the stage while the relay had not answered is withdrawn alone once it does, even if a newer update of the card now waits unread; and only while the phone keeps the push address and key that push went to; a phone that hands the same ones again still shows it, while a new address or key forgets the pushes sent to the old ones.
Each card push carries its own random name (`push`), never given to another push, which the phone's notification part keeps with its notification (`PhonePushSeal.userInfo`), and a withdrawal names, for each card, every push of it the relay took, whichever answer came first.
The phone removes only notifications of the pushes named, so a card pushed again, as its author's answer, keeps its new notification even when Apple delivers it before an older, slower withdrawal, and a notification that names no push, from a computer without this change, is never withdrawn.

One withdrawal names every card withdrawn to the phone's push address and key, newest first, as many as fit Apple's 4,096-byte payload once the relay wraps it (`fittingWithdrawal`), because iOS keeps only the newest silent push for an app.
It names first the pushes no withdrawal named yet, then those that went before, each newest first, so a card's long history never crowds out a push still to go; a push still to go that does not fit goes in the next withdrawal, a spacing later, while history that does not fit is dropped.
A phone handing the same address and key again keeps its list and any withdrawal waiting for its spacing: a push the phone already removed on reaching its computer matches nothing there.
The first withdrawal to a phone goes at once, and a later one goes `WITHDRAW_SPACING_MS` (20 minutes) after the one before, so a phone hears at most three an hour, as Apple asks of background pushes; a card withdrawn meanwhile waits for that one.
Withdrawals go while a window is in front, since that is where the captain sees the cards, but only while the Notifications switch is on and only to a phone whose registration set `withdrawals`; one held while the switch was off goes when it is turned on (`PhonePushes.switched`).
Which phones set the flag is kept in `push-withdrawals.json`, apart from `pushes.json`; a write of it that fails is one log line and never stops the registration or removal it rides on; a phone that stops taking withdrawals stops at once and the file is written again with the next change or hand-over, while one that starts takes them only once the file is saved; the file names the stamp of the registration that asked, each registration's stamp later than any handed or saved before even when the clock repeats or goes back, so a flag whose later registration came without it is not taken up after a restart.

The sealed text is the JSON `{ "v": 1, "kind": "withdraw", "cards": [{ "cardId", "pushes": [...] }, ...] }` (`phonePushWithdrawalSchema`), sealed as a card push is (`sealWithdrawal`).
The computer posts `{ "token", "environment", "grant", "sealed" }` to the relay's withdraw request beside `PHONE_PUSH_RELAY` (`https://push.getinfinitary.com/v1/withdraw`, `phoneWithdrawRelay`), which checks the grant as for a card push and sends Apple a background push with `content-available` and the sealed text, at the lowest priority and with expiration 0, so Apple never stores it for an offline phone in place of a card push it holds.
The relay's answers mean what they mean for a card push: a 410 or a 403 forgets the registration, a 429 holds that phone's withdrawals and card pushes a minute and a 503 every phone's, and any other answer is one log line.
A relay without the withdraw request answers 404, which is one log line; card pushes go on as before.

The phone's `PhoneAppDelegate` takes the silent push, opens it with the key it holds (`PhonePush.withdrawal`) and removes the delivered notifications whose card and push the withdrawal names (`PhonePushSeal.shown`, `PhonePushes.withdrawArrived`); the notification part never sees it, since it shows nothing.
Apple does not promise to deliver a silent push, and delivers none to an app the person swiped away, so removal is best effort; the phone also removes notifications for cards no longer on the stage or already seen once it reaches its computer (`docs/ios.md`, "Card pushes").

[Infinitary’s privacy policy](https://getinfinitary.com/privacy) describes what the relay receives; `docs/sharing.md` explains the app’s controls.

A development or end-to-end run may post to a stand-in instead with `INFINITARY_PUSH_RELAY_URL` (`src/core/standIns.ts`); a packaged app reads no stand-in.

## Tests

- `src/core/phonePush.test.ts`: each phone's post carries only its grant, its push address and the card sealed under its own key, which only that key opens; a long title is cut and a reply stays a reply, and the largest notice fits Apple's payload; a 410 or a 403 forgets the registration and a refused grant handed again is not kept; a 429 holds that phone back a minute and a 503 every phone; a refused or unreachable relay is one line with no card words.
  Its withdrawals: a pushed card seen, answered, ended or gone is withdrawn only from the phone that set the flag, sealed for it alone and newest first, never an unseen card; withdrawals go at most three an hour, none while the switch is off, and a held one goes when it is turned on; a card seen before the relay took its push is withdrawn once it does, unless the phone handed a new address or key meanwhile, and only that push when a newer update of the card waits unread; each names every push of a card the relay took, whichever answer came first; a card's newer push stays off the list, the same address and key handed again keep the list and a waiting withdrawal, and a new address or key forgets the pushes sent to the old one; a long list keeps its newest cards that fit Apple's payload, a card pushed too often names its newest pushes that fit and the rest in later withdrawals, and pushes still to go come before a card's long history; the relay's 410 and 403 forget the registration; and a 429 holds only that phone and a 503 every phone for the relay's minute, while other phones' withdrawals and card pushes go on, and an older relay's 404 is one line.
- `src/core/notifications.test.ts`: a card that arrives is `card`, one that returns with its author's answer is `reply`; over real card bodies (a merge card the host drew from a saved story, a story note behind the app's merge line, a crewmate's question, a note that opens with a heading and a drawing, and a reply with a thread answer) each notice reads its ask line, its name and its gist, a merge card's with no heading Why and no pull request title, and a long body is cut at a whole word.
- `src/core/devices/pairing.test.ts`, "keeps where a phone's cards are pushed beside its entry": only a phone keeps one, it survives a restart outside the list an older app reads, null and Remove forget it, and the relay's refusal forgets only the grant it was sent with, which is not kept when handed again.
  Whether a phone takes withdrawals is kept in a file an older app never reads and forgotten with the registration, and a write of it that fails leaves the registration and a removal finished and is tried again on the next hand-over; a flag left by a lost write after a registration without it is not taken up after a restart, even when both were handed within the same millisecond.
  "keeps whether a phone takes withdrawals in a file an older app never reads": `pushes.json` keeps the shape an older app reads, the flag survives a restart, and a registration without it, null and the relay's refusal drop it.
- `src/core/core.connection.test.ts`, "a phone's cards reach it sealed through the push relay": over the real core and connection, with a stand-in phone and relay, only the phone hands its registration, each new card reaches the relay sealed while the switch is on and no window is in front, none reaches it while a window in another program or a view on another Mac says it is in front, the next does once that window leaves the front or its connection drops, and Leave, Remove, the phone's withdrawal and a 410 each stop its pushes; a card pushed to a phone that asked for withdrawals and then marked seen in a view is withdrawn from that phone alone, naming only that card.
- `src/main/shell.beside.test.ts` and `src/main/view/viewBackend.test.ts`: the window beside a command's first mate and a view on another Mac say when they are in front and when they leave, and say it again at each welcome while in front; a view never asks a first mate that does not list the request.
- `InfinitaryKit/Tests/InfinitaryKitTests/PhonePushTests.swift`: the phone opens what `sealCardPush` and `sealWithdrawal` sealed for it (`Fixtures/PhonePush.json`) and nothing sealed for another key, a withdrawal removes only the notifications it names, the registration says it takes withdrawals only to a computer that lists `phone-push-withdraw`, a tap finds its card after In reach, on the stack or in Past, a push shows in front only away from its computer, forgetting a computer gives up the address, makes a new key and removes its notifications, asks the relay only when no grant lasts for its address and service, hands its registration on every welcome and open, asks again after `kept: false`, and hands null while notifications are off.
- The phone check's push part (`PhoneJourney+Push.swift`): over the real core with a stand-in relay that pushes to the simulator, the phone's grant and registration reach the computer, and a new card's push arrives once Infinitary is in the background and its tap brings Infinitary back; a simulated push runs no notification part, so the notification keeps the relay's words, and opening the card it names and where a tap finds it are `PhonePushTests`'s.
