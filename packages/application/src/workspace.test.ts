import { describe, expect, it } from 'vitest';
import { safeWorkspacePath } from './workspace.js';

describe('safeWorkspacePath', () => {
  it('normalizes separators and redundant segments', () => {
    expect(safeWorkspacePath('/documents/./uploads/file.txt')).toBe('documents/uploads/file.txt');
  });

  it('rejects traversal outside the workspace', () => {
    expect(() => safeWorkspacePath('../../secrets.txt')).toThrow('path escapes the workspace');
  });
});
