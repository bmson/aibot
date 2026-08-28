// Shared between the full settings page and the collapsed-rail settings
// popover, so the two surfaces never drift into describing the same
// schedule/policy differently.

export const scheduleLabels: Record<string, string> = {
  'morning-brief': 'Morning brief',
  'daily-briefing': 'Daily briefing',
  'tomorrow-check': 'Evening look at tomorrow',
  pulse: 'During-the-day pulse',
  'memory-extraction': 'Remember useful details from today',
  'memory-consolidation': 'Organize saved memory',
  'chat-segmentation': 'Organize conversation history',
};

export const policyLabels: Record<string, string> = {
  'calendar.owner_attendee_only': 'Create calendar invitations for you',
  'calendar.self_only_events': 'Create private events on the assistant calendar',
  'gmail.send.to_recipient': 'Send email to an approved recipient',
  'sms.reply_to_owner': 'Reply to your text messages',
};

export function policyScope(templateKey: string, match: unknown): string | null {
  const values =
    match && typeof match === 'object' && !Array.isArray(match)
      ? (match as Record<string, unknown>)
      : {};
  if (templateKey === 'gmail.send.to_recipient' && typeof values.recipient === 'string') {
    return `Recipient: ${values.recipient}`;
  }
  if (templateKey === 'sms.reply_to_owner' && typeof values.phone === 'string') {
    return values.phone ? `Phone: ${values.phone}` : 'No owner phone is configured';
  }
  if (templateKey === 'calendar.owner_attendee_only' && Array.isArray(values.emails)) {
    const emails = values.emails.filter((email): email is string => typeof email === 'string');
    return emails.length > 0
      ? `Owner emails: ${emails.join(', ')}`
      : 'No owner email is configured';
  }
  if (templateKey === 'calendar.self_only_events') return 'Only events without guests';
  return null;
}
