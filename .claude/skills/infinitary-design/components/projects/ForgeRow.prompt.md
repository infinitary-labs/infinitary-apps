"Where your projects live": the optional section at the top of Settings -> Projects where the person signs the app in to the place their projects live (git integration PR 1.2; GitHub on github.com, GitHub Enterprise on the person's own server, and GitLab on gitlab.com or the person's own server).
```jsx
<ForgeSection signIns={[]} hosts={[{host:"github.com",name:"GitHub"}]} servers={[{kind:"github",name:"GitHub Enterprise"}]}/>  // nothing signed in
<ForgeSection signIns={[{host:"github.com",name:"GitHub",login:"octo",state:"ok",projects:3}]} hosts={HOSTS} servers={SERVERS}/>
<ForgeSection signIns={[]} hosts={HOSTS} servers={SERVERS} flow={{host:"github.com",userCode:"WDJB-MJHT"}}/>    // sign-in in flight
<ForgeSection signIns={[]} hosts={HOSTS} servers={SERVERS} keyForm={{host:"",server:{kind:"github",name:"GitHub Enterprise"}}}/>  // a key sign-in
<ForgeSection signIns={[{host:"github.example.com",name:"github.example.com",login:"mona",state:"ok",projects:2,server:{kind:"github",name:"GitHub Enterprise"}}]} hosts={HOSTS} servers={SERVERS}/>
```
A micro label `WHERE YOUR PROJECTS LIVE`, then one `--text-sm --fg-3` intro: "Optional.
Sign in once and your first mate can clone your projects and put changes in for you; projects kept on this computer need no sign-in."
Then one list box (`--bg-1`, `--line-1` hairline, `--radius-m`) the Subscriptions rows share their grid with: a row per signed-in host - `StatusDot`, the host's name ("GitHub") at weight 500, a `Badge` "signed in", and the mono `--text-xs --fg-3` line "as octo · 3 projects here" - with a `RowMenu` whose one item is "Sign out" (danger).
With nothing signed in the box holds ONE quiet line instead, "Projects kept on this computer need no sign-in." in `--fg-3`: never a warning tone, never an empty-state illustration, never a call to action - the section is optional and must read as optional.
Dot tones follow the sign-in's health and nothing else: `ok` when the host answered who the person is; `ring` while it has not answered yet or cannot be reached (label "signed in · could not reach GitHub"); `danger` only when the host refused the sign-in, where the row says "sign in again" and carries that one inline action (a small primary Button), exactly like a subscription row that needs it.
The foot is the `ConnectChips` row shape: a chip per host that offers a sign-in ("+ GitHub"), hidden for a host already signed in; a chip per host on the person's own server the app already knows from a project there ("+ github.example.com"), hidden the same way; and one chip per kind of server a host can be added as ("+ GitHub Enterprise"), always there.
The sign-in aside renders under the chip that started it, flush inside the box, in `ConnectChips`' device-code shape: one `--text-sm` line "Enter this code on GitHub:" with the code in a mono `--bg-3` chip with wide tracking, a small secondary "Copy code" Button beside the code, then a small primary Button "Open GitHub" and a ghost "Cancel".
Copy only the displayed current code; show "Copying..." while awaiting the clipboard, and a polite live status "Code copied." only after success, or "Could not copy the code.
Select it and copy it yourself." on failure.
Feedback resets for a fresh code or sign-in attempt; copying never opens GitHub or changes the sign-in flow.
A code that ran out reads "The code expired." with a secondary "Get a new code"; a flow that could not start reads "Could not reach GitHub - try again."
The person saying no on GitHub's page is quiet: the aside simply closes.
A GitHub Enterprise host has no code - the app's own sign-in is not registered there - so its chip, its "Sign in again" and a card's "Sign in to github.example.com" open the key aside instead, in the same place and the same flush shape, as one form named "Sign in to github.example.com" (or "Sign in to GitHub Enterprise" for a new address): one `--text-sm` line "Make a key on github.example.com, then paste it here.
It stays on this computer.", an "Address" label over a mono Input (placeholder `github.example.com`, filled in for a host the app knows; it takes the host's name, a page on it or a project's address there), a small secondary "Make a key on github.example.com" Button that opens the host's own page for making one with its boxes ticked (disabled until the address names a host), a "Key" label over a mono password Input, a polite status line in `--danger` for what went wrong, then a small primary "Sign in" (pending "Checking...") and a ghost "Cancel".
Enter in either field signs in.
The key clears after every try and never comes back to the window.
What went wrong is one sentence naming the host: "github.example.com did not accept that key.
Make a new one and try again.", "Could not reach github.example.com.
Check the address and your connection.", "github.example.com did not answer as GitHub Enterprise does.
Check the address.", "That is not a key from github.example.com.
Copy the whole key and paste it again.", and for github.com "github.com signs in with its own button above."
A signed-in host on the person's own server is a row like GitHub's, named by its own address ("github.example.com"), its mono line saying what it runs first: "GitHub Enterprise · as mona · 2 projects here".
Never the words token, credential, OAuth, device code, keyring, CLI or gh - the key aside says "key", as an API key does in `ConnectChips`; never anything that suggests a project needs a host.
A project row below this section says where it lives ("on GitHub") only when its changes go there.

GitLab's chip opens browser sign-in in the same flush aside, with gitlab.com filled in; changing Address selects a self-hosted server.
Browser sign-in uses the existing code, Copy code, Open and Cancel view, not a second browser layout.
Before a code, the aside holds Address, a small secondary Open applications button, one-time registration instructions and a mono Application ID field.
The instructions name the chosen host, tell the person to register Infinitary with Confidential off and api and write_repository selected, and give the host's own browser confirmation page as Redirect URI, unused by this code flow.
These are GitLab's field names and values, written in mono; ask for no Secret.
A disclosure named Register Infinitary once per server holds the numbered instructions, open until there is an Application ID from a previous successful sign-in.
The primary Get a sign-in code button starts it, with Use a key instead secondary and Cancel ghost beside it.
A polite status explains a refused start without repeating the server's response, and notes that browser sign-in needs GitLab 17.9 or newer.
The app has no shared gitlab.com registration, so it guides personal registration there too; an administrator can supply an Application ID on a restricted server.
The existing key aside remains available on both host types, with Use browser sign-in returning to browser setup.
Changing method preserves the typed address, never a key.
All fields and buttons use the existing Input and Button primitives, Tab order and focus ring.
Do not draw two identically named chips when a public key host and its server kind both offer GitLab; the public chip serves both until signed in, then the server chip adds another host.
Its Make a key button opens GitLab's personal access key page with api selected.
The address placeholder and address refusal use gitlab.com for the GitLab kind.
A signed-in public row is named GitLab; a self-hosted row uses its address, and both carry GitLab in their mono subline.
The same refused-key status and focus rules apply, and a masked key clears after each try.
The key aside's opening instruction follows the address as it changes, so the instruction and Make a key button always name the same host.
