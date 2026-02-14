import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CommandRunner, CommandRunnerError } from '../src/index.ts';

test('CommandRunner는 allowlist 외 커맨드를 거절한다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-command-runner-'));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'adt-command-runner-workspace-'));

  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const runner = new CommandRunner({
    runDir,
    workspaceDir,
    tools: {
      commands: [
        {
          id: 'safe-node',
          executable: process.execPath,
          args: ['-e', 'process.stdout.write("ok\\n")']
        }
      ]
    }
  });

  const success = await runner.run({ commandId: 'safe-node' });
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout, 'ok\n');

  await assert.rejects(
    async () => {
      await runner.run({ commandId: 'rm-rf' });
    },
    (error: unknown) => {
      assert.equal(error instanceof CommandRunnerError, true);
      assert.equal((error as CommandRunnerError).code, 'NOT_ALLOWED');
      return true;
    }
  );

  const logRaw = await readFile(path.join(runDir, 'logs', 'tool-runtime.log'), 'utf8');
  assert.match(logRaw, /"event":"rejected"/);
  assert.match(logRaw, /"commandId":"rm-rf"/);
});
