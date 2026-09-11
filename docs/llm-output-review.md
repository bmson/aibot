# Reviewing what the models said

The cost ledger (`model_calls`) proves a call happened and what it spent. It
keeps neither the prompt nor the answer, so questions about answer *quality* —
"was last week worse than the week before", "did that routing change help",
"how often does the briefing come out malformed" — had no source at all. They
were only answerable by reading transcripts by hand, which is how the
[September 2026 audit](audits/llm-response-quality-review.md) started.

Capture closes that, and `pnpm audit:llm` reads it back.

## Turning capture on

Set it in `.env` and provision — `infra/gcp/deploy.sh` forwards both settings to
the agent and the web service. Setting them by hand in the Cloud Run console
does not stick: the deploy uses `--set-env-vars`, which replaces the whole
environment, so the next provisioning run silently wipes anything the script
does not name.

```dotenv
LLM_AUDIT_CAPTURE=redacted   # off | redacted | full
LLM_AUDIT_RETENTION_DAYS=14
```

It is `off` by default, because these rows necessarily contain the owner's
mail, calendar and conversations.

- **`redacted`** scrubs email addresses, phone numbers, long digit runs
  (booking, account and card numbers) and URL paths before writing. Dates,
  times, amounts and scores are deliberately kept — redaction that ate those
  would destroy the reason to keep the record.
- **`full`** stores the text verbatim. More useful for judging whether an answer
  was actually grounded in its evidence, and a much more sensitive table.
  Appropriate for a single-owner installation reviewing its own assistant; think
  twice where the mailbox carries anyone else's correspondence.

Redaction is pattern-based and conservative. It removes the identifiers that
make a leaked row harmful; it is not a promise of anonymity, because free text
can always name a person.

Retention is enforced by the ordinary maintenance sweep. Nothing reads this
table back into a prompt — it is review telemetry, never an input to the
assistant's own reasoning.

## What gets captured

Every generative call, because they all converge on one seam. `ModelRouter`'s
`generate`, `stream`, `step` and `object` all meter through the same place, so
one insert there covers all thirty call sites — including the briefing,
watch-suggest, email triage, extraction and card surfaces that no test exercises
today. Embeddings are not captured: an embedding has no answer to judge.

Each row holds the role, model, method, system prompt, input, output, finish
reason, latency and token counts, and links to its `model_calls` row for cost.

## Reading it back

```sh
pnpm audit:llm                              # last 7 days
pnpm audit:llm --days 30
pnpm audit:llm --role draft                 # one role
pnpm audit:llm --prod                       # PROD_DATABASE_URL, read-only
pnpm audit:llm --json report.json
pnpm audit:llm --show unclosed-code-fence   # the records behind a column
```

The report groups by `role/method` and gives call volume, p50/p95 latency,
output tokens, and a defect count per surface. It runs in a read-only
transaction, needs no model credential, and costs nothing — safe against a
production replica.

## What the graders check

Deterministic checks over the text alone (`packages/core/src/model-router/audit-graders.ts`):

| Defect | What it catches |
| --- | --- |
| `unclosed-code-fence` | An odd fence count, which renders the rest of the reply as code |
| `background-notice-echo` | The assistant repeating `[Background notice…]` from its own context |
| `forbidden-theme-tag` | A `[theme: …]` tag, which the cue vocabulary forbids outright |
| `excess-break-tags` | More than two `[break]` tags in one reply |
| `excess-chip-rows` | More than one `[action_chips: …]` row |
| `fabricated-interface-element` | `[Set alert] | [Check timing]` — a fake button row nothing renders |
| `empty-output` | A call that produced no text |
| `truncated-output` | The provider stopped at the token limit |
| `emoji` | An emoji, which is a defect unless the owner asked for one |

Several of these previously existed **only** inside the question-regression
harness, so the suite graded properties the runtime never enforced. They live in
a pure, exported module now specifically so the response contract can call the
same functions — see recommendation 6 in the audit.

## What this does not tell you

The graders judge the text, never whether the answer was *correct*. Deciding
that needs the evidence the answer was drawn from, which is what
`groundReadDraft` already does for calendar, email, drive and memory reads —
and what live web and weather answers still lack.

A clean report means no detectable defect. It is not a claim that the assistant
had a good week.
