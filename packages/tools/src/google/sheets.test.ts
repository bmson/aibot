import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { GoogleClient } from './client.js';
import { a1StartRange, registerSheetsTools } from './sheets.js';

const DEPS = { ownerEmail: 'owner@example.com' };

function toolsWith(api: ReturnType<typeof vi.fn>) {
  const registry = new ToolRegistry();
  registerSheetsTools(registry, { client: { api } as unknown as GoogleClient, ...DEPS });
  return registry;
}

describe('Google Sheets tools', () => {
  it('quotes a tab name safely for A1 notation', () => {
    expect(a1StartRange("Q1 team's plan")).toBe("'Q1 team''s plan'!A1");
  });

  it('creates, fills, and shares a sheet using literal cell values', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce({
        spreadsheetId: 'SHEET-123_abc',
        spreadsheetUrl: 'https://sheets.example.test/SHEET-123_abc',
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const tool = toolsWith(api).get('sheets.create')?.tool;

    const result = (await tool?.execute(
      {
        title: 'Budget',
        sheetName: 'April',
        rows: [
          ['Item', 'Cost'],
          ['=SUM(A1:A2)', 12],
        ],
      },
      {} as never,
    )) as { spreadsheetId: string; url: string; sharedWith: string };

    expect(result).toEqual({
      spreadsheetId: 'SHEET-123_abc',
      title: 'Budget',
      url: 'https://sheets.example.test/SHEET-123_abc',
      sharedWith: 'owner@example.com',
    });
    const [createUrl, createInit] = api.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('https://sheets.googleapis.com/v4/spreadsheets');
    expect(JSON.parse(String(createInit.body))).toEqual({
      properties: { title: 'Budget' },
      sheets: [{ properties: { title: 'April' } }],
    });
    const [valueUrl, valueInit] = api.mock.calls[1] as [string, RequestInit];
    expect(valueUrl).toContain('valueInputOption=RAW');
    expect(JSON.parse(String(valueInit.body))).toEqual({
      majorDimension: 'ROWS',
      values: [
        ['Item', 'Cost'],
        ['=SUM(A1:A2)', 12],
      ],
    });
  });

  it('offers creation, append, and read only to trusted owner work', () => {
    const registry = toolsWith(vi.fn());
    expect(registry.toolsForTask('unknown').map((tool) => tool.name)).not.toContain(
      'sheets.create',
    );
    expect(registry.toolsForTask('owner').map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['sheets.create', 'sheets.append_rows', 'sheets.get_rows']),
    );
  });
});
