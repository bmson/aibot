#!/usr/bin/env node
// Trusted launcher outside the candidate checkout. The action still owns proxy credentials,
// actor authorization, sandboxing, and privilege removal; this wrapper only owns lifetime.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const binary = process.env.REPAIR_CODEX_REAL_BIN;
const resultFile = process.env.REPAIR_CODEX_RESULT;
const logFile = process.env.REPAIR_CODEX_LOG;
const deadline = Number(process.env.REPAIR_CODEX_TIMEOUT_MS ?? 720000);
const completionGrace = Number(process.env.REPAIR_CODEX_COMPLETION_GRACE_MS ?? 10000);
if (!binary || !resultFile || !logFile || !Number.isFinite(deadline) || deadline <= 0)
  throw new Error('Missing or invalid trusted coding supervisor configuration');

writeFileSync(logFile, '');
const child = spawn(binary, process.argv.slice(2), {
  stdio: ['inherit', 'pipe', 'pipe'],
  detached: true,
});
for (const stream of [child.stdout, child.stderr])
  stream.on('data', (chunk) => {
    appendFileSync(logFile, chunk);
    process.stdout.write(chunk);
  });
const started = Date.now();
let completedAt;
let stopReason;
let killTimer;
function completeResult() {
  try {
    const result = JSON.parse(readFileSync(resultFile, 'utf8'));
    return (
      typeof result.reproduced === 'boolean' &&
      typeof result.regressionTest === 'string' &&
      result.regressionTest.trim() &&
      typeof result.summary === 'string' &&
      result.summary.trim()
    );
  } catch {
    return false;
  }
}
function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function stop(reason) {
  if (stopReason) return;
  stopReason = reason;
  console.log(`Coding supervisor: ${reason}`);
  signalGroup('SIGTERM');
  killTimer = setTimeout(() => signalGroup('SIGKILL'), 2000);
}
const monitor = setInterval(() => {
  if (!completedAt && completeResult()) completedAt = Date.now();
  if (completedAt && Date.now() - completedAt >= completionGrace)
    stop('completed result; stopping lingering process');
  else if (Date.now() - started >= deadline) stop('deadline exceeded without completed result');
}, 100);
child.on('error', () => {
  clearInterval(monitor);
  console.error('Coding supervisor: failed to start Codex');
  process.exitCode = 1;
});
child.on('close', (code) => {
  clearInterval(monitor);
  // Stop descendants before patch export, including children which retained output pipes.
  signalGroup('SIGKILL');
  clearTimeout(killTimer);
  if (stopReason === 'completed result; stopping lingering process' && completeResult())
    process.exitCode = 0;
  else process.exitCode = code === 0 ? 0 : stopReason ? 124 : code || 1;
});
