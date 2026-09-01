import { type Db, type ScheduleRow, schedules, type TaskRow } from '@assistant/db';
import { and, eq, sql } from 'drizzle-orm';
import { getOrCreateNotificationsConversation, persistMessage } from '../chat.js';
import { loadConfig } from '../config.js';
import type { ModelRouter } from '../model-router/router.js';
import { curiositySummary, runCuriosity } from '../proactive/curiosity.js';
import type { ProactiveNotifier } from '../proactive/notify.js';
import { pingOwner } from '../proactive/notify.js';
import { pulseSummary, runPulse } from '../proactive/pulse.js';
import { runAnomalyScan } from '../workflow/anomaly.js';
import { type BriefingCalendarReader, briefingSummary, runBriefing } from '../workflow/briefing.js';
import { runDream } from '../workflow/dream.js';
import { runAssistantHealthMonitor } from '../workflow/health-monitor.js';
import { runSelfImprove } from '../workflow/improve.js';
import { runSelfMaintenance } from '../workflow/self-maintenance.js';
import { runWatchSuggest } from '../workflow/watch-suggest.js';
import { refreshAmbientSnapshot } from './ambient.js';
import { extractCommitments, markStaleCommitments } from './commitments.js';
import { runMemoryConsolidation } from './consolidation.js';
import { type DocumentProcessorConfig, runDocumentProcessing } from './document-processor.js';
import { runDocumentExtraction } from './documents.js';
import { pendingEmailExtractionCount, runEmailIngestExtraction } from './email-extraction.js';
import { runMemoryExtraction } from './extraction.js';
import { runImportJob, type WorkspaceReader } from './import.js';
import {
  backfillKnowledgeGraphDates,
  countRelativeDateSources,
  graphSyncSpendUsd,
  pendingKnowledgeGraphSourceCount,
  syncKnowledgeGraph,
} from './knowledge-graph.js';
import { segmentConversations } from './segmentation.js';
import { runSkillReflection } from './skill-reflect.js';
import { runVoiceIngest } from './voice-ingest.js';

/**
 * Code jobs: tasks whose trigger payload carries { job: '<name>' } run a
 * registered function instead of the model step loop. Costs still meter to
 * the task (model/embed calls pass taskId), failures go through the normal
 * retry/dead-letter machinery, and a job may yield (done: false) to sleep
 * and resume from its checkpoint — that's how imports survive interruption.
 */
export type CodeJobName =
  | 'memory.extract'
  | 'email.extract'
  | 'reminder.notify'
  | 'briefing.compose'
  | 'memory.consolidate'
  | 'memory.graph_sync'
  | 'memory.graph_date_backfill'
  | 'chat.segment'
  | 'import.run'
  | 'voice.ingest'
  | 'anomaly.scan'
  | 'skill.reflect'
  | 'self.improve'
  | 'documents.extract'
  | 'documents.process'
  | 'ambient.refresh'
  | 'dream.run'
  | 'self.maintain'
  | 'health.monitor'
  | 'watch.suggest'
  | 'pulse.check'
  | 'graph.curiosity';

const CODE_JOBS: ReadonlySet<string> = new Set([
  'memory.extract',
  'email.extract',
  'reminder.notify',
  'briefing.compose',
  'memory.consolidate',
  'memory.graph_sync',
  'memory.graph_date_backfill',
  'chat.segment',
  'import.run',
  'voice.ingest',
  'anomaly.scan',
  'skill.reflect',
  'self.improve',
  'documents.extract',
  'documents.process',
  'ambient.refresh',
  'dream.run',
  'self.maintain',
  'health.monitor',
  'watch.suggest',
  'pulse.check',
  'graph.curiosity',
]);

/**
 * Feature-gated jobs remain registered so schedules can safely be seeded in
 * every environment. The scheduler advances a disabled job without creating
 * task rows, and a manually queued job completes without provider work.
 */
export function isCodeJobEnabled(job: string): boolean {
  // Everything that reads or writes the knowledge graph rides the same switch —
  // curiosity included, since a graph that is turned off has no gaps to ask
  // about and would otherwise produce a question built on nothing.
  const needsGraph = job.startsWith('memory.graph_') || job.startsWith('graph.');
  return !needsGraph || loadConfig().GRAPH_RAG_ENABLED;
}

export interface CodeJobOutcome {
  done: boolean;
  runAfter?: Date;
  summary: string;
}

