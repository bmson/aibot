import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Every external command the wizard runs goes through this, so checks are
 * testable without gcloud and a dry run can report what it would have done
 * without touching anything.
 */
export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

export const systemRunner: CommandRunner = {
  async run(command, args) {
    try {
      const env = { ...process.env };
      if (command === 'terraform') {
        for (const key of Object.keys(env)) {
          if (
            key === 'TF_CLI_ARGS' ||
            key.startsWith('TF_CLI_ARGS_') ||
            key.startsWith('TF_VAR_') ||
            key === 'TF_DATA_DIR' ||
            key === 'TF_CLI_CONFIG_FILE' ||
            key === 'TERRAFORM_CONFIG'
          )
            delete env[key];
        }
      }
      const { stdout, stderr } = await execFileAsync(command, [...args], {
        maxBuffer: 8 * 1024 * 1024,
        env,
      });
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        stdout: (failure.stdout ?? '').trim(),
        stderr: (failure.stderr ?? failure.message ?? 'command failed').trim(),
      };
    }
  },
};
