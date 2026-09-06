import { z } from 'zod';

const title = z.string().trim().min(1).max(160);
const detail = z.string().trim().max(2000);
const itemId = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/);
export const PackSourceSchema = z.object({
  kind: z.enum(['card', 'commitment']),
  id: z.string().uuid(),
});
export const PackItemInputSchema = z.object({
  id: itemId,
  title,
  details: detail.default(''),
  lane: z.enum(['plan', 'i_owe', 'waiting_on']).default('plan'),
  dependsOn: z.array(itemId).max(30).default([]),
  source: PackSourceSchema.nullable().default(null),
});
export const PackSnapshotSchema = z.object({
  revision: z.string(),
  state: z.string(),
  title: z.string(),
  details: z.string(),
});
export const PackItemSchema = PackItemInputSchema.extend({
  snapshot: PackSnapshotSchema.nullable().default(null),
  needsReview: z.boolean().default(false),
});
export const PackDecisionSchema = z.object({
  id: itemId,
  option: title,
  outcome: z.enum(['chosen', 'rejected']),
  reason: detail.refine((value) => value.length > 0, 'A reason is required'),
  scope: z.enum(['situation', 'preference']).default('situation'),
  confirmed: z.boolean().default(false),
});
export const PackDataSchema = z.object({
  items: z.array(PackItemSchema).max(30).default([]),
  decisions: z.array(PackDecisionSchema).max(30).default([]),
});
export type PackData = z.infer<typeof PackDataSchema>;
export type PackItem = z.infer<typeof PackItemSchema>;
export type PackSnapshot = z.infer<typeof PackSnapshotSchema>;

/** No orphan edges or cycles: propagation must always have an explainable path. */
export function validatePack(data: PackData): void {
  PackDataSchema.parse(data);
  const items = new Map(data.items.map((item) => [item.id, item]));
  if (items.size !== data.items.length) throw new Error('Item IDs must be unique.');
  if (new Set(data.decisions.map((item) => item.id)).size !== data.decisions.length)
    throw new Error('Decision IDs must be unique.');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Dependencies cannot form a cycle.');
    if (visited.has(id)) return;
    const item = items.get(id);
    if (!item) throw new Error('A dependency does not exist in this pack.');
    visiting.add(id);
    for (const dependency of item.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of items.keys()) visit(id);
}

export function affectedItems(items: PackItem[], changedIds: string[]): string[] {
  const affected = new Set(changedIds);
  for (let pass = 0; pass < items.length; pass++) {
    for (const item of items) {
      if (item.dependsOn.some((id) => affected.has(id))) affected.add(item.id);
    }
  }
  return items.filter((item) => affected.has(item.id)).map((item) => item.id);
}

export const PackCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('forget_decision'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    decisionId: itemId,
  }),
  z.object({ action: z.literal('create'), title, creationKey: z.string().min(1).max(100) }),
  z.object({
    action: z.literal('item'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    item: PackItemInputSchema,
  }),
  z.object({
    action: z.literal('decision'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    decision: PackDecisionSchema,
  }),
  z.object({
    action: z.literal('preview'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    item: PackItemInputSchema,
  }),
  z.object({ action: z.literal('apply'), packId: z.string().uuid(), previewId: z.string().uuid() }),
  z.object({
    action: z.literal('dismiss_preview'),
    packId: z.string().uuid(),
    previewId: z.string().uuid(),
  }),
  z.object({
    action: z.literal('archive'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('reviewed'),
    packId: z.string().uuid(),
    version: z.number().int().positive(),
    itemId,
  }),
]);
export type PackCommand = z.infer<typeof PackCommandSchema>;

export function isSituationRequest(text: string): boolean {
  if (
    /\b(situation packs?|my packs?|this pack|the pack|create a pack|build a pack|decision memory)\b/i.test(
      text,
    )
  )
    return true;
  // Ordinary conceptual hypotheticals must not trigger private-account reads.
  const planningSubject = /\b(hotel|booking|flight|itinerary|trip|reservation|plan)\b/i.test(text);
  return (
    planningSubject &&
    ((/\bwhat[- ]if\b/i.test(text) &&
      /\b(change|replace|move|switch|cancel|delay)\b/i.test(text)) ||
      /\brehearse (?:this|a|the|my|our)\b/i.test(text))
  );
}
