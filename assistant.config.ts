import {
  browserModule,
  codeModule,
  defineAssistant,
  documentsModule,
  googleModule,
  pushModule,
  remindersModule,
  searchModule,
  smsModule,
  watchesModule,
} from '@assistant/modules';

/**
 * What this installation is made of.
 *
 * This is the one file to edit when adding or removing a capability. Delete a
 * line and that module is not installed, its tools never reach the registry,
 * its worker image is not built, and the resources it needs are not
 * provisioned. Add one and all of that follows from it.
 *
 * Each module still reads its settings from `.env` through the single schema in
 * `@assistant/config`, and `ASSISTANT_MODULES` narrows this list at runtime for
 * a container that should start with less than it was built with. It cannot
 * widen it: a module absent here has nothing to install.
 *
 * Run `pnpm modules:plan --billing` to see what a change here costs.
 */
export default defineAssistant({
  modules: [
    browserModule,
    codeModule,
    documentsModule,
    googleModule,
    pushModule,
    remindersModule,
    searchModule,
    smsModule,
    watchesModule,
  ],
});
