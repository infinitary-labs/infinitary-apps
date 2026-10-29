Settings -> Integrations: what the first mate and the crew reach outside the person's projects, one row per connection, signed in as the person (INF-775; `docs/integrations.md`).
```jsx
<IntegrationsTab integrations={[]} addable={[{kind:"github",name:"GitHub"}]}/>  // nothing connected
<IntegrationsTab integrations={[{id:"github",name:"GitHub",account:"octo",health:"ok",paused:false,actions:ACTIONS}]} addable={[]}/>
<IntegrationsTab integrations={[{...GITHUB, paused:true}]} open="github"/>  // paused, actions open
<IntegrationsTab integrations={[{id:"mcp-notes",kind:"mcp",name:"Notes",runs:"npx -y @example/notes",health:"ok",paused:false,actions:TOOLS,events:[RESOURCE_CHANGED]}]} open="mcp-notes"/>  // an MCP server, open
<IntegrationsTab integrations={[]} addable={[GITHUB_KIND, MCP_KIND]} adding/>  // the MCP server form
<IntegrationsTab integrations={[]} addable={[GITHUB_KIND, GOOGLE_KIND, MCP_KIND]} notice="google"/>  // Google's notice, before its page opens
<IntegrationsTab integrations={[]} addable={[GITHUB_KIND, GOOGLE_KIND, MCP_KIND]} signingIn="google"/>  // waiting for Google's page
```
The tab's head is the Automation tab's: the title "Integrations" at `--text-md` weight 500, then one `--text-sm --fg-3` intro, "What your first mate and your crew can reach outside your projects.
Each row is one connection, signed in as you."
Then the one list box `ForgeRow` draws (`--bg-1`, `--line-1` hairline, `--radius-m`), on its grid and rhythm: a `StatusDot` by the sign-in's health (the forge rows' tones; `idle` while paused), the name at weight 500 as a button with a small chevron that turns over when open, a `Badge` "signed in" (outline "paused" while paused; the `--danger` mono words "sign in again" when the host refused it), and the mono `--text-xs --fg-3` line "as octo · 2 actions", "paused" first while paused.
A connection the app renamed to avoid a GitHub name clash carries one quiet explanation directly below its row, in `--text-sm --fg-3`, aligned with the row's name, even while collapsed.
It says "Renamed from “GitHub” to keep it distinct from your GitHub connection." and stays across restarts until the person chooses a name themselves.
A refused sign-in carries one small primary "Sign in again", as a forge row does.
A GitHub sign-in the person took from GitHub CLI reads "as octo · through GitHub CLI · 2 actions"; when GitHub CLI no longer holds a sign-in its `--danger` line reads "Sign in to GitHub CLI again, then Check now." and the small primary is "Check now", since the app never runs GitHub CLI's own sign-in.
Its `RowMenu` holds "Check now", "Pause" (detail "Nobody reaches it until you resume it") or "Resume", and, behind a separator, "Sign out and remove" (danger).
With nothing connected the box holds one quiet line, "Nothing connected yet.", never a warning.
Open, the row is followed by its actions, indented to the name: each a row of its label in `--text-sm --fg-1`, an outline `Badge` with what it does ("reads", "changes", "sends"), its rule in mono `--fg-3` ("Allowed", "Asks you", "Off"), and a `Switch` whose name is "<label> on".
After the actions come what it can tell, on the same grid: the label ("A resource changed") and an outline `Badge` "tells", with no rule and no switch.
An MCP server's row is the same row with no sign-in: the `Badge` reads "connected", the `--danger` mono words read "could not reach it" when it did not answer, the mono line reads what it runs ("npx -y @example/notes · 3 actions"), and its menu's last item is "Remove" (danger).
A kind that signs in with keys follows its actions with its keys, indented the same: the `--text-xs --fg-3` head "Keys", then each key as its label in `--text-sm --fg-1` with "Kept on this computer" in mono `--fg-3` or "Not entered" in `--danger`, and under it one write-only mono password `Input` ("Paste it here") beside a small primary "Save" ("Replace" once kept) and, once kept, a small ghost "Remove".
The field starts empty every time and never shows a kept value; one `--text-xs --fg-3` line closes the keys, "It stays on this computer.
Your first mate and your crew use it but never see it."
The foot is the `ConnectChips` row: one chip per kind not yet connected ("+ GitHub", "+ Google"), whose sign-in aside is `ForgeRow`'s device-code aside, under the chip or under the row signing in again.
Where GitHub CLI is installed, GitHub's aside closes, below a `--line-1` hairline, with one `--text-sm --fg-3` line, "If your organization blocks apps like Infinitary, use the GitHub sign-in that GitHub CLI already holds on this computer.", and a small ghost "Use GitHub CLI"; nothing is asked of GitHub CLI before that click.
Before Google's page opens, Google's notice takes that place and box (INF-949; Google's Workspace user data policy asks an app to show what it uses and where it goes, right before the sign-in, and to wait for an accept).
The chip, a row's "Sign in again" and a card that opens Google's sign-in all open the notice first, and nothing is asked of Google until it is accepted.
It reads, top to bottom: the title "Before you connect Google" in `--text-sm` weight 500 `--fg-1`; one `--text-sm --fg-2` lead; two groups, "What Infinitary uses" and "Where it goes", each under an `--text-xs --fg-3` head like the keys' "Keys"; one `--text-sm --fg-3` closing line; then a small primary "Accept and continue to Google" beside a ghost "Cancel".
Each group is a list of `--text-sm --fg-2` items, one fact per sentence, an item's name first in `--fg-1` weight 500 ("Gmail", "Calendar", "Your AI provider", "Other computers", "Saved task records").
It sits in the aside's place, framed by a `--line-1` hairline at `--radius-m` with `--space-3` by `--space-4` padding, so the focus ring it takes on opening follows that frame, and it keeps a reading measure of about 72 characters, so a wide window never stretches it.
The notice takes the focus when it opens, labelled by its title, so it is read from the top and Tab reaches Accept; Cancel closes it with nothing asked and puts the focus back on the chip, and leaving the tab is no accept either.
The words are `INTEGRATION_NOTICES` in `src/shared/integrations.ts`; the notice never closes by itself.
Google signs in in the browser, so once the notice is accepted its aside, in the same place and box, is one `--text-sm --fg-2` line, "Finish signing in to Google in your browser.", over a small secondary "Open the page again" and a ghost "Cancel"; its chip reads "Connecting..." while it waits, and the new row opens on its actions once the browser is back.
Its last chip, "+ MCP server", is always there, and opens the add form under the chips in the same aside box: a "Name" field (placeholder "Linear"), a mono "Runs" field (placeholder "npx -y @example/mcp-server, or https://example.com/mcp") with the `--text-sm --fg-3` hint "A program and its arguments, started on this computer when someone uses it, or the server's https address.", one `--danger` `--text-sm` status line for why it could not connect, and a small primary "Connect" ("Connecting…" while it connects; disabled until both fields hold words) beside a ghost "Cancel".
Connect opens the new row on the tools the server listed.
The Infinitary Inbox, Infinitary's own integration, is no row and no chip: it is its own `fm-forges-box` under the connections box and its chips (INF-1474, the captain's wording B), padded `--space-4`, with its name in `--text-md` weight 500 over one `--text-sm --fg-2` line, "Scripts on this computer can send your first mate a short note, such as a finished deploy.
Each note is information, never an instruction.", and a `Switch` named "Infinitary Inbox on" at the right, off until the person turns it on.
Off, one `--text-xs --fg-3` line reads "Turn it on to see the line your scripts run."; switched off after it was on, the line first says "Off.
The saved notes stay, and scripts get an error until you turn it on."
(INF-1567, the captain's direction C: the switch is the inbox's pause).
On, the switch turns its rule on with it, and the box shows the example line in `--font-mono` `--text-xs` on `--bg-2` with a `--line-1` border, wrapping anywhere, beside a small secondary "Copy" whose status line reads "Copied"; the line ends in `note "Confirm you have received this"`, the words a program replaces.
Under it one `--text-xs --fg-3` note, "Run it from any script or terminal, with your own words in the quotes.", then, with no heading and nothing to open (the captain's reply on INF-1475: no More and Less), one `--text-sm --fg-2` line saying where the short name's link stands, with a small secondary "Link it" beside it, shown only where the link can be made or already was, and never a line saying why it cannot be; last, one `--text-sm --fg-2` line, with no button beside it, saying whether a rule tells the first mate and then "Off keeps the notes and stops your scripts until you turn it on."
It opens "Your first mate is told at once." while a turned-on rule listens, "The rule Infinitary Inbox events is paused in Automation, so your first mate is not told.
Notes are still saved." while the rule is paused there, and "No rule listens to the inbox, so your first mate is not told." once it is deleted, so the box never says the first mate is told when it is not (the captain's q4).
The words are `INBOX_WORDS` in `src/shared/integrations.ts`.
The tab closes with its Data section, under the inbox box: the Settings `SectionLabel` "Data", 32 above as any section, then one `SettingRow`, Delete Gmail and Calendar content, as General's Purge task data row is drawn, with its `--text-sm --fg-3` description and a small ghost "Delete" that turns into a danger "Confirm delete" on the first press, and whose answer takes the description's place.
While the inbox is kept, a second row of the same shape follows, "Delete Infinitary Inbox notes", described "Removes every note your scripts sent and the inbox's key, and turns the inbox off."
It shows whether or not Google is connected, since removing Google deletes none of what the agents read, and is absent where the build keeps no such content; the words are `SAVED_OUTSIDE_DATA_WORDS` in `src/shared/savedOutsideData.ts`.
Settings -> Projects' "Where your projects live" ends with one pointer line, "Your GitHub, GitLab and GitHub Enterprise sign-ins are in Integrations.", in `--text-sm --fg-3`, with a small secondary "Open Integrations".

GitLab and GitHub Enterprise each draw one row per signed-in host, named GitLab for gitlab.com and by address for a server.
Their rows use the same health, action switches and menu as GitHub, with two actions, Read and Change.
The GitLab and GitHub Enterprise chips remain available to add another server; GitLab's public chip and server chip never duplicate the same label.
The browser/application guide and both key forms described in `components/projects/ForgeRow` render here, under the row signing in again or under the chips for a new host.
Projects keeps only its pointer and other computers' own GitHub rows.
