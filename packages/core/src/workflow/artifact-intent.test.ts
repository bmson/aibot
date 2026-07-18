import { describe, expect, it } from 'vitest';
import {
  artifactCreatedResponse,
  artifactDispatchFailure,
  artifactExecutionFailure,
  artifactRoutingFailure,
  artifactToolUnavailable,
  directArtifactArgs,
  documentReadDispatchFailure,
  needsArtifactToolRetry,
  requestedArtifactIntent,
  requestedDocumentReadIntent,
  spreadsheetRowsFromContent,
} from './artifact-intent.js';

describe('requestedArtifactIntent', () => {
  it.each([
    ['try creating the doc again', 'docs.create'],
    ['Create a Google Document for the project plan', 'docs.create'],
    ['make a spreadsheet for the budget', 'sheets.create'],
    ['prepare slides for the customer briefing', 'slides.create'],
  ])('routes an explicit artifact request to %s', (text, toolName) => {
    expect(requestedArtifactIntent(text)?.toolName).toBe(toolName);
  });

  it('builds direct creation arguments from a structured owner request', () => {
    const intent = requestedArtifactIntent(
      'Create a Google Doc titled "Verification" with this exact content: It worked.',
    );
    expect(intent).toBeDefined();
    if (!intent) return;
    expect(
      directArtifactArgs(
        intent,
        'Create a Google Doc titled "Verification" with this exact content: It worked.',
      ),
    ).toEqual({
      toolName: 'docs.create',
      args: { title: 'Verification', content: 'It worked.' },
    });
  });

  it('uses safe blank defaults for direct requests without a title', () => {
    const intent = requestedArtifactIntent('try creating the doc again');
    expect(intent).toBeDefined();
    if (!intent) return;
    expect(directArtifactArgs(intent, 'try creating the doc again')).toEqual({
      toolName: 'docs.create',
      args: { title: 'Untitled document', content: '' },
    });
  });

  it('populates a directly requested sheet from columns or a Markdown table', () => {
    const intent = requestedArtifactIntent(
      'Create a Google Sheet titled "Job tracker" with columns Company, Role, Status',
    );
    expect(intent?.toolName).toBe('sheets.create');
    if (!intent) return;
    expect(
      directArtifactArgs(
        intent,
        'Create a Google Sheet titled "Job tracker" with columns Company, Role, Status',
      ),
    ).toMatchObject({
      args: { title: 'Job tracker', rows: [['Company', 'Role', 'Status']] },
    });
    expect(
      spreadsheetRowsFromContent('| Company | Role |\n| --- | --- |\n| Acme | Engineer |'),
    ).toEqual([
      ['Company', 'Role'],
      ['Acme', 'Engineer'],
    ]);
  });

  it('derives deterministic, evidence-backed artifact responses', () => {
    const intent = requestedArtifactIntent('Create a document');
    expect(intent).toBeDefined();
    if (!intent) return;
    expect(
      artifactCreatedResponse(intent, { url: 'https://docs.google.com/document/d/abc/edit' }),
    ).toContain('/abc/edit');
    expect(artifactDispatchFailure(intent, 'Google API 403')).toContain('Google API 403');
    expect(artifactDispatchFailure(intent, 'Google API 403')).toContain('cannot confirm');
  });

  it.each([
    'can it create docs, sheets, and slides?',
    'how do I create a Google Doc?',
    "don't create a document yet",
    'create a document and a spreadsheet',
  ])('does not force a tool for %s', (text) => {
    expect(requestedArtifactIntent(text)).toBeUndefined();
  });

  it('recognizes a directly shared Google Doc as a real document-read request', () => {
    const intent = requestedDocumentReadIntent(
      'CV: https://docs.google.com/document/d/1SLbcTqOwMMQG3QmD7gj755xzOKwQtVyv5cvaPjSwGSs/edit?tab=t.0',
    );
    expect(intent).toEqual({
      toolName: 'docs.get',
      documentId: '1SLbcTqOwMMQG3QmD7gj755xzOKwQtVyv5cvaPjSwGSs',
    });
    if (!intent) return;
    expect(
      requestedDocumentReadIntent('https://example.com/document/d/not-a-google-doc'),
    ).toBeUndefined();
    expect(documentReadDispatchFailure(intent, 'Google API 403')).toContain('Google API 403');
  });

  it('requires the matching tool call and describes both no-attempt outcomes precisely', () => {
    const intent = requestedArtifactIntent('Try creating the doc again');
    expect(intent).toBeDefined();
    if (!intent) return;

    expect(needsArtifactToolRetry(intent, [])).toBe(true);
    expect(needsArtifactToolRetry(intent, [{ toolName: 'docs.create' }])).toBe(false);
    expect(artifactRoutingFailure(intent)).toContain('docs.create');
    expect(artifactRoutingFailure(intent)).toContain('No request was sent to Google');
    expect(artifactToolUnavailable(intent)).toContain('not available to this task');
  });

  it('surfaces the durable Google error and never calls a failed creation complete', () => {
    const intent = requestedArtifactIntent('Create a document');
    expect(intent).toBeDefined();
    if (!intent) return;

    expect(
      artifactExecutionFailure(intent, [
        {
          toolName: 'docs.create',
          status: 'failed',
          result: null,
          error: 'Google API 403: insufficient authentication scopes',
        },
      ]),
    ).toContain('Google API 403');
    expect(
      artifactExecutionFailure(intent, [
        { toolName: 'docs.create', status: 'succeeded', result: { documentId: 'doc-1' } },
      ]),
    ).toBeUndefined();
  });
});
