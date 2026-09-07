# Knowledge graph: evidence-led exploration

## Direction

The graph should help answer “What do we know about this person or project, why do we believe it, and what needs correcting?” A whole-graph drawing is useful for orientation, but the selected item and its source-backed connections are the primary interface.

Keep PostgreSQL/pgvector, the existing offline extraction pipeline, owner-only recall boundaries, and source-level review. This increment does not add a graph database, import more private sources, run extraction, or create inferred relationships.

## Implemented

- Map labels and search honor owner display-name overrides while preserving search by original names.
- Opening an item explicitly loads its neighborhood instead of relying on its presence in the newest 500 edges. The existing 200-node/500-edge bounds still apply.
- Web and iOS group identical directed, time-qualified connections for presentation; supporting evidence and review remain attached to the original rows. No stored facts are merged or deleted.
- The inspector uses complete relationship sentences, never reverses an incoming relation, and distinguishes reviewed connections from unreviewed extraction. Multiple sources are not presented as a numerical truth score.
- Web offers a focus filter, keyboard-accessible item browser, source excerpts/full notes, connected-item traversal, and an explicit link to the correct edit/review panel. The same inspector works on a phone without requiring a dense canvas.
- Small graphs fit the canvas. Responsive dragging converts screen pixels into SVG units, distinguishes a drag from a node click, and cancels cleanly.
- iOS keeps selection after refresh/review, ignores obsolete loads, exposes connected-item traversal with a return trail, and groups evidence under a compact disclosure. Corrections remain source-specific.
- Proactive gap questions use graph recall's current-source eligibility checks: rejected, quarantined, stale, unembedded, or unsupported source projections cannot create questions. Uncertain-connection questions identify both endpoints rather than an unnamed “something.”

## Next improvements, not implemented

1. **A single connection read model across every surface.** Currently the overview counters, review list, and recall count source-level edges; the new inspector groups claims. Introduce explicit `connectionCount`, `sourceCount`, and `needsReviewCount` in the application projection, with independent review state for each source. Extend the native API before moving aggregation into storage.
2. **Time-aware knowledge and disagreements.** Display current, historical, and conflicting claims separately. `validFrom`/`validUntil` already exist, but a past employer must not answer a current-employer question. The gap detector's legacy predicate equivalents also suppress present-day questions for historical predicates (`born_in` vs `lives_in`, `worked_at` vs `works_at`). Replace these with temporal rules and owner-relevant, paced questions; do not automatically resolve disagreements or erase history.
3. **Useful connections to existing work.** Link graph entities to explicitly associated Situation Packs, commitments, and people. Keep those references inspectable; semantic guesses should be suggestions the owner accepts, not silently established facts. Decide source scope before adding ingestion or schema changes.
4. **Explain a connection, with evidence at every step.** Existing bounded graph paths can support “How are these connected?” Show each hop, date span, and source separately; distinguish a path from proof of a new relationship. Evaluate with directed-family, former-employer, duplicate-name, rejected-source, and missing-evidence cases.
5. **Native browsing at scale.** The iPhone canvas now supports bounded neighborhood expansion and search. Native paging and shared history/navigation semantics remain future work beyond the explicit 200-node canvas bound.

## Validation

- `pnpm test` prepares only the isolated `_test` database.
- `pnpm typecheck`, `pnpm lint`, and `git diff --check`.
- Native simulator tests plus manual connected-item traversal and review-preserves-selection checks.
- `scripts/visual-qa/knowledge-graph.ts` seeds synthetic data only into a local `_test` database and checks desktop/mobile navigation, direction, grouping, responsive panning, overflow, and browser errors. Run against localhost:3107 with development authentication enabled. It must not run concurrently with database-resetting tests.

Live account validation requires an authenticated bot.bmson.com session. Local verification does not imply deployment or a production migration.

### Editing relationship evidence from People

