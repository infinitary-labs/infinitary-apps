# Times of day are said in the captain's local time

FI3-1006, the captain's words: "we should make an improvement to fm3000's instructions that whenever firstmate or crewmate mentions time, by default it should use the user's local time. UTC is very difficult to understand".
A Firstmate note had said an incident started "about 19:11 UTC" while the card's own stamp read 01:48 PM in his time zone, and neither persona was told the captain's time zone.
`CARD_AUTHORING`, which every persona reads once, gains one sentence: every time of day written for the captain, on a card, in a reply or in a report, is in his local time zone, which the context names, such as 9:05 AM, unless he asks for another; a time a source gives in UTC is converted, and UTC is never written alone.
The Firstmate's per-turn context block gains `captain_time_zone`, this Mac's zone with its offset from UTC on the host's clock, such as `America/Los_Angeles (UTC-07:00)` (`src/core/prompts/timeZone.ts`).
A crewmate's prompt ends with the same fact, "The captain's local time zone is America/Los_Angeles (UTC-07:00).", named when its session opens on the Mac where Firstmate lives.
The offset rides beside the name so a model need not know the zone's daylight-saving rules.
The new sentence costs the fixed part about 61 tokens by the app's count; with it the fixed part measures 17,882, under the 18,500 budget, and the context block about 10 tokens a turn.

The ledger entry that comes with it:

FI3-1006, the captain's words. CARD_AUTHORING: every time of day written for the captain is in his local time zone unless he asks for another, converted from UTC, never UTC alone.
The context block names captain_time_zone with its current offset, and a crewmate's prompt names the same zone.