export function codeJobName(task: TaskRow): CodeJobName | null {
  const payload = (task.trigger as { payload?: { job?: unknown } } | null)?.payload;
  const job = typeof payload?.job === 'string' ? payload.job : null;
  return job && CODE_JOBS.has(job) ? (job as CodeJobName) : null;
}

export async function runCodeJob(
  deps: {
    db: Db;
    router: ModelRouter;
    workspace?: WorkspaceReader;
    documentProcessor?: DocumentProcessorConfig;
    /**
     * Calendar read for the briefing, injected by the composition root when
     * the google module is installed (core holds no provider credentials).
     */
    calendarReader?: BriefingCalendarReader;
    /**
     * The phone leg for proactive jobs, injected by the composition root.
     * Without it a job still posts its dashboard copy — the owner just has to
     * open the app to find it, which is exactly the silence this exists to fix.
     */
    notifyOwner?: ProactiveNotifier;
    heartbeat?: () => Promise<void>;
    /**
     * Supplied by the composition root: returns a completion summary when the
     * module owning this job is not installed. A job queued before its module
     * was removed then completes benignly instead of dead-lettering. Core does
     * not know which module owns which job.
     */
    jobUnavailable?: (job: CodeJobName) => string | null;
  },
  job: CodeJobName,
  task: TaskRow,
): Promise<CodeJobOutcome> {
  const unavailable = deps.jobUnavailable?.(job);
  if (unavailable) return { done: true, summary: unavailable };
  switch (job) {
    case 'reminder.notify': {
      const payload = (
        task.trigger as {
          payload?: {
            reminderText?: unknown;
            instruction?: unknown;
            reminderKind?: unknown;
            scheduleId?: unknown;
            schedule?: unknown;
          };
        } | null
      )?.payload;
      const reminderText =
        typeof payload?.reminderText === 'string' && payload.reminderText.trim()
          ? payload.reminderText.trim()
          : typeof payload?.instruction === 'string'
            ? payload.instruction
                .replace(/^Reminder for the owner:\s*/i, '')
                .split(/\n\n/)[0]
                ?.trim()
            : '';
      if (!reminderText) {
        return { done: true, summary: 'reminder: missing reminder text' };
      }
      const scheduleId = typeof payload?.scheduleId === 'string' ? payload.scheduleId : null;
      const scheduleName = typeof payload?.schedule === 'string' ? payload.schedule : null;
      const managedSchedule = Boolean(scheduleId || scheduleName?.startsWith('reminder:'));
      const [initialSchedule] = managedSchedule
        ? await deps.db
            .select()
            .from(schedules)
            .where(
              and(
                eq(schedules.agentId, task.agentId),
                scheduleId
                  ? eq(schedules.id, scheduleId)
                  : eq(schedules.name, scheduleName as string),
              ),
            )
            .limit(1)
        : [undefined];
      if (managedSchedule && !initialSchedule) {
        return { done: true, summary: 'reminder: cancelled before delivery' };
      }

      const deliver = async (database: Db, schedule?: ScheduleRow): Promise<CodeJobOutcome> => {
        const template = (schedule?.taskTemplate ?? {}) as {
          reminderKind?: 'once' | 'recurring';
          reminderCancelledAt?: string;
          reminderDeliveredAt?: string;
        };
        if (
          template.reminderCancelledAt ||
          template.reminderDeliveredAt ||
          (schedule && template.reminderKind !== 'once' && !schedule.enabled)
        ) {
          return { done: true, summary: 'reminder: cancelled before delivery' };
        }
        const conversationId =
          task.conversationId ??
          (await getOrCreateNotificationsConversation(database, task.agentId));
        await persistMessage(database, {
          conversationId,
          taskId: task.id,
          role: 'assistant',
          origin: 'assistant',
          parts: [{ type: 'text', text: reminderText }],
          text: reminderText,
        });
        const pinged = await pingOwner(deps.notifyOwner, {
          taskId: task.id,
          conversationId,
          text: reminderText,
        });
        if (schedule && template.reminderKind === 'once') {
          await database
            .update(schedules)
            .set({
              taskTemplate: { ...template, reminderDeliveredAt: new Date().toISOString() },
              updatedAt: sql`now()`,
            })
            .where(eq(schedules.id, schedule.id));
        }
        return {
          done: true,
          summary: `reminder: delivered${pinged ? ' and pinged' : ''}`,
        };
      };

      if (!initialSchedule) return deliver(deps.db);
      return deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${initialSchedule.id}))`);
        const [lockedSchedule] = await tx
          .select()
          .from(schedules)
          .where(eq(schedules.id, initialSchedule.id))
          .limit(1);
        if (!lockedSchedule) {
          return { done: true, summary: 'reminder: cancelled before delivery' };
        }
        return deliver(tx as unknown as Db, lockedSchedule);
      });
    }
    case 'memory.extract': {
      await deps.heartbeat?.();
      const r = await runMemoryExtraction(deps, { taskId: task.id });
      const loops = await extractCommitments(deps, { agentId: task.agentId, taskId: task.id });
      await markStaleCommitments(
        deps.db,
        task.agentId,
        new Date(Date.now() - 90 * 24 * 3600 * 1000),
      );
      return {
        done: true,
        summary: `extraction: ${r.saved} saved (${r.quarantined} quarantined, ${r.contactsCreated} new people), ${r.duplicates} duplicate, ${r.tombstoned} tombstoned, ${r.occasionsSaved} occasion(s), from ${r.conversationsScanned} conversation(s); open loops ${loops.saved} saved (${loops.duplicates} duplicate)`,
      };
    }
    case 'email.extract': {
      await deps.heartbeat?.();
      const r = await runEmailIngestExtraction(deps, { taskId: task.id });
      const pending = await pendingEmailExtractionCount(deps.db);
      return {
        // A backlog drains across runs rather than in one long job: report it
        // so a mailbox that is falling behind is visible in the task summary.
        done: true,
        summary:
          `email extraction: ${r.saved} saved (${r.usable} recallable, ${r.quarantined} awaiting review), ` +
          `${r.duplicates} duplicate, ${r.occasionsSaved} occasion(s), from ${r.rowsVisited} message(s) ` +
          `(${r.skippedLowImportance} routine), ${pending} still pending`,
      };
    }
    case 'graph.curiosity': {
      if (!isCodeJobEnabled(job)) {
        return { done: true, summary: 'curiosity: knowledge graph disabled' };
      }
      await deps.heartbeat?.();
      return {
        done: true,
        summary: curiositySummary(await runCuriosity(deps, { taskId: task.id })),
      };
    }
    case 'pulse.check': {
      await deps.heartbeat?.();
      return { done: true, summary: pulseSummary(await runPulse(deps, { taskId: task.id })) };
    }
    case 'briefing.compose': {
      await deps.heartbeat?.();
      return { done: true, summary: briefingSummary(await runBriefing(deps, { taskId: task.id })) };
    }
    case 'memory.consolidate': {
      await deps.heartbeat?.();
      const r = await runMemoryConsolidation(deps, { taskId: task.id, agentId: task.agentId });
      return {
        done: true,
        summary: `consolidation: ${r.memoriesReviewed + r.standaloneReviewed} memories reviewed in ${r.batches} batch(es) across ${r.entities} people, ${r.duplicatesExpired} duplicates expired, ${r.contradictionsResolved} contradictions resolved, ${r.factsUnified} facts unified, ${r.domainsAssigned} domains assigned, ${r.occasionsSaved} occasion(s) found, owner card recompiled`,
      };
    }
    case 'memory.graph_sync': {
      if (!isCodeJobEnabled(job)) {
        return { done: true, summary: 'knowledge graph: disabled' };
      }
      await deps.heartbeat?.();
      const r = await syncKnowledgeGraph(deps, {
        taskId: task.id,
        agentId: task.agentId,
        heartbeat: deps.heartbeat,
      });
      const [pending, spentUsd] = await Promise.all([
        pendingKnowledgeGraphSourceCount(deps.db, task.agentId),
        graphSyncSpendUsd(deps.db, task.id),
      ]);
      return {
        done: true,
        summary:
          `knowledge graph: ${r.relationships} relation(s) from ${r.processed}/${r.candidates} source(s), ` +
          `${r.failed} retrying, ${r.quarantined} quarantined, ${pending} pending, ` +
          `$${spentUsd.toFixed(4)} spent`,
      };
    }
    // Deliberately free: it re-reads labels the graph already holds and never
    // calls a model, so it can run over the whole corpus in one go. Sources it
    // cannot fix are only counted — paying to re-extract them stays the owner's
    // explicit choice, made from the review page.
    case 'memory.graph_date_backfill': {
      if (!isCodeJobEnabled(job)) {
        return { done: true, summary: 'knowledge graph dates: disabled' };
      }
      await deps.heartbeat?.();
      const r = await backfillKnowledgeGraphDates(deps.db, { agentId: task.agentId });
      const remaining = await countRelativeDateSources(deps.db, task.agentId);
      return {
        done: true,
        summary:
          `knowledge graph dates: ${r.canonicalized} canonicalized, ${r.merged} merged, ` +
          `${r.unresolved} unresolved of ${r.scanned} scanned, ` +
          `${remaining} source(s) would need re-extraction`,
      };
    }
    case 'chat.segment': {
      await deps.heartbeat?.();
      const r = await segmentConversations(deps, { taskId: task.id, agentId: task.agentId });
      return {
        done: true,
        summary: `segmentation: ${r.segmentsCreated} new segment(s) across ${r.conversationsScanned} conversation(s)`,
      };
    }
    case 'import.run':
      return runImportJob(deps, task);
    case 'voice.ingest':
      return runVoiceIngest(deps, task);
    case 'anomaly.scan': {
      await deps.heartbeat?.();
      const r = await runAnomalyScan(deps, { agentId: task.agentId, taskId: task.id });
      const kinds = Object.entries(r.byKind)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      return {
        done: true,
        summary: `anomaly scan: ${r.flagged} new anomal${r.flagged === 1 ? 'y' : 'ies'}${kinds ? ` (${kinds})` : ''}`,
      };
    }
    case 'skill.reflect': {
      await deps.heartbeat?.();
      const r = await runSkillReflection(deps, { taskId: task.id });
      return {
        done: true,
        summary: `skill reflection: ${r.skillsDrafted} skill(s) drafted from ${r.tasksReviewed} reviewed task(s)`,
      };
    }
    case 'self.improve': {
      await deps.heartbeat?.();
      const r = await runSelfImprove(deps, { agentId: task.agentId, taskId: task.id });
      return {
        done: true,
        summary: `self-improve: ${r.proposalsDrafted} proposal(s) from ${r.patterns} failure pattern(s)${r.experienceSaved ? ', experience saved' : ''}`,
      };
    }
    case 'documents.extract':
      return runDocumentExtraction(deps, task);
    case 'documents.process':
      return runDocumentProcessing(
        {
          db: deps.db,
          documentProcessor: deps.documentProcessor,
          heartbeat: deps.heartbeat,
        },
        task,
      );
    case 'ambient.refresh': {
      await deps.heartbeat?.();
      const r = await refreshAmbientSnapshot(
        { db: deps.db, heartbeat: deps.heartbeat },
        { agentId: task.agentId },
      );
      return {
        done: true,
        summary: r.computed
          ? `ambient: refreshed (location${r.hasWeather ? ' + weather' : ', no weather'})`
          : 'ambient: no fresh location — snapshot cleared',
      };
    }
    case 'dream.run': {
      await deps.heartbeat?.();
      const r = await runDream(deps, { agentId: task.agentId, taskId: task.id });
      return {
        done: true,
        summary: `dream: ${r.footnotes} footnote(s), ${r.hypotheses} hypothesis(es), ${r.anticipations} anticipation(s)`,
      };
    }
    case 'self.maintain': {
      await deps.heartbeat?.();
      const r = await runSelfMaintenance(deps, { agentId: task.agentId, taskId: task.id });
      return {
        done: true,
        summary: `self-maintain: ${r.backlog} backlog item(s), ${r.blocked} blocked by the fence`,
      };
    }
    case 'health.monitor': {
      await deps.heartbeat?.();
      const r = await runAssistantHealthMonitor(
        { db: deps.db, heartbeat: deps.heartbeat },
        { agentId: task.agentId, taskId: task.id },
      );
      return {
        done: true,
        summary: r.notified
          ? `health monitor: notified owner about ${r.signals.length} signal(s)`
          : 'health monitor: no active signals',
      };
    }
    case 'watch.suggest': {
      await deps.heartbeat?.();
      const payload = (
        task.trigger as { payload?: { watchId?: unknown; triggerRef?: unknown } } | null
      )?.payload;
      if (typeof payload?.watchId !== 'string' || typeof payload?.triggerRef !== 'string') {
        return { done: true, summary: 'watch.suggest: malformed payload' };
      }
      const r = await runWatchSuggest(
        { db: deps.db, router: deps.router, heartbeat: deps.heartbeat },
        { taskId: task.id, watchId: payload.watchId, triggerRef: payload.triggerRef },
      );
      return { done: true, summary: r.summary };
    }
  }
}
