import { describe, expect, it } from 'vitest';
import { CODE_INPUT_PREFIXES, type JobInput, parseJobInput } from './input.js';

/**
 * First coverage for the sandboxed code runner — the highest-blast-radius
 * worker in the repo, previously absent from the test runner entirely. These
 * pin the input-validation boundary: everything the job trusts arrives through
 * `parseJobInput` and the staging allowlist.
 */
const valid: JobInput = {
  taskId: '00000000-0000-0000-0000-000000000001',
  spec: {
    goal: 'sum a column',
    language: 'python',
    source: 'print(1)',
    allowNetwork: false,
    timeoutSeconds: 60,
  },
  callbackUrl: 'https://agent.example/webhooks/code/callback',
  callbackToken: 'a'.repeat(48),
  storage: { driver: 'local', root: '/tmp/workspace' },
};

describe('parseJobInput', () => {
  it('accepts a complete job payload', () => {
    expect(parseJobInput(JSON.stringify(valid)).spec.language).toBe('python');
  });

  it('refuses to start without the callback credentials', () => {
    expect(() => parseJobInput(undefined)).toThrow(/not set/);
    expect(() => parseJobInput(JSON.stringify({ ...valid, callbackToken: '' }))).toThrow(
      /callbackToken/,
    );
  });

  it('refuses an empty script and unknown languages', () => {
    expect(() =>
      parseJobInput(JSON.stringify({ ...valid, spec: { ...valid.spec, source: '' } })),
    ).toThrow(/no source/);
    expect(() =>
      parseJobInput(JSON.stringify({ ...valid, spec: { ...valid.spec, language: 'bash' } })),
    ).toThrow(/unsupported language/);
  });

  it('refuses a payload with no storage target', () => {
    expect(() => parseJobInput(JSON.stringify({ ...valid, storage: undefined }))).toThrow(
      /storage/,
    );
  });
});

describe('input staging allowlist', () => {
  it('covers only the four bounded workspace areas', () => {
    // The runner may read staged inputs from these prefixes and nothing else —
    // in particular not memory/, profile/, or the workspace root.
    expect([...CODE_INPUT_PREFIXES].sort()).toEqual([
      'browser/attachments/',
      'code/',
      'documents/',
      'imports/',
    ]);
    expect(CODE_INPUT_PREFIXES.some((p) => p === '' || p === '/')).toBe(false);
  });
});
