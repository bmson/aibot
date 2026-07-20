const CHAT_NOTICES = {
  'archive-active':
    'This chat still has active work. Finish, cancel, or pause it before archiving.',
} as const;

export function chatNoticeMessage(code: string | undefined): string | undefined {
  return code && code in CHAT_NOTICES ? CHAT_NOTICES[code as keyof typeof CHAT_NOTICES] : undefined;
}
