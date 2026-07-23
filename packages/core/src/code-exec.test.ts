import { describe, expect, it } from 'vitest';
import { CODE_INPUT_PREFIXES, CodeSpecSchema } from './code-exec.js';

describe('CodeSpecSchema inputs', () => {
  const base = { goal: 'analyze the CSV', source: 'print(1)', language: 'python' as const };

  it('accepts staged inputs with a bare filename', () => {
    const parsed = CodeSpecSchema.parse({
      ...base,
      inputs: [{ workspacePath: 'documents/report.csv', as: 'data.csv' }],
    });
    expect(parsed.inputs?.[0]?.as).toBe('data.csv');
  });

  it('rejects an `as` that contains a path separator', () => {
    expect(
      CodeSpecSchema.safeParse({
        ...base,
        inputs: [{ workspacePath: 'documents/report.csv', as: '../escape' }],
      }).success,
    ).toBe(false);
    expect(
      CodeSpecSchema.safeParse({
        ...base,
        inputs: [{ workspacePath: 'documents/report.csv', as: 'a/b' }],
      }).success,
    ).toBe(false);
  });

  it('caps the number of inputs at 10', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      workspacePath: `documents/f${i}.csv`,
      as: `f${i}.csv`,
    }));
    expect(CodeSpecSchema.safeParse({ ...base, inputs: many }).success).toBe(false);
  });

  it('exposes the input-prefix allowlist (never profile/secrets)', () => {
    expect(CODE_INPUT_PREFIXES).toContain('documents/');
    expect(CODE_INPUT_PREFIXES).not.toContain('');
    expect(CODE_INPUT_PREFIXES.some((p) => p.includes('profile'))).toBe(false);
  });
});
