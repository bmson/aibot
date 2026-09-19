# What the transcript costs per frame

The chat transcript is the one screen in this app that has to hold 60fps while
something else is happening — a reply streaming in, a finger dragging the pull
menu open, a word being typed into the composer. This is what makes that
affordable, and the rules to keep it that way.

## Why the transcript is unusual

`ChatView.conversationSurface` builds the log into a plain `VStack`, not a
`LazyVStack`. That is deliberate and the comment there explains it: the
transcript's viewport ends 18pt above the composer and `scrollClipDisabled()`
is what lets the strip under the input keep showing the log. A lazy stack stops
vending a row once it leaves the viewport, so a bubble on its way down was
built, drawn under the glass, then dropped — blinking out a whole composer
above the bottom of the screen.

The cost of that choice is that **every row in the conversation is offered a
rebuild whenever anything in `ChatView` changes**. And a great many things
change: `draft` on every keystroke, `menuPullDistance` on every point of a
drag, and the streamed message's text on every token. So the per-row cost is
not paid once when a screen opens — it is paid on every frame of every
interaction.

That is the whole shape of the problem. Three things keep it in budget.

## 1. A row that has not changed is not rebuilt

`MessageBubble` and `ApprovedReceiptGroup` are `Equatable`, and the transcript
attaches `.equatable()` to each. A token landing in the newest reply changes
exactly one row; every other row compares equal and SwiftUI skips its body.

Comparing is much cheaper than it looks: the message values come out of the
same array, so their strings compare by buffer identity rather than character
by character.

`MessageBubble`'s actions are closures and cannot be compared, so `==` compares
whether each one is present. That is sound because none of them varies while a
row's content holds still — each captures either `AppModel`, which is a
reference, or the message itself, and the ones that switch off do it by going
nil (`runForReal` and `retry` while a turn is in flight, `hide` for a row the
server has not stored yet).

**If you add a property to `MessageBubble`, add it to `==`.** A property left
out is a row that does not redraw when it should. A new closure needs the same
argument the existing ones have: either it never varies, or its nil-ness says
when it does.

`@State` and `@Environment` are not part of this and do not need to be. SwiftUI
tracks them per row and invalidates it directly, so a colour scheme, Dynamic
Type or Reduce Motion change still redraws every bubble.

## 2. Markdown is parsed once per source string, not once per frame

`AssistantMarkdown` is a hand-written block parser plus an `AttributedString`
build per block — the dominant cost in turning a message into views, and a pure
function of the source string. `blocks(in:)`, `attributed(_:inline:)`,
`inlineAttributed(_:)` and `plainText(_:)` all go through a `RenderMemo`
(`System/RenderMemo.swift`): a bounded, thread-safe memo that keeps its newest
keys.

Two things follow from that:

- **Reach for the memoised entry points**, not the parser behind them. Calling
  `AttributedString(markdown:)` directly in a body puts the cost back.
- **Read a parse into a local before looping over it.** `blocks` used to be a
  computed property, and the `blocks[index - 1]` lookup inside the `ForEach`
  re-entered the parser once per block — quadratic in the length of a reply.

A miss costs exactly what every call used to cost, so the memos degrade into
the old behaviour rather than into a cliff. Full, they come to a few megabytes.

`NSRegularExpression.cached(_:options:)` is the same idea for patterns:
compiling costs far more than matching, and the card readers in
`MessageBubble.swift` build several of their patterns from parts at call time,
so a stored property per site would not have covered them.

## 3. What a row needs to know about the log is resolved once

Two of `MessageBubble`'s inputs depend on the rest of the conversation: the
prompt a reply is answering, and whether a newer answer has superseded it. Both
were scans through `model.messages` inside the row builder, so drawing n rows
cost n scans of n messages — on every frame, per the above.

`TranscriptContext` resolves both in one pass before the `ForEach`. If another
row input needs to look at its neighbours, put it there rather than scanning
from inside the row.

## Formatters

`AssistantFormatters` (in `Models/APIModels.swift`) holds the shared
`DateFormatter`s. Constructing one is expensive — it resolves a locale, a
calendar and a format — and these are read while drawing rows, so
`DateFormatter()` inside a body or a per-row helper is a real cost, not a
micro-optimisation. `DateFormatter().monthSymbols` inside a `ForEach` was the
worst instance.

The trade is written down next to the type: a shared formatter resolves its
format once, so a region changed while the app is running may not reach it. iOS
relaunches an app when the region changes, which is what makes that acceptable.
Anything keyed to a fixed wire format pins `en_US_POSIX` and must not be given
the device's locale.

## What is covered, and what a device still has to confirm

`AssistantTests/RenderCostTests.swift` covers the correctness claims, not the
speed: that the memo computes once per key and stays within its limit, that
`attributed(_:inline:)` reads a source exactly as the inline build it replaced
did, that `TranscriptContext` agrees with the scans it replaced for every row,
and that a row compares equal only while its content holds still — including
that a landing token still makes it unequal.

None of it measures frames. The remaining per-frame work in
`conversationSurface` is linear in the length of the log —
`transcriptItems()`, `TranscriptContext`, and one `==` per row — and whether
that needs to move into an equatable child view of its own is a question for a
profile on a device with a long conversation open, not for a reading of the
code. The same goes for the other submenu screens: `ActivityView` and
`RootView` use `LazyVStack`, but the memory library, Knowledge, Workspace and
People screens still build their lists eagerly, and converting them has to
clear the zero-height-proposal trap that `MessageBubble`'s code blocks
document.

The server side of "the app feels slow" is a separate axis and is written up in
[`docs/audits/performance-review.md`](../../../docs/audits/performance-review.md).
