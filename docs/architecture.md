# Platform architecture

## Design goals

The platform follows four rules:

1. Presentation receives serializable view data and does not know about persistence or providers.
2. Business rules live in `packages/core`; HTTP, Next.js, PostgreSQL, and provider APIs are adapters.
3. Every process reads the same typed configuration contract from `packages/config`.
4. Optional functionality is composed at the agent edge and can be disabled without editing core.

The dependency direction is inward:

```text
presentation / HTTP
        │
        ▼
application composition
        │
        ├──────────────► provider tools
        ▼
business core ◄──────── ports
        │
        ▼
database adapter

configuration is read at composition boundaries and by infrastructure adapters
```

## Workspace packages

### `@assistant/config`

Owns the environment schema, defaults, module parser, production validation, and secret-safe
diagnostics. It has no workspace dependencies. New settings must be added here and to `.env.example`;
apps should not invent their own service variables.

### `@assistant/db`

Owns Drizzle schemas, entities, migrations, and seed reconciliation. It depends only on config and
third-party persistence libraries. Seed identity now comes from the central configuration contract.

### `@assistant/core`

Owns workflows, approvals, memory, missions, schedules, costs, model routing, and domain policies.
It may depend on config and database ports/adapters, but never on apps or provider tools.

Some core functions still use the concrete Drizzle adapter. Replacing those imports with repository
ports is a safe incremental migration; it is not required to add a new UI or provider.

### `@assistant/application`

Owns UI-facing use cases and serializable view models. It composes core workflows with database
queries so presentation code asks for a chat view, import overview, approval inbox, or dashboard
presence rather than assembling tables, joins, and policy decisions. Large features are separated
into query and command modules.

### `@assistant/tools`

Owns the tool registry, risk dispatcher, storage adapters, and provider capabilities. It may depend
on core contracts and the database. Provider-specific installation does not happen here; functions
only register a capability when called by the agent composition root.

### `@assistant/agent`

This is the composition root. `src/deps.ts` creates shared infrastructure, while `src/modules.ts`
installs only the capabilities named by `ASSISTANT_MODULES`. HTTP routes authenticate and translate
requests; they should not contain business policy.

### `@assistant/web`

Next.js is a presentation and HTTP adapter. Client components accept serializable props and invoke
server actions. Pages, actions, and routes call a bound application facade; only
`apps/web/lib/server.ts` may import concrete database, model-router, and workspace adapters.

### `workers/*`

Browser, code, and document processing are independent deployable packages. They receive bounded job
input and never import the agent, web app, database package, or provider clients.

## Enforced boundaries

`pnpm check:boundaries` fails when:

- a client UI component imports server/business infrastructure;
- any web file outside the server composition root bypasses `@assistant/application`;
- config depends on another workspace package;
- db depends on core/tools/apps;
- core depends on tools/apps;
- application depends on tools/apps or leaks persistence into migrated UI features;
- tools acquires an unsupported workspace dependency.

The check runs as part of `pnpm lint` and CI.

## Adding a module

1. Put provider/worker behavior behind a registration function and narrow dependency interface.
2. Add the module name to `packages/config/src/modules.ts`.
3. Add its settings to the central schema and `.env.example`.
4. Install it from `apps/agent/src/modules.ts` only when selected.
5. Gate its webhook and background entry points with the same module flag.
6. Add a diagnostic that reports readiness without printing secrets.
7. Document its credentials, infrastructure, side effects, and removal behavior.

No module should require a conditional inside the planner or business workflow. Absence from the
tool registry is the capability boundary.

## Configuration lifecycle

`.env` is the local source and is never committed. Cloud deployments copy sensitive values into
Secret Manager and non-sensitive values into the Cloud Run revision environment. Both surfaces use
the exact schema names from `@assistant/config`.

`loadConfig()` validates once and caches per process. Tests call `resetConfigForTest()` when they
need a different environment. Production starts fail-fast only for settings that would make a cloud
runtime broken; optional providers may stay unavailable and are reported by `pnpm config:check`.
