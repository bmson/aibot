import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const source = readFileSync(path, 'utf8');
const original = 'node --disable-sigusr1 "$ACTION_PATH/dist/main.js" run-codex-exec';
if (source.split(original).length !== 2)
  throw new Error('Pinned action execution hook changed; refusing an unreviewed launcher');
writeFileSync(
  path,
  source.replace(
    original,
    'node --disable-sigusr1 "$RUNNER_TEMP/repair-codex-supervisor.mjs" --disable-sigusr1 "$ACTION_PATH/dist/main.js" run-codex-exec',
  ),
);
