/** The bounded standing rules offered by every approval surface. */
export interface RememberedApprovalRule {
  toolName: string;
  templateKey: string;
  match: Record<string, unknown>;
  effect: 'allow';
  label: string;
}

export function approvalRule(toolName: string, payload: unknown): RememberedApprovalRule | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const args = payload as Record<string, unknown>;
  const rule = (templateKey: string, match: Record<string, unknown>, label: string) => ({
    toolName,
    templateKey,
    match,
    effect: 'allow' as const,
    label,
  });
  if (toolName === 'mcp.call') {
    const scope = args._approvalMcpScope;
    if (
      typeof args.connectionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.connectionId) ||
      typeof args.toolName !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(args.toolName) ||
      !scope ||
      typeof scope !== 'object' ||
      Array.isArray(scope)
    )
      return null;
    const { fingerprint, connectionName } = scope as Record<string, unknown>;
    if (
      typeof fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(fingerprint) ||
      typeof connectionName !== 'string' ||
      !connectionName
    )
      return null;
    return rule(
      'mcp.call.named_tool',
      { connectionId: args.connectionId, toolName: args.toolName, fingerprint },
      `Approve and always allow ${args.toolName} on ${connectionName}, with any arguments`,
    );
  }
  if (toolName === 'gmail.send') {
    if (
      !Array.isArray(args.to) ||
      args.to.length === 0 ||
      args.to.length > 10 ||
      !noAttachments(args)
    )
      return null;
    const recipients = normalizedApprovalAttendees(args.to);
    if (!recipients?.length) return null;
    if (recipients.length > 1)
      return rule(
        'gmail.send.to_recipients',
        { recipients },
        `Approve and allow future email without attachments to exactly ${recipients.join(', ')}`,
      );
    const recipient = recipients[0];
    if (!recipient) return null;
    return rule(
      'gmail.send.to_recipient',
      { recipient },
      `Approve and allow future email without attachments to ${recipient}`,
    );
  }
  if (toolName === 'sms.send') {
    if (typeof args.to !== 'string' || !/^\+\d{7,15}$/.test(args.to)) return null;
    return rule(
      'sms.send.to_recipient',
      { phone: args.to },
      `Approve and allow future texts to ${args.to}`,
    );
  }
  if (toolName === 'calendar.create_event') {
    const attendees = normalizedApprovalAttendees(args.attendees);
    if (!attendees) return null;
    return attendees.length === 0
      ? rule('calendar.self_only_events', {}, 'Approve and allow future events without guests')
      : rule(
          'calendar.create_event.same_attendees',
          { attendees },
          `Approve and allow future invitations to exactly ${attendees.join(', ')}`,
        );
  }
  if (toolName === 'calendar.update_event') {
    if (typeof args.eventId !== 'string' || args.eventId.length < 3 || args.eventId.length > 200)
      return null;
    const added = normalizedApprovalAttendees(args.addAttendees);
    if (!added) return null;
    if (added.length > 0)
      return rule(
        'calendar.update_event.with_guests',
        { eventId: args.eventId, attendees: added },
        `Approve and allow future edits to event ${args.eventId}, including invitations to exactly ${added.join(', ')}`,
      );
    return rule(
      'calendar.update_event.same_event',
      { eventId: args.eventId },
      `Approve and allow future edits to event ${args.eventId}, notifying existing guests but adding none`,
    );
  }
  if (toolName === 'gmail.modify') {
    if (
      args.archive !== true ||
      !emptyList(args.addLabels) ||
      !emptyList(args.removeLabels) ||
      (args.markRead !== undefined && typeof args.markRead !== 'boolean')
    )
      return null;
    const markRead = args.markRead ?? null;
    return rule(
      'gmail.modify.archive',
      { markRead },
      `Approve and allow future archiving of mail${markRead === true ? ' and marking it read' : markRead === false ? ' and marking it unread' : ''}, without other label changes`,
    );
  }
  if (toolName === 'calendar.respond_to_event') {
    if (
      !['accepted', 'declined', 'tentative'].includes(String(args.response)) ||
      (args.comment !== undefined && args.comment !== '') ||
      (args.calendarId !== undefined &&
        (typeof args.calendarId !== 'string' || !args.calendarId || args.calendarId.length > 512))
    )
      return null;
    const calendarId = args.calendarId ?? 'primary';
    const response = args.response;
    const verb =
      response === 'accepted'
        ? 'accepting'
        : response === 'declined'
          ? 'declining'
          : 'tentatively accepting';
    return rule(
      'calendar.respond_to_event.response',
      { calendarId, response },
      `Approve and allow future ${verb} of invitations on calendar ${calendarId}, notifying organizers without a comment`,
    );
  }
  if (toolName === 'docs.share') {
    if (typeof args.documentId !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(args.documentId))
      return null;
    const emails = normalizedApprovalAttendees([args.email]);
    const role = args.role === undefined ? 'reader' : args.role;
    if (!emails?.length || !['reader', 'commenter', 'writer'].includes(String(role))) return null;
    const access =
      role === 'reader'
        ? 'read-only access'
        : role === 'commenter'
          ? 'comment access'
          : 'edit access';
    return rule(
      'docs.share.to_recipient',
      { email: emails[0], role },
      `Approve and allow sharing future Google Docs with ${emails[0]} with ${access}, emailing them a link`,
    );
  }
  if (toolName === 'phone.call') {
    const brief = approvalCallBrief(args.brief);
    if (!brief) return null;
    return rule(
      'phone.call.same_brief',
      { brief },
      `Approve and allow repeat calls to ${brief.to} for “${brief.goal}”, with the same sharing and agreement limits, up to ${brief.maxMinutes} minutes`,
    );
  }
  return null;
}

