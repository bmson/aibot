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
export { googleModule } from './google/module.js';
export * from './install.js';
export * from './meta.js';
export * from './platform.js';
export { remindersModule } from './reminders/module.js';
export { searchModule } from './search/module.js';
export { smsModule } from './sms/module.js';
export { watchesModule } from './watches/module.js';
