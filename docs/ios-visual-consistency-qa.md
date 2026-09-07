# iPhone visual consistency pass — September 6, 2026

## Design decisions

- Keep the native green canvas, raised card surfaces, SF typography, and existing graph views.
- Use the same native form/list surface for People, Knowledge, Memory, Goals, Approvals, settings, skills, costs, and situation-pack editors.
- Show actual task counts in Activity and actual latest/next-action text in Goals. Do not infer a completion percentage from task status.
- Quiet repetitive Archive controls, retain 44-point targets, and move less frequent Goal actions into menus so the title and content have room.
- Animate filter selection and subpage evidence disclosures only in response to interaction. Honor Reduce Motion; leave chat transcript geometry and native composer gestures unchanged.
- Remove doubled workspace-header padding and duplicate empty/summary panels. Distinguish initial loading from an empty result.

## Verification

- Full native simulator suite, including chart input sanitization, complete status accounting, date presentation, and Reduce Motion policy tests.
- Twelve captured layouts: Activity, Goals, and shared editor/evidence surfaces, each in light, dark, 320-point width, and accessibility text size. These are rendered review artifacts, not pixel-diff assertions.
- Existing native tests continue covering conversation cards, People/Knowledge maps, and situation-pack/Goal editors.
- Inspected Activity and Memory with the paired bot.bmson.com simulator. Installed the updated app without changing pairing or account data and visually checked the new Activity layout against its 50 loaded tasks.
- No live archive, approval, goal lifecycle, or account-data mutations performed.

## Remaining manual coverage

Simulator focus was repeatedly taken by another simulator window. Smoothness of the filter/evidence transitions and an exhaustive live walk through every editor remain unverified. The shared presentation code was audited across native pages; this is not a claim that every page, state, or gesture was manually exercised. Web UI and Dynamic Island status-lifecycle issues are outside this visual change.

## Second pass: Memory and Costs

- Memory organizer now separates the reported run status, facts awaiting organization, and expandable raw run details. A completed run does not imply all facts are organized. Unknown statuses never appear as successful completion.
- Costs now ranks source/model entries by reported spending and draws proportional bars against the largest amount in that group. Amounts and usage-entry counts remain readable independently of color; these are comparisons, not budget utilization percentages.
- Five entries are visible initially and the remaining entries can be expanded. The old eight-entry truncation is removed. Missing or invalid amounts are unavailable rather than zero, and tiny positive amounts are not rounded into apparent zero spending.
- Full native suite: 158 passed, zero failures/skips. Ten additional component captures cover light/dark, 320-point width, accessibility text size, expanded details, and organizer failure/running states. Reviewed both components in every captured variant. Large-text review caught and fixed the shared inline glyph overflowing its fixed tile; accompanying text still scales with Dynamic Type.
- Live Goals empty state and toolbar were visually inspected using the paired service. Editor taps could not be verified reliably as simulator focus continued moving between other active task windows; no production mutations were performed. New Memory/Costs coverage is rendered native component coverage, not a claim of full live-page interaction verification.
