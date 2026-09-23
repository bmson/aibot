import { describe, expect, it } from 'vitest';
import { parseFirestoreRuntimeDataPreflightArgs } from './firestore-runtime-data-preflight-args.js';

describe('Firestore runtime data preflight arguments', () => {
  it('keeps ADC as the default and accepts an explicit named database', () => {
    expect(parseFirestoreRuntimeDataPreflightArgs(['--database-id', 'rehearsal'])).toEqual({
      'gcloud-auth': false,
      'database-id': 'rehearsal',
    });
  });

  it('enables active gcloud account auth only when requested', () => {
    expect(parseFirestoreRuntimeDataPreflightArgs(['--gcloud-auth'])).toEqual({
      'gcloud-auth': true,
      'database-id': undefined,
    });
  });
});
