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
application composition        modules ──► provider tools
        │                         │
        ├─────────────────────────┘
        ▼
business core ◄──────── ports
        │
        ▼
database adapter

configuration is read at composition boundaries and by infrastructure adapters
```

## Workspace packages

### `@assistant/config`

Owns the environment schema, defaults, module parser, and platform production validation. It has no
workspace dependencies and knows no individual module: readiness and module-specific production
rules live with each module. New settings must be added here and to `.env.example`; apps should not
invent their own service variables.

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

### `@assistant/modules`

Owns the module contract and every module. `src/kit.ts` and `src/runtime-kit.ts` define what a
module is; each `src/<name>/` directory holds that module's metadata and its factory. Metadata is
plain data — name, owned settings, readiness, production rules, infrastructure, billing,
navigation, and code jobs — so the web app, deployment scripts, and diagnostics import
`@assistant/modules/meta` without pulling provider code into their bundles. It may depend on
config, core, db, and tools, and nothing may depend on it except the agent composition root and
metadata consumers.

### `@assistant/agent`

This is the composition root. `src/deps.ts` creates shared infrastructure and calls
`installModules`, which installs only the capabilities named by `ASSISTANT_MODULES`. HTTP routes
authenticate and translate requests; they should not contain business policy.

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
- a web file imports module runtime code instead of `@assistant/modules/meta`;
- any web file outside the server composition root bypasses `@assistant/application`;
- config depends on another workspace package;
- db depends on core/tools/apps;
- core depends on tools/apps;
- application depends on tools/apps or leaks persistence into migrated UI features;
- tools acquires an unsupported workspace dependency;
- modules acquires a workspace dependency outside config, core, db, and tools.

The check runs as part of `pnpm lint` and CI.

## Composition

`assistant.config.ts` at the repository root declares what an installation is made of:

```ts
export default defineAssistant({
  modules: [googleModule, searchModule, remindersModule],
});
```

The agent imports it, so it is the one file to edit when adding or removing a capability, and
`pnpm modules:plan` derives the worker images, infrastructure, and billing from it. It is agent
source despite living at the root: `infra/docker/agent.Dockerfile` copies it into the build, and
`pnpm check:boundaries` fails if that COPY is ever dropped.

`ASSISTANT_MODULES` narrows the composition at runtime for a container that should start with less
than it was built with. It cannot widen it — a module absent from the file has no definition to
install, and naming it in the environment logs a warning rather than silently doing nothing.

## Adding a module

1. Add the module name to `packages/config/src/modules.ts` and any new settings to the central
   schema and `.env.example`.
2. Create `packages/modules/src/<name>/meta.ts` declaring the settings it owns, its readiness
   check, any production rules, its infrastructure, its billing, and any code jobs it owns.
3. Create `packages/modules/src/<name>/module.ts` with `defineModule`, registering its tools on
   the registry it is handed and returning whatever the composition root must hold onto.
4. Add its metadata to `assistantModuleMetas` in `packages/modules/src/meta.ts`, export the
   definition from `packages/modules/src/runtime.ts`, and add it to `assistant.config.ts`.
5. Document its credentials, infrastructure, side effects, and removal behavior.

Nothing else changes: readiness diagnostics, production validation, navigation, worker image
selection, and the deployment plan are all derived from metadata. No module should require a
conditional inside the planner or business workflow — a module that owns code jobs declares them
in metadata so a job queued before the module was removed completes benignly. Absence from the
tool registry is the capability boundary.

## Configuration lifecycle

`.env` is the local source and is never committed. Cloud deployments copy sensitive values into
Secret Manager and non-sensitive values into the Cloud Run revision environment. Both surfaces use
the exact schema names from `@assistant/config`.

`loadConfig()` validates once and caches per process. Tests call `resetConfigForTest()` when they
need a different environment. Production starts fail-fast only for settings that would make a cloud
runtime broken; optional providers may stay unavailable and are reported by `pnpm config:check`.
