import { type AssistantModule, isModuleEnabled } from '@assistant/config';
import {
  type InboundEmailObserver,
  type ModuleChannel,
  type ModuleDefinition,
  type ModuleInternalHandler,
  type ModulePlatformContext,
  type ModuleSweepStep,
  type ModuleTaskHandler,
  type ModuleTick,
  type ModuleWebhookHandler,
  noopOwnerNotifier,
  type OwnerNotifier,
} from './platform.js';

export interface InstalledModuleSet {
  /** Modules that were installed, in composition order. */
  installed: readonly AssistantModule[];
  /**
   * What an installed module produced, or undefined when it is absent or
   * produced nothing.
   */
  exportsOf<Exports>(definition: ModuleDefinition<Exports>): Exports | undefined;
  /**
   * Like `exportsOf`, but for modules declaring an `absent` null object, so the
   * caller always gets a value. Throws when a module declares neither — that is
   * a composition mistake, and failing at boot beats an undefined field
   * surfacing somewhere later.
   */
  requireExports<Exports>(definition: ModuleDefinition<Exports>): Exports;
  /**
   * A completion summary when this code job belongs to a module that is not
   * installed, otherwise null. Jobs queued before a module was removed then
   * complete benignly instead of dead-lettering.
   */
  jobUnavailable(job: string): string | null;
  /**
   * A failure message when this task type's owner-facing delivery channel
   * belongs to a module that is not installed, otherwise null. The executor
   * throws it instead of completing the task with the answer undelivered.
   */
  channelUnavailable(taskType: string): string | null;
  /**
   * A message when this deterministic task kind belongs to a module that is not
   * installed, otherwise null. Lets a queued task complete benignly instead of
   * falling through to the general model executor.
   */
  taskKindUnavailable(kind: string): string | null;
  /** Runtime handler for an installed module's webhook path, if any. */
  webhookHandler(path: string): ModuleWebhookHandler | undefined;
  /** Runtime handler for an installed module's internal route, if any. */
  internalHandler(path: string): ModuleInternalHandler | undefined;
  /** Sweep steps of installed modules, in composition order. */
  readonly sweepSteps: readonly ModuleSweepStep[];
  /** Poller ticks of installed modules, in composition order. */
  readonly ticks: readonly ModuleTick[];
  /** Deterministic task handler for a trigger payload kind, if any. */
  taskHandlerFor(kind: string): ModuleTaskHandler | undefined;
  /** Delivery channels of installed modules, in composition order. */
  readonly channels: readonly ModuleChannel[];
  /** Fans out to every installed notifier; a no-op when none is installed. */
  readonly ownerNotifier: OwnerNotifier;
  /** Inbound-email observers of installed modules, in composition order. */
  readonly emailObservers: readonly InboundEmailObserver[];
}

/**
 * Install the modules this installation composes and configures.
 *
 * This is the sole feature-composition point: a module registers its tools on
 * the shared registry — the only path into the risk-gated dispatcher — and
 * returns whatever the composition root needs to hold onto.
 */
