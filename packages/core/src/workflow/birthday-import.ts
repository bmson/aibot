import { type ReadIntentMessage, readIntentText } from './read-intent.js';
import type { ActionEvidence } from './response-contract.js';
import { isDurableSave, isMemoryWriteRequest } from './saved-work.js';

export type BirthdaySave = { subject: string; content: string };

/** Preserve the owner's literal dates and annotations; never complete a blank date. */
export function requestedBirthdaySaves(history: ReadonlyArray<ReadIntentMessage>): BirthdaySave[] {
  const owners = history.filter((row) => row.role === 'user').map(readIntentText);
  const request = owners.at(-1) ?? '';
  if (!isMemoryWriteRequest(request) || !/\bbirthdays?\b/i.test(request)) return [];
  const source = [...owners]
    .reverse()
    .find((text) =>
      /^.+?\s+(?:January|February|March|April|May|June|July|August|Aug|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/im.test(
        text,
      ),
    );
  if (!source) return [];
  const result: BirthdaySave[] = [];
  for (const line of source.split('\n')) {
    const match =
      /^\s*(.+?)\s+((?:January|February|March|April|May|June|July|August|Aug|September|October|November|December)\s+\d{1,2},?\s+\d{4})(.*)$/i.exec(
        line,
      );
    if (!match?.[1] || !match[2]) continue;
    const name = match[1].trim();
    // A shared date explicitly attached to two names is two people.
    for (const person of name.split(/\s+&\s+/)) {
      const subject = person.replace(/\s*\(d\)/gi, '').trim();
      result.push({
        subject,
        content: `Birthday for ${subject}: ${match[2].trim()}. Owner's notes: ${person.includes('(d)') ? 'deceased; ' : ''}${match[3]?.trim() || 'none supplied'}`,
      });
    }
  }
  return result.length >= 2 && result.length <= 100 ? result : [];
}

export function remainingBirthdaySaves(
  requested: BirthdaySave[],
  evidence: ActionEvidence[],
): BirthdaySave[] {
  return requested.filter(
    (entry) =>
      !evidence.some((row) => {
        const args = row.args as { subject?: string; content?: string } | undefined;
        return (
          isDurableSave(row) &&
          row.toolName === 'memory.save' &&
          args?.subject === entry.subject &&
          args.content === entry.content
        );
      }),
  );
}