- Tap a specific entry inside Relationship evidence or Recorded details to inspect its complete source, correct the relationship with a new owner note, or remove the claim.
- `GET /api/mobile/v1/knowledge/relations/:id` resolves an exact owner-scoped row, independent of browse/review limits. `DELETE` retires that row as rejected, preserving its original source and unrelated claims. Missing rows return 404, never a false success.
- Corrections reuse the existing source-backed replacement operation. Native correction previews preserve subject/object direction, including son/daughter predicates; custom predicates remain editable. Saving refreshes the current person and invalidates other cached dossiers.
- Requires both the updated mobile server routes and a new iOS build. No schema migration is needed.
- `scripts/visual-qa/people-evidence.ts` creates a conflicting parent/son pair in a local `_test` database without invoking models. Tests cover exact-row access beyond browse limits, source/sibling preservation, preview direction, failed removals, and cache invalidation. Visual inspection covered disclosure, source detail, and correction form; removal was verified through the local API after simulator window switching prevented the final confirmation tap. No real relationship records were changed.

### Verified on September 6, 2026

- Final repository run: 209 test files, 1,893 passing tests; typecheck, lint, architecture boundaries, and diff checks passed.
- Final native run: 136 passing tests, zero failures or skips. The earlier locked-session scroll test failure did not recur in either unlocked rerun.
- Simulator interaction: followed Alex → Robin; expanded two supporting sources under one connection; confirmed a source without changing selection or collapsing evidence; marked one source inaccurate while preserving the remaining source; returned to Alex.
- Visually inspected the final grouped native cards in dark mode and the responsive web inspector. Browser navigation, source grouping, responsive panning, and phone overflow checks passed using isolated synthetic data.
- No production mutation, graph migration, model extraction, push, or deployment was performed.

### Person pages and expandable trees — September 7, 2026

- Important dates now have an Edit action on web and iPhone, including a direct entry from the native person page. Edits update the same occasion ID, can correct or clear the year and notes, preserve reminder lead time, and refresh the directory and dossier. The shared application command rejects impossible calendar dates and missing or foreign-owner occasion IDs. Mobile uses `PATCH /api/mobile/v1/memory/occasions/:id`. No schema change is needed.
- Web person pages put dates and the connection tree before the folded record list. The knowledge map offers a Tree switch for the selected item. Branches load on demand, group identical directed and time-qualified claims, show cycle references, and support focus navigation with breadcrumbs. Each expansion starts with 50 source records and can grow to the existing 250-record cap; the remaining count is visible. Tree traversal explores the selected item's neighborhood beyond the overview filters.
- Source inspection resolves the exact claim directly, independent of the review-page limit. Remove controls retire one source-backed claim as rejected, preserve original notes and other claims, and refresh People as well as Knowledge. If another source supports the same relationship, that connection remains visible.
- iPhone offers a native expandable people tree from both the person page and the directory connection browser. It preserves ancestor references, refreshes the visible branch after removal, and links to profiles for further exploration. At five nested levels, the profile link continues navigation. Native traversal requires an explicitly linked contact and uses the existing bounded dossier; the web tree also traverses places, projects, and organizations.