export function installModules(
  definitions: readonly ModuleDefinition<unknown>[],
  context: ModulePlatformContext,
): InstalledModuleSet {
  const installed: AssistantModule[] = [];
  const exports = new Map<ModuleDefinition<unknown>, unknown>();
  const jobOwners = new Map<string, AssistantModule>();
  const channelOwners = new Map<string, AssistantModule>();
  const taskKindOwners = new Map<string, AssistantModule>();
  const webhookHandlers = new Map<string, ModuleWebhookHandler>();
  const internalHandlers = new Map<string, ModuleInternalHandler>();
  const taskHandlers = new Map<string, ModuleTaskHandler>();
  const sweepSteps: ModuleSweepStep[] = [];
  const ticks: ModuleTick[] = [];
  const channels: ModuleChannel[] = [];
  const notifiers: OwnerNotifier[] = [];
  const emailObservers: InboundEmailObserver[] = [];

  // Composition mistakes must fail at boot, not surface later as a silent 404
  // on a production webhook or a task kind nobody claims.
  const claim = <Value>(map: Map<string, Value>, key: string, value: Value, what: string) => {
    if (map.has(key)) throw new Error(`two installed modules both declare ${what} ${key}`);
    map.set(key, value);
  };

  for (const definition of definitions) {
    // Job and delivery-channel ownership is recorded for every composed module,
    // installed or not, so an owner-facing task whose owning module is disabled
    // is still recognised (and fails loudly) rather than silently undelivered.
    for (const job of definition.meta.jobs ?? []) jobOwners.set(job, definition.meta.name);
    for (const type of definition.meta.deliversTaskTypes ?? []) {
      channelOwners.set(type, definition.meta.name);
    }
    for (const kind of definition.meta.taskKinds ?? []) {
      taskKindOwners.set(kind, definition.meta.name);
    }
    if (!isModuleEnabled(context.config, definition.meta.name)) continue;
    installed.push(definition.meta.name);
    const runtime = definition.create(context);
    if (runtime.exports !== undefined) exports.set(definition, runtime.exports);

    const hooks = runtime.hooks ?? {};
    for (const route of hooks.webhooks ?? []) {
      claim(webhookHandlers, route.path, route.handler, 'webhook');
    }
    for (const route of hooks.internalRoutes ?? []) {
      claim(internalHandlers, route.path, route.handler, 'internal route');
    }
    for (const handler of hooks.taskHandlers ?? []) {
      claim(taskHandlers, handler.kind, handler, 'task kind');
    }
    sweepSteps.push(...(hooks.sweepSteps ?? []));
    ticks.push(...(hooks.ticks ?? []));
    if (hooks.channel) channels.push(hooks.channel);
    if (hooks.ownerNotifier) notifiers.push(hooks.ownerNotifier);
    emailObservers.push(...(hooks.emailObservers ?? []));

    // The meta declares routes as plain data for deployment and docs; the
    // runtime provides the handlers. They must agree exactly — a declared
    // route with no handler would 404 in production while auth tests pass.
    const meta = definition.meta;
    const declaredWebhooks = new Set((meta.webhooks ?? []).map((route) => route.path));
    const runtimeWebhooks = new Set((hooks.webhooks ?? []).map((route) => route.path));
    const declaredInternal = new Set((meta.internalRoutes ?? []).map((route) => route.path));
    const runtimeInternal = new Set((hooks.internalRoutes ?? []).map((route) => route.path));
    for (const path of declaredWebhooks) {
      if (!runtimeWebhooks.has(path))
        throw new Error(`the ${meta.name} module declares webhook ${path} but returns no handler`);
    }
    for (const path of runtimeWebhooks) {
      if (!declaredWebhooks.has(path))
        throw new Error(
          `the ${meta.name} module handles webhook ${path} without declaring it in meta.webhooks`,
        );
    }
    for (const path of declaredInternal) {
      if (!runtimeInternal.has(path))
        throw new Error(
          `the ${meta.name} module declares internal route ${path} but returns no handler`,
        );
    }
    for (const path of runtimeInternal) {
      if (!declaredInternal.has(path))
        throw new Error(
          `the ${meta.name} module handles internal route ${path} without declaring it in meta.internalRoutes`,
        );
    }
  }

  // Configuration selects among what the build composes; it cannot add to it.
  // Saying so beats a module that silently never starts.
  const composed = new Set(definitions.map((definition) => definition.meta.name));
  for (const name of context.config.ASSISTANT_MODULES) {
    if (composed.has(name)) continue;
    console.warn(
      `ASSISTANT_MODULES names "${name}", which this build does not contain — add it to assistant.config.ts and rebuild`,
    );
  }

  const exportsOf = <Exports>(definition: ModuleDefinition<Exports>) =>
    exports.get(definition as ModuleDefinition<unknown>) as Exports | undefined;

  return {
    installed,
    exportsOf,
    requireExports: (definition) => {
      const produced = exportsOf(definition);
      if (produced !== undefined) return produced;
      const absent = definition.absent?.();
      if (absent !== undefined) return absent;
      throw new Error(
        `the ${definition.meta.name} module produced no exports and declares no absent value`,
      );
    },
    jobUnavailable: (job) => {
      const owner = jobOwners.get(job);
      if (!owner || installed.includes(owner)) return null;
      return `${job} skipped because the ${owner} module is disabled`;
    },
    channelUnavailable: (taskType) => {
      const owner = channelOwners.get(taskType);
      if (!owner || installed.includes(owner)) return null;
      return `${taskType} cannot be delivered because the ${owner} module is not installed`;
    },
    taskKindUnavailable: (kind) => {
      const owner = taskKindOwners.get(kind);
      if (!owner || installed.includes(owner)) return null;
      return `${kind} skipped because the ${owner} module is not installed`;
    },
    webhookHandler: (path) => webhookHandlers.get(path),
    internalHandler: (path) => internalHandlers.get(path),
    sweepSteps,
    ticks,
    taskHandlerFor: (kind) => taskHandlers.get(kind),
    channels,
    ownerNotifier:
      notifiers.length === 0
        ? noopOwnerNotifier
        : {
            notifyOwner: async (input) => {
              for (const notifier of notifiers) await notifier.notifyOwner(input);
            },
            notifyApprovals: async (approvals) => {
              for (const notifier of notifiers) await notifier.notifyApprovals(approvals);
            },
          },
    emailObservers,
  };
}
