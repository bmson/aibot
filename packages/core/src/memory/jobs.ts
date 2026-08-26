import type { Db, TaskRow } from '@assistant/db';
import { loadConfig } from '../config.js';
import type { ModelRouter } from '../model-router/router.js';
import { runAnomalyScan } from '../workflow/anomaly.js';
import { type BriefingCalendarReader, briefingSummary, runBriefing } from '../workflow/briefing.js';
import { runDream } from '../workflow/dream.js';
import { runAssistantHealthMonitor } from '../workflow/health-monitor.js';
import { runSelfImprove } from '../workflow/improve.js';
import { runSelfMaintenance } from '../workflow/self-maintenance.js';
import { runWatchSuggest } from '../workflow/watch-suggest.js';
import { refreshAmbientSnapshot } from './ambient.js';
import { runMemoryConsolidation } from './consolidation.js';
import { type DocumentProcessorConfig, runDocumentProcessing } from './document-processor.js';
import { runDocumentExtraction } from './documents.js';
import { pendingEmailExtractionCount, runEmailIngestExtraction } from './email-extraction.js';
import { runMemoryExtraction } from './extraction.js';
import { runImportJob, type WorkspaceReader } from './import.js';
import { pendingKnowledgeGraphSourceCount, syncKnowledgeGraph } from './knowledge-graph.js';
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
  | 'briefing.compose'
  | 'memory.consolidate'
  | 'memory.graph_sync'
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
  | 'watch.suggest';

const CODE_JOBS: ReadonlySet<string> = new Set([
  'memory.extract',
  'email.extract',
  'briefing.compose',
  'memory.consolidate',
  'memory.graph_sync',
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
]);

/**
 * Feature-gated jobs remain registered so schedules can safely be seeded in
 * every environment. The scheduler advances a disabled job without creating
 * task rows, and a manually queued job completes without provider work.
 */
export function isCodeJobEnabled(job: string): boolean {
  return job !== 'memory.graph_sync' || loadConfig().GRAPH_RAG_ENABLED;
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
    case 'memory.extract': {
      await deps.heartbeat?.();
      const r = await runMemoryExtraction(deps, { taskId: task.id });
      return {
        done: true,
        summary: `extraction: ${r.saved} saved (${r.quarantined} quarantined, ${r.contactsCreated} new people), ${r.duplicates} duplicate, ${r.tombstoned} tombstoned, ${r.occasionsSaved} occasion(s), from ${r.conversationsScanned} conversation(s)`,
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
      const pending = await pendingKnowledgeGraphSourceCount(deps.db, task.agentId);
      return {
        done: true,
        summary:
          `knowledge graph: ${r.relationships} relation(s) from ${r.processed}/${r.candidates} source(s), ` +
          `${r.failed} retrying, ${r.quarantined} quarantined, ${pending} pending`,
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
