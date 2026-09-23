import { parseArgs } from 'node:util';

export function parseFirestoreRuntimeDataPreflightArgs(args: string[]) {
  return parseArgs({
    args,
    options: {
      'gcloud-auth': { type: 'boolean', default: false },
      'database-id': { type: 'string' },
    },
    strict: true,
  }).values;
}
