import { predicateSpec } from '@assistant/core/memory/predicate-vocabulary';

/**
 * A human-facing relationship description. Graph predicates remain canonical
 * identifiers for extraction and recall; no UI should make an owner decode
 * their direction or snake_case spelling.
 */
export interface RelationshipPresentation {
  /** A complete fact, independent of which endpoint is currently open. */
  sentence: string;
  /** Compact label for cards, filters, and map legends. */
  label: string;
  /** Direction-free screen-reader description. */
  accessibleLabel: string;
}

export function readableKnowledgeLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
}

function possessive(label: string): string {
  return label.endsWith('s') ? `${label}'` : `${label}'s`;
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value;
}

/**
 * Translates a stored directed edge into a readable fact. The small explicit
 * grammar table handles relationships whose natural wording cannot be formed
 * by merely replacing underscores (for example, daughter_of and spouse_of).
 */
export function presentKnowledgeGraphRelation(input: {
  subjectLabel: string;
  predicate: string;
  objectLabel: string;
}): RelationshipPresentation {
  const subject = readableKnowledgeLabel(input.subjectLabel);
  const object = readableKnowledgeLabel(input.objectLabel);
  const predicate = readableKnowledgeLabel(input.predicate).toLocaleLowerCase();
  const spec = predicateSpec(input.predicate);
  const role = predicate.replace(/\s+of$/, '');

  let sentence: string;
  if (spec?.symmetric) {
    const plural = new Map<string, string>([
      ['spouse of', 'spouses'],
      ['partner of', 'partners'],
      ['sibling of', 'siblings'],
      ['cousin of', 'cousins'],
      ['met', 'connected'],
    ]).get(predicate);
    sentence = plural
      ? `${subject} and ${object} are ${plural}.`
      : `${subject} is related to ${object}.`;
  } else if (predicate.endsWith(' of')) {
    sentence = `${subject} is ${possessive(object)} ${role}.`;
  } else if (predicate === 'employs') {
    sentence = `${subject} employs ${object}.`;
  } else if (predicate === 'attended by') {
    sentence = `${object} attended ${subject}.`;
  } else {
    sentence = `${subject} ${predicate} ${object}.`;
  }

  return {
    sentence,
    label: titleCase(role || predicate),
    accessibleLabel: sentence,
  };
}
