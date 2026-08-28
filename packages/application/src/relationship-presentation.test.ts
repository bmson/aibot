import { describe, expect, it } from 'vitest';
import {
  presentKnowledgeGraphRelation,
  readableKnowledgeLabel,
} from './relationship-presentation.js';

describe('relationship presentation', () => {
  it('narrates inverse family relationships in the reader’s natural direction', () => {
    expect(
      presentKnowledgeGraphRelation({
        subjectLabel: 'Freyja_Ruth',
        predicate: 'daughter_of',
        objectLabel: 'Baldvin',
      }),
    ).toMatchObject({
      label: 'Daughter',
      sentence: "Freyja Ruth is Baldvin's daughter.",
    });
  });

  it('uses symmetric wording for spouses instead of a directed arrow', () => {
    expect(
      presentKnowledgeGraphRelation({
        subjectLabel: 'Baldvin',
        predicate: 'spouse_of',
        objectLabel: 'Katharine',
      }).sentence,
    ).toBe('Baldvin and Katharine are spouses.');
  });

  it('cleans stored separators without changing the stored predicate', () => {
    const presentation = presentKnowledgeGraphRelation({
      subjectLabel: 'Baldvin_Mar',
      predicate: 'advises_for',
      objectLabel: 'SocialCode_Inc',
    });
    expect(readableKnowledgeLabel('wedding_for_Kim')).toBe('wedding for Kim');
    expect(presentation).toMatchObject({
      label: 'Advises for',
      sentence: 'Baldvin Mar advises for SocialCode Inc.',
    });
  });
});
