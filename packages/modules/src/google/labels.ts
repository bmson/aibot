import type { ModuleMeta } from '../contract.js';

/**
 * The google module's tool labels, in a file with no runtime imports so the
 * browser-safe `@assistant/modules/ui` entry can aggregate them without
 * dragging configuration (and node builtins) into a client bundle.
 */
export const googleToolLabels = {
  'gmail.send': { present: 'Sending an email', past: 'Sent an email' },
  'gmail.create_draft': { present: 'Drafting an email', past: 'Drafted an email' },
  'gmail.search': { present: 'Searching email', past: 'Searched email' },
  'gmail.modify': { present: 'Tidying email', past: 'Tidied email' },
  'calendar.create_event': {
    present: 'Creating a calendar event',
    past: 'Created a calendar event',
  },
  'calendar.update_event': {
    present: 'Updating a calendar event',
    past: 'Updated a calendar event',
  },
  'calendar.search_events': { present: 'Checking the calendar', past: 'Checked the calendar' },
  'calendar.list_events': { present: 'Checking the calendar', past: 'Checked the calendar' },
  'docs.create': { present: 'Creating a document', past: 'Created a document' },
  'docs.append': { present: 'Updating a document', past: 'Updated a document' },
  'docs.get': { present: 'Reading a document', past: 'Read a document' },
  'docs.share': { present: 'Sharing a document', past: 'Shared a document' },
  'sheets.create': { present: 'Creating a spreadsheet', past: 'Created a spreadsheet' },
  'sheets.append_rows': { present: 'Updating a spreadsheet', past: 'Updated a spreadsheet' },
  'sheets.write_rows': { present: 'Updating a spreadsheet', past: 'Updated a spreadsheet' },
  'sheets.get_rows': { present: 'Reading a spreadsheet', past: 'Read a spreadsheet' },
  'slides.create': { present: 'Creating a presentation', past: 'Created a presentation' },
  'slides.append': { present: 'Updating a presentation', past: 'Updated a presentation' },
  'drive.search': { present: 'Searching Drive', past: 'Searched Drive' },
  'drive.read': { present: 'Reading a Drive file', past: 'Read a Drive file' },
  'drive.ingest': { present: 'Filing a Drive document', past: 'Filed a Drive document' },
} satisfies NonNullable<ModuleMeta['ui']>['toolLabels'];
