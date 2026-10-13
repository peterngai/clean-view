# Clean View

A Claude Code mod that makes Claude feel calm and friendly for people who aren't technical.

While Claude works, tool calls, file changes and command output are hidden. A simple checklist sits above the prompt instead, so you can always see the plan, what's happening now and how far along it is:

```
Build my landing page · 1m 12s                     [ ● Clean View: ON ]
✓ Read your brand notes            ██████████  Done
▶ Build the pricing section        ██████░░░░  60%
○ Add the contact form             ░░░░░░░░░░  Next
○ Polish the footer                ░░░░░░░░░░  Up next
```

The top line changes to show what's going on:

- **Needs you**: Claude is waiting for your OK or your answer.
- **⚠ Stuck**: something went wrong, explained in one plain sentence.
- **■ Stopped**: you pressed Esc.
- **✓ All done**: the job finished. After 5 seconds the checklist shrinks to one line.

Claude's normal written replies stay visible.

## Install

Type this at the Claude Code prompt in a terminal:

```
/plugin install clean-view --marketplace peterngai/clean-view
```

Answer `y` to add the marketplace, then press Enter to install it for your user. Clean View starts working straight away and in every session after that.

## Turn it on and off

- Click the **[ ● Clean View: ON ]** button above the prompt, or
- type `/simple on` or `/simple off`. Type `/simple` with nothing after it to switch.

Clean View starts on. Your choice is remembered after a restart. When it's off, everything Claude does is shown again and only the button stays.

## Good to know

- While Clean View is on, Claude lays out a short plan before it starts each request, even a quick question.
- Each new job sends one short, low-cost request to Claude's Haiku model to give the job a friendly name.

## For developers

The mod is a function-hook plugin. `hooks/register.tsx` calls `registerCleanView(on)` in `hooks/clean-view.tsx`, so more mods can be added beside it later. Its shared state, including the checklist, is typed in `types/index.d.ts` under the `clean-view` key.

```
claude plugin validate .
claude plugin test .
```
