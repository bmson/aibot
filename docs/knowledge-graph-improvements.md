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
5. **A native browse-first destination.** The phone still opens a selected-item workspace with a paged candidate list rather than a separate browse/detail navigation hierarchy. Add native paging and shared history/navigation semantics before expanding to a whole-graph canvas.

## Validation

- `pnpm test` prepares only the isolated `_test` database.
- `pnpm typecheck`, `pnpm lint`, and `git diff --check`.
- Native simulator tests plus manual connected-item traversal and review-preserves-selection checks.
- `scripts/visual-qa/knowledge-graph.ts` seeds synthetic data only into a local `_test` database and checks desktop/mobile navigation, direction, grouping, responsive panning, overflow, and browser errors. Run against localhost:3107 with development authentication enabled. It must not run concurrently with database-resetting tests.

Live account validation requires an authenticated bot.bmson.com session. Local verification does not imply deployment or a production migration.

### Verified on September 6, 2026

- Final repository run: 209 test files, 1,893 passing tests; typecheck, lint, architecture boundaries, and diff checks passed.
- Final native run: 136 passing tests, zero failures or skips. The earlier locked-session scroll test failure did not recur in either unlocked rerun.
- Simulator interaction: followed Alex → Robin; expanded two supporting sources under one connection; confirmed a source without changing selection or collapsing evidence; marked one source inaccurate while preserving the remaining source; returned to Alex.
- Visually inspected the final grouped native cards in dark mode and the responsive web inspector. Browser navigation, source grouping, responsive panning, and phone overflow checks passed using isolated synthetic data.
- No production mutation, graph migration, model extraction, push, or deployment was performed.
