import { describe, expect, it } from 'vitest';
import { chatNoticeMessage } from './chat-notices.js';

describe('chat notices', () => {
  it('turns the archive race into owner-readable feedback', () => {
    expect(chatNoticeMessage('archive-active')).toBe(
      'This chat still has active work. Finish, cancel, or pause it before archiving.',
    );
    expect(chatNoticeMessage('unknown')).toBeUndefined();
  });
});
