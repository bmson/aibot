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