Design uses the existing green-paper canvas (#eef5f0), white panels (#ffffff), leaf accent (#217a4b), ink (#15201a), and quiet borders (#d3e1d7), with the app's existing type system. Indentation and branch lines carry the hierarchy. Dates remain visible while administrative records sit behind disclosure. Names and relationship sentences wrap; expansion feedback respects Reduced Motion.

Validation: 211 repository test files / 1,904 passing tests; 160 passing native tests, followed by a passing targeted snapshot run after refining field labels and tree presentation. Typecheck, lint, architecture boundaries, and diff checks passed. `scripts/visual-qa/person-tree.ts` uses only synthetic local `_test` data to exercise persisted birthday edits, cleared year/notes, preserved lead time, invalid dates, nested expansion, cycles, focus/breadcrumb navigation, cancellation, source inspection, partial evidence removal, and phone overflow. The existing map interaction regression script also passed. Light/dark native screenshots were inspected. Native touch traversal and removal were not manually exercised on a physical phone. Requires a web release and a new iOS build; no production records were changed.


### iPhone force-directed relationship graph — September 7, 2026

- A full-screen native canvas opens from People, a person’s Explore graph action, and Knowledge. Small nodes and subtle lines reveal connected clusters; node size reflects distinct neighbors. Drag individual nodes, pan the background, pinch or use zoom buttons, and fit the graph. Selecting a node highlights its neighborhood without resetting the viewport. Filters show people or a selected neighborhood; search reaches items beyond the current snapshot.
- UIKit owns drawing and gestures. A bounded spring simulation preserves existing positions as the graph expands, stops after settling or leaving the foreground, and respects Reduce Motion. Labels avoid node dots and other labels. The native list alternative opens automatically at accessibility text sizes and remains available through Graph options. VoiceOver can select canvas nodes or use the searchable list.
- Connections opens a source-level inspector with directed sentences, dates, review state, original notes, editing, removal, and navigation to the other endpoint. Removing one claim retains its original note and any other supporting source. Explicitly linked contacts open their person profiles.
- `GET /api/mobile/v1/knowledge/graph` uses the existing owner-scoped, active-source graph query. It resolves a person’s actual graph entity, supports isolated selected items, includes contact links, and exposes truncation. The existing snapshot bounds remain; native expansion caps the canvas at 200 nodes and 1,000 source rows. Searching beyond the node bound opens that item’s neighborhood. No storage migration or new extraction is involved; this increment adds no web graph UI.
- Validation: 212 repository test files / 1,909 passing tests; typecheck and lint passed. All 166 native tests passed, followed by focused gesture and snapshot tests for the final refinements. Native tests cover source deduplication, refresh/removal merging, 200-node finite layout, pinning, pan cancellation, selection stability, and zoom anchoring. Inspected light/dark, dense, empty, and large-text simulator screenshots. Touch gestures and frame rate have not been profiled on a physical iPhone.
- Delivery requires the mobile API release and a new iOS build. No production records were changed and no deployment was performed.

### Connecting loose groups — September 7, 2026

- The mobile graph completes eligible existing connections between visible nodes after selecting the bounded overview. This recovers older bridges hidden by recent source rows and also shows relationships among the neighbors of a focused item. It adds no inferred claims, includes no new endpoints during completion, caps the response at 1,000 source rows, and preserves partial-view indicators and source eligibility.
- Disconnected components occupy separate areas, with subtle group surfaces, stable centers, and an explicit Tidy layout action. Low-degree labels no longer collide with their own node hit bounds. Summary controls now reserve space above the canvas instead of obscuring nodes.
- The group count opens Connect loose groups. Small groups can be focused, expanded, or connected; single items appear in one compact list. Counts and prompts describe the loaded view, and the People-only filter explains hidden place/project bridges.
- Select an item and use Connect to search existing entities, browse other groups, or use shared recorded neighbors as a navigation hint. The owner explicitly chooses the predicate and source note. The editor preserves chosen entity IDs, supports reversing endpoints, prevents self-links and saving without a relationship, and requires a deliberate new-item path. Successful saves reload the neighborhood and update connected groups.
- Native list navigation scrolls the selected item's controls into view at accessibility sizes. Group and connection sheets share the app's canvas and accent colors.
- Validation: 1,910 repository tests and 170 native tests passed, with further focused simulator snapshots after visual refinements. Typecheck, lint, and diff checks passed. The integration test creates 500 recent rows plus an older bridge, checks recovery without new nodes, and confirms rejected claims remain excluded. Inspected light/dark graph, group browser, connection chooser, and editor screenshots. Manual touch walkthrough was blocked by the locked Mac; physical-device frame-rate profiling remains outstanding.
