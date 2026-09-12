# Google model provider implementation

The model router has an injected provider interface. OpenRouter remains the default for the running app. `createVertexModelProvider({ project, location })`, exported from `@assistant/core/model-router`, constructs an opt-in Google Vertex adapter for a customer project. Construction makes no model request.

The Vertex adapter uses Application Default Credentials or the deployed service identity. It explicitly disables the SDK's `GOOGLE_VERTEX_API_KEY` fallback, so an environment API key cannot silently select Express mode. No publisher credential is needed by this adapter. Actual calls still require customer IAM, model access, quota, and billing.

## Model identity and accounting

Vertex model IDs must be explicitly qualified, such as `vertex:MODEL_ID`, with a bare model slug after the prefix. The adapter removes that prefix for the Vertex SDK. OpenRouter IDs such as `google/gemini-*` stay on OpenRouter; the router does not silently cross providers on fallback. Primary, fallback, override, and embedding model records must all belong to the selected provider.

Routing still requires explicit enabled model records and configured cost rates. The factory does not discover models, invent prices, seed role mappings, or activate Vertex in application composition. Those steps remain separate from this adapter.

When a successful call supplies complete token usage, metering uses provider-reported cost where supported or the configured rates. Missing or partial usage uses the positive preflight estimate and marks the ledger description as estimated. It does not refund a paid successful call as zero merely because usage was omitted. Explicit authoritative zero cost remains valid. Vertex request IDs are not written into the OpenRouter-specific generation-ID column. A provider-neutral generation-ID schema remains future work.

The adapter requests 1536-dimensional embeddings, matching the current persistence format. The router rejects incorrect vector counts, dimensions, sparse arrays, and non-finite values after accounting for completed provider responses. It observes individual embedding calls before SDK validation and sums their usage and authoritative costs. If a batch fails, it stops queued work and waits for already-started calls so late results remain accounted for. A rejection before any provider response releases the reservation. It never pads or truncates vectors. A model that cannot provide the requested dimension must be rejected during live feasibility checks.

## Verification and activation gates

Offline tests use mocked SDK calls and the actual embedding SDK with fake model responses to exercise model identity, provider options, embedding settings, abort forwarding, invalid responses, concurrent batch failure, and accounting. Streaming terminal callbacks run once across finish/error/abort races. Structured-output errors carrying provider usage are metered before retry handling. These tests do not prove live credentials, model availability, pricing, streaming/tool behavior on Google, or quality parity. The implementation follows the [AI SDK Vertex provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-vertex).

Before activation, configure provider-specific model/role/rate records, finish runtime composition and configuration validation, and run authenticated text, streaming, tool, structured-output, embedding, and budget checks. The consumer installer must complete these checks before enabling autonomous work.
