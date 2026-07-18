/**
 * Explicit owner requests for a durable Google Workspace artifact are not
 * ordinary chat replies. Once the matching tool is available, the executor
 * must ask the model for that exact tool call instead of merely hoping it
 * chooses one.
 */
export type ArtifactToolName = 'docs.create' | 'sheets.create' | 'slides.create';

export interface ArtifactIntent {
  toolName: ArtifactToolName;
  label: 'Google Doc' | 'Google Sheet' | 'Google Slides presentation';
}

/** A Google Doc URL directly supplied by the owner is an explicit read request. */
export interface DocumentReadIntent {
  toolName: 'docs.get';
  documentId: string;
}

/** Valid creation arguments built from an explicit owner request, never model prose. */
export type DirectArtifactArgs =
  | { toolName: 'docs.create'; args: { title: string; content: string } }
  | { toolName: 'sheets.create'; args: { title: string; sheetName: string; rows: unknown[][] } }
  | {
      toolName: 'slides.create';
      args: { title: string; slides: Array<{ title: string; body: string }> };
    };

const CREATION_VERB =
  /\b(?:create|creating|make|making|generate|generating|write|writing|draft|drafting|build|building|prepare|preparing)\b/i;
const DOC = /\b(?:google\s+)?docs?\b|\bdocument\b/i;
const SHEET = /\b(?:google\s+)?sheets?\b|\bspreadsheet\b/i;
const SLIDES = /\b(?:google\s+)?slides?\b|\b(?:slide deck|presentation)\b/i;
const GOOGLE_DOC_URL =
  /https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{10,200})(?:[/?#][^\s]*)?/i;

function explicitTitle(text: string): string | undefined {
  const quoted = /\btitled\s+["“]([^"”]{1,300})["”]/i.exec(text)?.[1];
  if (quoted?.trim()) return quoted.trim();
  const plain = /\btitled\s+(.+?)(?=\s+(?:with|containing|for)\b|[.!?\n]|$)/i.exec(text)?.[1];
  return plain?.trim().replace(/["“”]+$/g, '') || undefined;
}

function explicitContent(text: string): string {
  const match =
    /\bwith\s+(?:this\s+)?(?:exact\s+)?content\s*:\s*([\s\S]+)$/i.exec(text) ??
    /\bcontaining\s*:\s*([\s\S]+)$/i.exec(text);
  return match?.[1]?.trim().slice(0, 100_000) ?? '';
}

/** A small, literal-only table parser for direct Google Sheet creation. */
export function spreadsheetRowsFromContent(content: string): unknown[][] {
  const lines = content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const table = lines
    .filter((line) => line.includes('|'))
    .filter((line) => !/^\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?$/.test(line))
    .map((line) =>
      line
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
  if (table.length > 0) return table.slice(0, 1_000);

  const delimiter = lines.some((line) => line.includes('\t'))
    ? '\t'
    : lines.some((line) => line.includes(','))
      ? ','
      : undefined;
  if (delimiter) {
    return lines.map((line) => line.split(delimiter).map((cell) => cell.trim())).slice(0, 1_000);
  }
  return lines.map((line) => [line]).slice(0, 1_000);
}

function spreadsheetContent(text: string): string {
  const exact = explicitContent(text);
  if (exact) return exact;
  return (
    /\b(?:with\s+)?(?:columns?|headers?|table|rows?|data)\s*:?\s*([\s\S]+)$/i
      .exec(text)?.[1]
      ?.trim() ?? ''
  );
}

/**
 * Finds a direct request to make one durable artifact. Capability questions
 * ("can it create docs?") and multi-artifact requests stay model-directed;
 * forcing one arbitrary tool in either case would be surprising.
 */
export function requestedArtifactIntent(text: string): ArtifactIntent | undefined {
  const normalized = text.trim();
  if (!CREATION_VERB.test(normalized)) return undefined;
  if (/^\s*(?:how|why)\b/i.test(normalized)) return undefined;
  if (/^\s*can\s+it\b/i.test(normalized)) return undefined;
  if (
    /\b(?:do\s+not|don't|dont)\s+(?:create|make|generate|write|draft|build|prepare)\b/i.test(
      normalized,
    )
  ) {
    return undefined;
  }

  const matches: ArtifactIntent[] = [];
  if (DOC.test(normalized)) matches.push({ toolName: 'docs.create', label: 'Google Doc' });
  if (SHEET.test(normalized)) {
    matches.push({ toolName: 'sheets.create', label: 'Google Sheet' });
  }
  if (SLIDES.test(normalized)) {
    matches.push({ toolName: 'slides.create', label: 'Google Slides presentation' });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * A bare Google Doc URL from the owner is enough authorization to read that
 * document. The executor makes this deterministic so a model cannot merely
 * promise to review a CV and then reply without attempting docs.get.
 */
export function requestedDocumentReadIntent(text: string): DocumentReadIntent | undefined {
  const documentId = GOOGLE_DOC_URL.exec(text)?.[1];
  return documentId ? { toolName: 'docs.get', documentId } : undefined;
}

export function documentReadDispatchFailure(intent: DocumentReadIntent, reason: string): string {
  return [
    "I couldn't read the shared Google Doc.",
    `${intent.toolName} did not complete: ${reason.replace(/\s+/g, ' ').slice(0, 500)}.`,
    'I cannot confirm that the document was accessed.',
  ].join(' ');
}

/**
 * Direct artifact creation is a small deterministic path for an owner who has
 * already said exactly which Google artifact to make. It cannot invent the
 * artifact type, and it uses conservative blank defaults when the owner did
 * not supply a title or body. This prevents a model declining an otherwise
 * valid tool call from turning an executable request into prose.
 */
export function directArtifactArgs(intent: ArtifactIntent, text: string): DirectArtifactArgs {
  const content = explicitContent(text);
  switch (intent.toolName) {
    case 'docs.create': {
      const title = explicitTitle(text) ?? 'Untitled document';
      return { toolName: intent.toolName, args: { title, content } };
    }
    case 'sheets.create': {
      const title = explicitTitle(text) ?? 'Untitled spreadsheet';
      return {
        toolName: intent.toolName,
        args: {
          title,
          sheetName: 'Sheet1',
          rows: spreadsheetRowsFromContent(spreadsheetContent(text)),
        },
      };
    }
    case 'slides.create': {
      const title = explicitTitle(text) ?? 'Untitled presentation';
      return {
        toolName: intent.toolName,
        args: { title, slides: [{ title, body: content }] },
      };
    }
  }
}

/** A deterministic success response follows the durable tool result. */
export function artifactCreatedResponse(intent: ArtifactIntent, result: unknown): string {
  const url =
    result &&
    typeof result === 'object' &&
    typeof (result as Record<string, unknown>).url === 'string'
      ? (result as Record<string, unknown>).url
      : undefined;
  return url
    ? `Created the requested ${intent.label}: ${url}`
    : `Created the requested ${intent.label}.`;
}

/** A direct dispatcher failure must name the failed action and never imply success. */
export function artifactDispatchFailure(intent: ArtifactIntent, reason: string): string {
  return [
    `I couldn't create the requested ${intent.label}.`,
    `${intent.toolName} did not complete: ${reason.replace(/\s+/g, ' ').slice(0, 500)}.`,
    `I cannot confirm that a ${intent.label} was created.`,
  ].join(' ');
}

export function artifactRoutingFailure(intent: ArtifactIntent): string {
  return [
    `I couldn't start the requested ${intent.label} because the action router did not invoke ${intent.toolName}.`,
    `No request was sent to Google and no ${intent.label} was created.`,
  ].join(' ');
}

export function artifactToolUnavailable(intent: ArtifactIntent): string {
  return [
    `I can't create the requested ${intent.label} because ${intent.toolName} is not available to this task.`,
    `No request was sent to Google and no ${intent.label} was created.`,
  ].join(' ');
}

interface ArtifactToolEvidence {
  toolName: string;
  status: string;
  result: unknown;
  error?: string | null;
}

function completed(evidence: ArtifactToolEvidence): boolean {
  if (evidence.status !== 'succeeded') return false;
  if (!evidence.result || typeof evidence.result !== 'object') return true;
  const result = evidence.result as Record<string, unknown>;
  return (
    result.ok !== false &&
    !(typeof result.status === 'number' && result.status >= 400) &&
    result.deliveryStatus !== 'unknown'
  );
}

/** Return a source-of-truth error instead of relying on a model paraphrase. */
export function artifactExecutionFailure(
  intent: ArtifactIntent,
  evidence: ArtifactToolEvidence[],
): string | undefined {
  const latest = [...evidence].reverse().find((item) => item.toolName === intent.toolName);
  if (!latest || completed(latest)) return undefined;
  const detail =
    latest.error?.replace(/\s+/g, ' ').slice(0, 500) ||
    'the tool did not return a successful result';
  return [
    `I couldn't create the requested ${intent.label}.`,
    `${intent.toolName} did not complete: ${detail}.`,
    `I cannot confirm that a ${intent.label} was created.`,
  ].join(' ');
}

/** Whether a model result needs the single constrained retry. */
export function needsArtifactToolRetry(
  intent: ArtifactIntent,
  toolCalls: Array<{ toolName: string }>,
): boolean {
  return !toolCalls.some((toolCall) => toolCall.toolName === intent.toolName);
}
