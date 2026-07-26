# Whole-application UI audit

Date: 2026-07-25

## Direction

The application uses a restrained Jelly layer over the existing porcelain,
charcoal, and iris system. The conversation log remains the visual center of
gravity; navigation, forms, and operational pages recede into soft borders and
low-contrast tonal surfaces.

Typography is intentionally compact:

- Page titles: Bricolage Grotesque, 30–32px
- Section headings: Inter, 16px
- Body and controls: Inter, 14–15px
- Metadata: Inter, 12px
- Machine values: JetBrains Mono, tabular numerals
- Reading measure: approximately 68 characters for prose

## Jelly policy

The bundled Jelly UI runtime is pinned to local source revision `d898ec9`.
`scripts/vendor-jelly-ui.mjs` records the source commit, bundle digest, license,
generated declarations, and build lockfile. Production never executes the
unversioned remote runtime.

Typed React adapters are the only application-facing integration:

| Adapter | Intended use | Native behavior before registration |
| --- | --- | --- |
| `JellyButton` | Primary actions and reversible, prominent controls | Native button with the same name, type, disabled state, and form semantics |
| `JellyIconButton` | Compact navigation and composer icon actions | Native 44px mobile target |
| `JellyInput` / `JellyTextarea` | Search, composer, and optional free-text settings | Native labelled input/textarea; one submitted form value |
| `JellyNavTabs` | Route-backed segmented navigation | Native links with tab semantics and keyboard navigation |

Jelly is deliberately not used for native validation-critical controls, dates,
numbers, selects, files, checkboxes, destructive confirmation, dense row
actions, or ordinary links. An oversized Jelly animation canvas is clipped at
the adapter boundary so its paint area cannot change page geometry.

## Route and state review

Legend: **browser** means exercised in the responsive browser matrix; **fixture**
means a deterministic long-content record; **structure** means the explicit
rendering path was reviewed in code.

| Route | Important states reviewed | Coverage |
| --- | --- | --- |
| `/`, `/chat`, `/chat/[id]` | Redirect/initial chat, empty prompt suggestions, populated log, long Markdown and machine values, archived thread, composer disabled/ready, model palette, streaming/stop/error surfaces, sticky composer | Browser, fixture, structure |
| `/chat/all` | Main thread, populated and archived lists, long titles, archive pending action, empty groups | Browser, fixture, structure |
| `/approvals` | Empty waiting/resolved groups, pending cards, editable request, approve/decline pending and error feedback, expired receipt | Browser, structure |
| `/tasks`, `/tasks/[id]` | All five filters, empty filters, long progress text, approval-needed, running/pending/done/failed/cancelled, archive/restore/retry/cancel, tools and errors | Browser, fixture, structure |
| `/goals` | Empty/active/blocked/completed/archived, create/edit validation, start/pause/resume/finish/archive pending actions, long generated status without Markdown syntax | Browser, structure |
| `/profile` | Empty and populated owner facts, people, occasions, organizer idle/pending/running, refresh feedback | Browser, structure |
| `/profile/memories` | Empty/results/no-results, search/filter/pagination, narrow stacked search, organizer disabled/pending, long source identifiers | Browser, structure |
| `/profile/people/[id]` | Populated/empty facts, edit/save/delete pending and error, occasions, missing person | Browser, fixture, structure |
| `/documents` | Empty/list, upload pending, processing/ready/failed, retry/delete confirmation, long filenames and errors | Browser, structure |
| `/import` | File upload, queued/importing/ready/failed source, selection/start pending and inline errors | Browser, structure |
| `/skills` | Empty/list, expanded details, draft/published, edit/delete pending, validation and inline errors | Browser, structure |
| `/settings` | Optional text fields, save/saved/error, schedules empty/list/paused, policies empty/list/disabled/delete confirmation | Browser, structure |
| `/costs` | Empty usage tables, spending data, paused-by-cap notice, budget form validation/pending, numeric alignment | Browser, structure |
| `/anomalies` | Empty/list, suspend/dismiss pending actions | Browser, structure |
| `/improvements` | Empty/list, apply/dismiss pending actions | Browser, structure |
| Shared loading/error/not-found | Global route loading, profile/memory/person skeletons, recoverable error action, unknown route, missing dynamic record | Browser, structure |

## Defects corrected

- `PageHeader` actions now wrap below the title at narrow widths; Documents no
  longer collides at 320px.
- Activity’s five full tab labels scroll horizontally with a directional fade,
  13px minimum text, and URL-backed arrow-key navigation.
