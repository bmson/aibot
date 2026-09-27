# Generative UI

The assistant draws interfaces nobody designed ahead of time. It does this the
only way a shipped iOS app can: the model composes a **description** of a UI
out of a fixed vocabulary of native building blocks, and the app renders that
description with real SwiftUI. iOS cannot compile code at runtime and App
Review forbids downloading executable code, so "generate the SwiftUI" is not
an option at any layer; "generate the layout, render it natively" is what
every generative-UI system (A2UI, OpenAI widgets, MCP-UI) does. Novelty comes
from composition — a bigger vocabulary means more UIs the model can reach.

Mobile is the target. The web renders what it already knows and skips the rest.

## What exists

`packages/core/src/generative-card.ts` — the card compiler. A model picks
facts, a layout from the block vocabulary, an icon and actions. Every fact
value is checked verbatim against the evidence it was grounded in
(`validateGroundedCard`), and the result ships as a `generated-card` message
part that iOS draws in `MessageBubble.swift` and saves to the Cards tab.

The rules that make this safe, and that every layer below keeps:

- **Values are verbatim.** Anything a card states as fact appears word for
  word in the evidence, never sharpened out of a range.
- **The client computes, the model never does.** A countdown, a progress
  fraction or a chart scale is arithmetic done by trusted code over grounded
  values.
- **Actions are inert intents.** Nothing in the evidence reaches an action
  prompt; anything with a side effect goes through the approval policies.
- **Additive vocabulary.** Specs stay `version: 1` while changes are
  additive — a build that doesn't know a block renders nothing for it and
  keeps the rest of the card. Bumping the version would make older builds
  drop the whole card.

## Layers

### Layer 1 — layout and richer blocks (this change)

| Block | Shape | For |
|---|---|---|
| `section` | authored `title` + 1–6 leaf blocks | Grouping: Outbound / Return, Today / Tomorrow |
| `metrics` | 2–4 fact ids | Headline values side by side: Gate · Seat · Boards |
| `journey` | `mode`, from/to facts, optional depart/arrive/status/duration | Flights, trains, drives between two places |
| `progress` | value fact, optional total and label | "76%", "3 of 5 stops" as a bar |
| `stages` | 2–8 fact ids + current fact | Package tracking, application pipelines |
| `countdown` | ISO 8601 date fact with offset, optional label | Departure, kickoff, deadline — ticks live |
| `table` | 2–4 authored column labels, rows of fact ids | Comparing hotels, flights, options |
| `chart` | `bar`/`line`, 2–12 label/value points | Temperatures, spend, scores over time |
| `checklist` | fact ids | Packing list, prep list; ticks are kept on device |
| `map` | 1–6 place facts (address or `lat, lng`) | Hotel, venue, a day plan; tap opens Maps |

Sections nest one level only; a section holds leaf blocks. Shape problems a
model can make without lying (a chart value that isn't a number, a countdown
on a naive local time) drop that block; a grounding failure still refuses the
whole card.

### Layer 2 — live data

Blocks bound to a refreshable source instead of a snapshot, reusing the card
refresh machinery (`card-refresh.ts`). A new `flights.status` tool (AeroAPI or
similar) and a flight-status Live Activity driven by APNs push, alongside the
existing `AssistantActivityExtension`. Scores move onto the same path.

### Layer 3 — inputs

`text`, `picker`, `date`, `stepper`, `toggle` inputs and a `submit` action. A
submit produces a structured `ask_assistant` request — never a direct side
effect — so booking forms, RSVPs and expense entries go through the same
approval policies as any other action.

### Layer 4 — device capabilities

Actions handled by native code, each behind its own permission:
`add_to_calendar`, `start_live_activity`, `open_maps`. NFC and Wallet passes
are out of scope.

### Layer 5 — learning loop

Log request → evidence → spec → what the owner did with it (expanded, tapped,
dismissed, refreshed). Use it as an eval set in the question-regression
harness and for prompt tuning. Optionally distil into a Foundation Models
adapter so simple cards compose on device; adapters are pinned to a base-model
version and must be retrained per OS release, so this stays an optimisation.