export function noAttachments(args: Record<string, unknown>): boolean {
  return (
    args.attachments === undefined ||
    (Array.isArray(args.attachments) && args.attachments.length === 0)
  );
}

/** Exact sets keep permission from silently widening to additional guests. */
export function normalizedApprovalAttendees(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some(
      (item) => typeof item !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.trim()),
    )
  )
    return null;
  return [...new Set((value as string[]).map((item) => item.trim().toLowerCase()))].sort();
}

function emptyList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

/** Include every call instruction: a changed disclosure or agreement needs another approval. */
export function approvalCallBrief(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const b = value as Record<string, unknown>;
  const knownFields = [
    'to',
    'goal',
    'maxMinutes',
    'contactName',
    'context',
    'mayAgreeTo',
    'mustNot',
    'language',
    'onVoicemail',
    'voicemailMessage',
  ];
  if (Object.keys(b).some((key) => !knownFields.includes(key))) return null;
  if (
    typeof b.to !== 'string' ||
    !/^\+[1-9]\d{6,14}$/.test(b.to) ||
    typeof b.goal !== 'string' ||
    b.goal.length < 5 ||
    b.goal.length > 500
  )
    return null;
  const maxMinutes = b.maxMinutes === undefined ? 10 : b.maxMinutes;
  if (
    typeof maxMinutes !== 'number' ||
    !Number.isInteger(maxMinutes) ||
    maxMinutes < 1 ||
    maxMinutes > 60
  )
    return null;
  const brief: Record<string, string | number> = { to: b.to, goal: b.goal, maxMinutes };
  for (const [key, max, fallback] of [
    ['contactName', 120, ''],
    ['context', 2000, ''],
    ['mayAgreeTo', 1000, ''],
    ['mustNot', 1000, ''],
    ['language', 40, 'English'],
    ['voicemailMessage', 500, ''],
  ] as const) {
    const field = b[key] === undefined ? fallback : b[key];
    if (typeof field !== 'string' || field.length > max) return null;
    brief[key] = field;
  }
  if (b.onVoicemail !== undefined && !['hang_up', 'leave_message'].includes(String(b.onVoicemail)))
    return null;
  brief.onVoicemail = (b.onVoicemail as string) ?? 'hang_up';
  return brief;
}

/** Compare the bounded scopes, independent of database object-key ordering. */
export function sameApprovalScope(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, i) => sameApprovalScope(value, right[i]))
    );
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameApprovalScope(a[key], b[key]))
  );
}
