import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Provider, ProviderRunInput } from '../../core/src/index.ts';
import { createCli } from '../src/index.ts';
import { initWorkspace } from '../src/workspace/init-workspace.ts';

const TARGET_FILE_NAME = 'task.txt';

test('adt manager refactor는 승인 후 workflow를 끝까지 실행하고 상태를 남긴다.', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'aao-manager-'));

  try {
    await initWorkspace({ baseDir: temporaryDirectory });
    await setupGitWorkspace(temporaryDirectory, 'draft');

    const logs: string[] = [];
    const cli = createCli({
      manager: {
        cwd: () => temporaryDirectory,
        approvalHandler: async () => true,
        providerResolver: () => createMockProvider('pass'),
        defaultProviderId: 'mock',
        checkCommandIds: [],
        log: (message) => {
          logs.push(message);
        }
      }
    });

    await cli.parse(['node', 'adt', 'manager', 'refactor', '함수', '분리', '요청']);

    assert.equal(logs.some((line) => line.startsWith('run id: refactor-')), true);
    assert.equal(logs.includes('상태: completed'), true);

    const runRoot = path.join(temporaryDirectory, '.runs', 'workflows');
    const runDirs = await readdir(runRoot);

    assert.equal(runDirs.length, 1);

    const stateRaw = await readFile(path.join(runRoot, runDirs[0] ?? '', 'current-run.json'), 'utf8');
    const state = JSON.parse(stateRaw) as {
      status: string;
      phases: Array<{ id: string; status: string }>;
      artifacts: Record<string, string[]>;
    };

    assert.equal(state.status, 'completed');
    assert.equal(state.phases.some((phase) => phase.id === 'review' && phase.status === 'completed'), true);
    assert.equal(
      state.artifacts.implement?.some((artifact) => artifact.endsWith('.diffstat.txt')) ?? false,
      true
    );

    const changed = await readFile(path.join(temporaryDirectory, TARGET_FILE_NAME), 'utf8');
    assert.equal(changed, 'implemented\n');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('adt manager refactor는 승인 거절 시 ask phase로 이동해 awaiting_input으로 종료한다.', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'aao-manager-reject-'));

  try {
    await initWorkspace({ baseDir: temporaryDirectory });
    await setupGitWorkspace(temporaryDirectory, 'draft');

    const cli = createCli({
      manager: {
        cwd: () => temporaryDirectory,
        approvalHandler: async () => false,
        providerResolver: () => createMockProvider('ask'),
        defaultProviderId: 'mock',
        checkCommandIds: [],
        log: () => {
          // 테스트에서는 출력 검증이 목적이 아니므로 무시한다.
        }
      }
    });

    await cli.parse(['node', 'adt', 'manager', 'refactor', '추가', '정보', '필요']);

    const runRoot = path.join(temporaryDirectory, '.runs', 'workflows');
    const runDirs = await readdir(runRoot);

    assert.equal(runDirs.length, 1);

    const stateRaw = await readFile(path.join(runRoot, runDirs[0] ?? '', 'current-run.json'), 'utf8');
    const state = JSON.parse(stateRaw) as {
      status: string;
      phases: Array<{ id: string; status: string }>;
    };

    assert.equal(state.status, 'awaiting_input');
    assert.equal(state.phases.some((phase) => phase.id === 'ask' && phase.status === 'completed'), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('adt manager refactor는 gatekeeper 위험 변경 승인 거절 시 canceled로 종료한다.', async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'aao-manager-gatekeeper-'));

  try {
    await initWorkspace({ baseDir: temporaryDirectory });
    await setupGitWorkspace(temporaryDirectory, 'draft');

    const prompts: string[] = [];
    const logs: string[] = [];
    const cli = createCli({
      manager: {
        cwd: () => temporaryDirectory,
        approvalHandler: async ({ prompt }) => {
          prompts.push(prompt);

          if (prompt.includes('[Gatekeeper]')) {
            return false;
          }

          return true;
        },
        providerResolver: () => createDeleteFileProvider(),
        defaultProviderId: 'mock',
        checkCommandIds: [],
        log: (message) => {
          logs.push(message);
        }
      }
    });

    await cli.parse(['node', 'adt', 'manager', 'refactor', '삭제', '위험', '검증']);

    assert.equal(prompts.some((prompt) => prompt.includes('[Gatekeeper]')), true);
    assert.equal(logs.includes('상태: canceled'), true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function createMockProvider(mode: 'pass' | 'ask'): Provider {
  return {
    id: 'mock',
    capabilities: {
      systemPromptMode: 'inline',
      supportsPatchOutput: true
    },
    async run(input: ProviderRunInput) {
      const phaseId = readPhaseId(input.userPrompt);

      return {
        text: responseForPhase(phaseId, mode),
        meta: {
          durationMs: 1,
          stdout: '',
          stderr: '',
          command: ['mock-provider']
        }
      };
    }
  };
}

function createDeleteFileProvider(): Provider {
  return {
    id: 'mock',
    capabilities: {
      systemPromptMode: 'inline',
      supportsPatchOutput: true
    },
    async run(input: ProviderRunInput) {
      const phaseId = readPhaseId(input.userPrompt);

      if (phaseId === 'plan') {
        return {
          text: 'PLAN RESULT',
          meta: {
            durationMs: 1,
            stdout: '',
            stderr: '',
            command: ['mock-provider']
          }
        };
      }

      if (phaseId === 'implement') {
        return {
          text: createDeleteFilePatch('draft'),
          meta: {
            durationMs: 1,
            stdout: '',
            stderr: '',
            command: ['mock-provider']
          }
        };
      }

      return {
        text: 'REVIEW RESULT',
        meta: {
          durationMs: 1,
          stdout: '',
          stderr: '',
          command: ['mock-provider']
        }
      };
    }
  };
}

function responseForPhase(phaseId: string, mode: 'pass' | 'ask'): string {
  if (phaseId === 'plan') {
    return 'PLAN RESULT';
  }

  if (phaseId === 'implement') {
    return createFilePatch('draft', 'implemented');
  }

  if (phaseId === 'evaluate') {
    return mode === 'pass' ? 'DECISION: PASS' : 'DECISION: ASK';
  }

  if (phaseId === 'fix') {
    return createFilePatch('implemented', 'fixed');
  }

  if (phaseId === 'ask') {
    return 'ASK RESULT';
  }

  if (phaseId === 'review') {
    return 'REVIEW RESULT';
  }

  return `UNKNOWN:${phaseId}`;
}

function readPhaseId(prompt: string): string {
  const match = prompt.match(/phase=([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? 'unknown';
}

async function setupGitWorkspace(workspaceDir: string, initialContent: string): Promise<void> {
  runGit(workspaceDir, ['init']);
  await writeFile(path.join(workspaceDir, TARGET_FILE_NAME), `${initialContent}\n`, 'utf8');
  runGit(workspaceDir, ['add', TARGET_FILE_NAME]);
}

function createFilePatch(before: string, after: string): string {
  return [
    '```diff',
    `diff --git a/${TARGET_FILE_NAME} b/${TARGET_FILE_NAME}`,
    `--- a/${TARGET_FILE_NAME}`,
    `+++ b/${TARGET_FILE_NAME}`,
    '@@ -1 +1 @@',
    `-${before}`,
    `+${after}`,
    '```'
  ].join('\n');
}

function createDeleteFilePatch(before: string): string {
  return [
    '```diff',
    `diff --git a/${TARGET_FILE_NAME} b/${TARGET_FILE_NAME}`,
    `--- a/${TARGET_FILE_NAME}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    `-${before}`,
    '```'
  ].join('\n');
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe'
  });
}
