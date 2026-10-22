Settings -> Integrations: what the first mate and the crew reach outside the person's projects, one row per connection, signed in as the person (INF-775; `docs/integrations.md`).
```jsx
<IntegrationsTab integrations={[]} addable={[{kind:"github",name:"GitHub"}]}/>  // nothing connected
<IntegrationsTab integrations={[{id:"github",name:"GitHub",account:"octo",health:"ok",paused:false,actions:ACTIONS}]} addable={[]}/>
<IntegrationsTab integrations={[{...GITHUB, paused:true}]} open="github"/>  // paused, actions open
```
The tab's head is the Automation tab's: the title "Integrations" at `--text-md` weight 500, then one `--text-sm --fg-3` intro, "What your first mate and your crew can reach outside your projects.
Each row is one connection, signed in as you."
Then the one list box `ForgeRow` draws (`--bg-1`, `--line-1` hairline, `--radius-m`), on its grid and rhythm: a `StatusDot` by the sign-in's health (the forge rows' tones; `idle` while paused), the name at weight 500 as a button with a small chevron that turns over when open, a `Badge` "signed in" (outline "paused" while paused; the `--danger` mono words "sign in again" when the host refused it), and the mono `--text-xs --fg-3` line "as octo · 2 actions", "paused" first while paused.
A refused sign-in carries one small primary "Sign in again", as a forge row does.
Its `RowMenu` holds "Check now", "Pause" (detail "Nobody reaches it until you resume it") or "Resume", and, behind a separator, "Sign out and remove" (danger).
With nothing connected the box holds one quiet line, "Nothing connected yet.", never a warning.
Open, the row is followed by its actions, indented to the name: each a row of its label in `--text-sm --fg-1`, an outline `Badge` with what it does ("reads", "changes", "sends"), its rule in mono `--fg-3` ("Allowed", "Asks you", "Off"), and a `Switch` whose name is "<label> on".
The foot is the `ConnectChips` row: one chip per kind not yet connected ("+ GitHub"), whose sign-in aside is `ForgeRow`'s device-code aside, under the chip or under the row signing in again.
Settings -> Projects' "Where your projects live" ends with one pointer line, "Your GitHub sign-in is in Integrations.", in `--text-sm --fg-3`, with a small secondary "Open Integrations".