- The expanded System row now shares the same icon and label columns as every
  other navigation item.
- Memory search stacks into one field and one full-width action below 360px.
- Non-chat goal status copy is passed through the Markdown stripper.
- Long URLs, titles, identifiers, generated text, inline code, and tables wrap
  without widening the document.
- File inputs on Documents, Import, and voice samples have programmatic labels.
- The chat log is a named, keyboard-focusable scroll region.
- Light-mode muted text and active navigation contrast meet AA at normal text
  sizes.
- Jelly registration no longer replaces a focused native fallback during
  mobile-drawer opening. A value and focus typed before delayed registration
  are handed to the upgraded control, and textarea handoff also reconciles the
  controlled parent state so dependent actions such as Send become enabled.
- The local Jelly module is preloaded without blocking hydration, then executed
  after the native adapters are interactive. Fresh documents register
  reliably while blocked or delayed runtime requests retain usable fallbacks.
- Jelly controls remain form-associated without hidden duplicate values and
  follow native `form.reset()` behavior after upgrade.
- Conditional Send/Stop controls have stable React identities, preventing a
  send click from being reinterpreted as a stop click during the same pointer
  sequence.
- Controlled Jelly fields ignore the untrusted input event emitted by Jelly's
  programmatic value setter and deduplicate against the current React value.
  Clearing the chat composer can no longer oscillate between old and new text.
- Jelly input and textarea paint canvases are clipped at the adapter boundary;
  WebKit no longer counts their oversized shadow content toward document width.
- Native file inputs receive a definite mobile width across Documents, Import,
  and voice samples, avoiding Safari's 344px intrinsic file-control width.
- Native mobile fields use an explicit 44px height because WebKit can ignore a
  `min-height` when a smaller fixed height is also present.
- Interactive entrance motion preserves full hit-area dimensions throughout
  instead of briefly scaling a 44px target down to 43px.
- The dark Settings cost link uses the stronger iris text token, raising its
  contrast from 4.31:1 to 5.19:1.
- Shared loading skeletons use fluid maximum widths instead of fixed widths
  that escaped the 320px viewport.
- Route entry and scroll-reveal motion uses transforms without hiding readable
  content behind a transient opacity state. This also avoids stale invisible
  content during Safari client navigation and keeps Axe results deterministic.

## Responsive and interaction matrix

Automated smoke coverage runs in Chromium and WebKit at:

| Viewport | Primary concern |
| --- | --- |
| 320×568 | Header wrapping, stacked search, tab overflow, smallest reflow |
| 390×844 | Mobile drawer, focus trap/restore, 44px targets, composer and keyboard use |
| 768×1024 | Tablet portrait, long-content intrinsic sizing |
| 1024×768 | Tablet landscape and navigation transition |
| 1440×900 | Expanded navigation, reading measure, desktop hierarchy |

The suite checks every route for HTTP/console/hydration failures, unintended
horizontal overflow, clipped visible text or controls, form fields below 16px
on phones, and mobile controls below 44px. Representative routes also receive
critical/serious Axe checks. Additional contexts cover dark mode, reduced
motion, delayed/failed Jelly registration, single form values, and 200% text
reflow. Activity also verifies URL-backed arrow navigation and browser Back.
Dynamic fixtures stress unbroken identifiers, Markdown tables, and long titles,
and are deleted after the run.

The final local matrix passed in both Chromium and WebKit: 29 routes and dynamic
details across all five viewport sizes per engine, plus the interaction, theme,
fallback, and reflow contexts above.

## Manual Safari review

An additional pass ran in actual Safari 27.0 on macOS 27.0, beyond Playwright
WebKit:

- The long conversation log remains the dominant surface and scrolls
  independently.
- The sticky Jelly composer stays at the bottom; a long wrapped draft expands
  without covering the final message or pushing Send/model controls out of the
  viewport.
- Jelly textarea, toggle, model, Send, and navigation controls remain exposed
  to Safari accessibility APIs with useful names and states.
- Activity renders after client navigation with complete tab labels, soft
  hierarchy, and no stale hidden page caused by route animation.
- The test draft was cleared and the temporary Safari tab was closed.

The automated WebKit matrix covers drawer focus trapping/restoration, Activity
keyboard tabs, text-field submit/reset, dark and reduced-motion contexts,
blocked/delayed Jelly registration, and all phone/tablet orientations.

Pixel snapshots are intentionally not committed. A disposable before/after
contact sheet is generated outside the repository for release review.
