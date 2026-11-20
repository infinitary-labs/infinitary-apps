The one dialog that asks the person to agree before something is shared with or charged by someone other than the models they already use.
Besides the custom API connection's own dialog, it is the only modal Settings opens: every other form there stays inline (`AddProject.prompt.md`).
Every consent takes this dialog, whatever asks for it: turning on a decision model that is reached with the person's own key (Jev, with its key field inside), picking an OpenRouter decision model, and turning on a use whose answering model was approved on an older screen (`docs/decision-models.md`, "The uses").

**The surface.**
The modal-level surface command search and the picture viewer use: `--bg-0` at 80% under `--blur-overlay`, over the whole window.
On it one panel, centred: `--bg-2`, a `--line-2` hairline, `--radius-l`, `--shadow-2`, `--space-5` of padding, as wide as five `--space-9` or the window less `--space-4` at each side, and never taller than the window less `--space-4` at top and bottom (its body scrolls).
`role="dialog"`, `aria-modal`, named by its title and described by its rows.
It grows in like a popover, from `--scale-pop` over `--dur-quick`; reduced motion makes it a cut.

**The words.**
The title at `--text-md`, weight 500, `--fg-1`, says the act in a few words: "Turn on Jev", "Turn on Jev 1.13 through OpenRouter", "Allow “Propose standing direction” with Jev".
Under it the rows, a definition list: each label in a column of its own at `--text-sm`, weight 500, `--fg-2`, and its sentence at `--text-sm` / `--fg-2` beside it, wrapping under the label when the panel is narrow.
A decision model's approval has three rows, in this order: Shared (what goes to whom), Your choice (what the person can turn off or remove later), Cost (who pays, and who answers when it cannot).
The rows say what is sent and to whom in plain words, and promise nothing the code does not keep; they never speak for the vendor.
A field the act needs, such as the key, sits under the rows: a labelled mono `Input`, write-only, empty every time the dialog opens, with a `--text-xs` / `--fg-3` line under it saying where the value comes from.

**The buttons.**
At the panel's foot, right-aligned: Not now (ghost), then the act (primary, the dialog's one accent), named with the act's verb ("Turn on", "Allow").
The act stays disabled until every field it needs holds something; Enter in a field presses it.

**The keys.**
Focus starts on the first field, or on Not now when there is none, so Enter alone never agrees.
Tab and ⇧Tab move among the dialog's own controls and wrap at either end; nothing underneath is reached while it is open.
Escape and Not now close it and change nothing: no switch moves, no pick is made, no key is kept.
Closing gives focus back to what opened it: the switch, the menu's button, or the picked model's row.

```jsx
<ConsentDialog title="Turn on Jev" facts={[["Shared", "…"], ["Your choice", "…"], ["Cost", "…"]]}
  act="Turn on" actDisabled={!key} onAct={turnOn} onClose={close}>
  <Input type="password" mono aria-label="Jev key" placeholder="Your TypeSafe key"/>
</ConsentDialog>
```
