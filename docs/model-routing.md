# Model routing

All models use the existing OpenRouter account. Defaults are declared in
`packages/db/src/model-config.ts` and reconciled when the database is seeded.

| Work | Primary | Budget/provider fallback |
| --- | --- | --- |
| Main agent and tool execution | MiniMax M2.7 | GPT-OSS-120B |
| Conversational replies | Gemini 3.8 Flash | GPT-OSS-120B |
| Planning | DeepSeek V4 Pro 0813 | GPT-OSS-120B |
| Classification, extraction, rewriting, background synthesis | DeepSeek V4 Flash 0731 | GPT-OSS-120B |
| Memory embeddings | Text Embedding 3 Small | Same embedding model |

Kimi K2.5, K2.6, and K3 are available in the conversation model picker. Select
K3 explicitly for hard problems; it is never an automatic budget fallback.
The selection applies to conversational replies and the conversation's agent
tool loop. Internal planning and background roles retain their own defaults.
All choices remain subject to the existing task/daily/monthly budget checks.

Anthropic models and the old Qwen/DeepSeek Chat defaults are disabled. Their
historical usage records remain intact, and saved conversation overrides using
those models are cleared. Normal seed reconciliation upgrades retired routing
without overwriting later owner choices. It leaves the embedding model intact.

To explicitly apply this installation's routing to an existing database:

```sh
pnpm exec tsx scripts/configure-models.ts        # local DATABASE_URL
pnpm exec tsx scripts/configure-models.ts --prod # PROD_DATABASE_URL
```

The update is transactional. Capture the existing configuration first with
`pnpm eval:questions:config .workspace/model-config-before.json` for production.

Capabilities and prices were checked against OpenRouter's model and provider
endpoint catalogs on 2026-09-08. Reservation rates use conservative regular
provider rates (including DeepSeek Pro's peak rate), rather than temporary
discounts or the cheapest advertised endpoint. Actual billing uses OpenRouter's
reported `usage.cost`; stored rates are estimates, not fixed-price guarantees.
