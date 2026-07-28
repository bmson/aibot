/**
 * The full entry point, published as `@assistant/modules`.
 *
 * This reaches provider code through the module definitions, so only the agent
 * composition root and `assistant.config.ts` import it. Everything that needs
 * metadata alone should import `@assistant/modules/meta` instead.
 */
export { browserModule } from './browser/module.js';
export { codeModule } from './code/module.js';
export * from './compose.js';
export { documentsModule } from './documents/module.js';
export {
  type ApplicationConfirmationDeps,
  type ApplicationConfirmationInput,
  type ApplicationConfirmationResult,
  type ApplicationConfirmationTaskDeps,
  type ApplicationConfirmationTaskResult,
  applicationConfirmationTaskHandlers,
  confirmationTokenHashes,
  executeAmbiguousApplicationConfirmationTask,
  executeApplicationConfirmationTask,
  processApplicationConfirmation,
  reapExpiredApplicationWatches,
} from './google/application-confirmations.js';
export { deliverEmailFinal, type EmailChannelDeps } from './google/email-channel.js';
export {
  type EmailSyncDeps,
  gmailSenderAuthenticated,
  MailboxSyncCoordinator,
  type MailboxSyncResult,
  processMessage,
  renewWatch,
  syncMailboxOnce,
  syncMailboxWithDistributedLock,
} from './google/email-sync.js';
export { googleModule } from './google/module.js';
export * from './install.js';
export * from './meta.js';
export * from './platform.js';
export { remindersModule } from './reminders/module.js';
export { searchModule } from './search/module.js';
export {
  deliverSmsFinal,
  handleInboundSms,
  type InboundSms,
  notifyApprovalsBySms,
  notifyOwnerBySms,
  type SmsChannelDeps,
  SmsChannelRateLimitError,
  type SmsHandled,
  sendCanarySms,
} from './sms/channel.js';
export { smsModule } from './sms/module.js';
export {
  type EmailWatchInput,
  type EmailWatchResult,
  matchEmailWatches,
  reapExpiredWatches,
  type WatchesDeps,
} from './watches/email-watches.js';
export { watchesModule } from './watches/module.js';
