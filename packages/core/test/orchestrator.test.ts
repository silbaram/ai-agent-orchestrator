import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Gatekeeper, Orchestrator, type Provider, type ProviderRunInput } from '../src/index.ts';

const TARGET_FILE_NAME = 'service.txt';

const WORKFLOW_TEMPLATE = [
  'name: refactor',
  'entry_phase: plan',
  'max_steps: 16',
  'phases:',
  '  - id: plan',
  '    type: llm',
  '    role: planner',
  '    provider: mock',
  '    prompt_template: "phase=plan request={{request}}"',
  '    next: approve',
  '  - id: approve',
  '    type: approval',
  '    prompt_template: "approve plan={{phase.plan.output}}"',
  '    next_on_approve: implement',
  '    next_on_reject: ask',
  '  - id: implement',
  '    type: llm',
  '    role: developer',
  '    provider: mock',
  '    prompt_template: "phase=implement plan={{phase.plan.output}}"',
  '    next: evaluate',
  '  - id: evaluate',
  '    type: llm',
  '    role: evaluator',
  '    provider: mock',
  '    prompt_template: "phase=evaluate impl={{phase.implement.output}}"',
  '    decision_source: output_tag',
  '    next_on_pass: review',
  '    next_on_fix: fix',
  '    next_on_ask: ask',
  '  - id: fix',
  '    type: llm',
  '    role: fixer',
  '    provider: mock',
  '    prompt_template: "phase=fix eval={{phase.evaluate.output}}"',
  '    next: review',
  '  - id: ask',
  '    type: llm',
  '    role: planner',
  '    provider: mock',
  '    prompt_template: "phase=ask eval={{phase.evaluate.output}}"',
  '    terminal_status: awaiting_input',
  '  - id: review',
  '    type: llm',
  '    role: reviewer',
  '    provider: mock',
  '    prompt_template: "phase=review latest={{latest_output}}"',
  '    terminal_status: completed',
  ''
].join('\n');

const SYSTEM_PROMPT_FILE_WORKFLOW_TEMPLATE = [
  'name: prompt-file-flow',
  'entry_phase: plan',
  'max_steps: 8',
  'phases:',
  '  - id: plan',
  '    type: llm',
  '    role: planner',
  '    provider: mock',
  '    system_prompt_file: roles/planner.md',
  '    prompt_template: "phase=plan request={{request}}"',
  '    next: review',
  '  - id: review',
  '    type: llm',
  '    role: reviewer',
  '    provider: mock',
  '    prompt_template: "phase=review latest={{latest_output}}"',
  '    terminal_status: completed',
  ''
].join('\n');

test('Orchestrator는 FIX 분기로 refactor workflow를 완료한다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-fix-'));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-workspace-'));
  const workflowPath = path.join(workspaceDir, 'refactor.yaml');

  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await writeFile(workflowPath, WORKFLOW_TEMPLATE, 'utf8');
  await setupGitWorkspace(workspaceDir, 'alpha');

  const providerCalls: string[] = [];
  const provider = createMockProvider((phaseId) => {
    if (phaseId === 'plan') {
      return 'PLAN OUTPUT';
    }

    if (phaseId === 'implement') {
      return createFilePatch('alpha', 'beta');
    }

    if (phaseId === 'evaluate') {
      return 'DECISION: FIX';
    }

    if (phaseId === 'fix') {
      return createFilePatch('beta', 'gamma');
    }

    if (phaseId === 'review') {
      return 'REVIEW OUTPUT';
    }

    return `UNEXPECTED:${phaseId}`;
  }, providerCalls);

  const approvalPrompts: string[] = [];
  const orchestrator = new Orchestrator({
    providerResolver: () => provider,
    approvalHandler: async ({ prompt }) => {
      approvalPrompts.push(prompt);
      return true;
    }
  });

  const result = await orchestrator.run({
    workflowPath,
    runDir,
    workspaceDir,
    request: '함수 분리 및 네이밍 개선'
  });

  assert.equal(result.state.status, 'completed');
  assert.deepEqual(result.executedPhases, ['plan', 'approve', 'implement', 'evaluate', 'fix', 'review']);
  assert.equal(providerCalls.includes('ask'), false);

  assert.match(approvalPrompts[0] ?? '', /PLAN OUTPUT/);

  const stateRaw = await readFile(path.join(runDir, 'current-run.json'), 'utf8');
  const state = JSON.parse(stateRaw) as {
    status: string;
    artifacts: Record<string, string[]>;
  };

  assert.equal(state.status, 'completed');
  assert.equal(Array.isArray(state.artifacts.plan), true);
  assert.equal(Array.isArray(state.artifacts.review), true);
  assert.equal(
    state.artifacts.implement?.some((artifact) => artifact.endsWith('.diff.txt')) ?? false,
    true
  );
  assert.equal(state.artifacts.fix?.some((artifact) => artifact.endsWith('.diff.txt')) ?? false, true);

  const reviewArtifact = await readFile(path.join(runDir, 'artifacts', 'review', 'iter-0006.raw.txt'), 'utf8');
  assert.equal(reviewArtifact, 'REVIEW OUTPUT');

  const fixDiffStat = await readFile(path.join(runDir, 'artifacts', 'fix', 'iter-0005.diffstat.txt'), 'utf8');
  assert.match(fixDiffStat, /service\.txt/);

  const finalContent = await readFile(path.join(workspaceDir, TARGET_FILE_NAME), 'utf8');
  assert.equal(finalContent, 'gamma\n');
});

test('Orchestrator는 phase.provider가 없을 때 roleProviderMap로 provider를 선택한다.', async (t) => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-role-workspace-'));
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-role-run-'));
  const workflowPath = path.join(workspaceDir, 'role.yaml');

  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const workflowTemplate = [
    'name: role-mapping',
    'entry_phase: plan',
    'phases:',
    '  - id: plan',
    '    type: llm',
    '    role: planner',
    '    prompt_template: "phase=plan request={{request}}"',
    '    next: review',
    '  - id: review',
    '    type: llm',
    '    role: reviewer',
    '    prompt_template: "phase=review latest={{latest_output}}"',
    '    terminal_status: completed',
    ''
  ].join('\n');

  await writeFile(workflowPath, workflowTemplate, 'utf8');
  const providerCalls: string[] = [];
  const providers = new Map<string, Provider>([
    ['codex', createNamedMockProvider('codex', () => 'PLAN OUTPUT')],
    ['claude', createNamedMockProvider('claude', () => 'REVIEW OUTPUT')]
  ]);

  const orchestrator = new Orchestrator({
    providerResolver: (providerId) => {
      providerCalls.push(providerId);
      const provider = providers.get(providerId);

      if (!provider) {
        throw new Error(`알 수 없는 provider: ${providerId}`);
      }

      return provider;
    },
    approvalHandler: async () => true
  });

  const result = await orchestrator.run({
    workflowPath,
    runDir,
    workspaceDir,
    request: '역할 기반 provider 분기 확인',
    roleProviderMap: {
      planner: 'codex',
      reviewer: 'claude'
    }
  });

  assert.equal(result.state.status, 'completed');
  assert.deepEqual(providerCalls, ['codex', 'claude']);
});

test('Orchestrator는 manager phase를 사용자 메시지로만 처리한다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-manager-run-'));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-manager-workspace-'));
  const workflowPath = path.join(workspaceDir, 'manager-report.yaml');

  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const workflowTemplate = [
    'name: manager-report',
    'entry_phase: plan',
    'phases:',
    '  - id: plan',
    '    type: llm',
    '    role: planner',
    '    provider: mock',
    '    prompt_template: "phase=plan request={{request}}"',
    '    next: manager_report',
    '  - id: manager_report',
    '    type: llm',
    '    role: manager',
    '    prompt_template: "phase=manager_report plan={{phase.plan.output}}"',
    '    next: review',
    '  - id: review',
    '    type: llm',
    '    role: reviewer',
    '    provider: mock',
    '    prompt_template: "phase=review latest={{latest_output}}"',
    '    terminal_status: completed',
    ''
  ].join('\n');

  await writeFile(workflowPath, workflowTemplate, 'utf8');

  const provider = createMockProvider((phaseId) => {
    if (phaseId === 'plan') {
      return 'PLAN OUTPUT';
    }

    if (phaseId === 'manager_report') {
      return '요청된 작업이 반영될 예정입니다.';
    }

    if (phaseId === 'review') {
      return 'REVIEW OUTPUT';
    }

    return `UNEXPECTED:${phaseId}`;
  });

  const orchestrator = new Orchestrator({
    providerResolver: () => provider,
    approvalHandler: async () => true
  });

  const result = await orchestrator.run({
    workflowPath,
    runDir,
    workspaceDir,
    request: '문서 검토용 리포트 생성'
  });

  assert.equal(result.state.status, 'completed');
  assert.deepEqual(result.executedPhases, ['plan', 'manager_report', 'review']);
  assert.equal(
    result.state.artifacts.manager_report?.some((artifact) => artifact.endsWith('.patch')) ?? false,
    false
  );
  assert.equal(
    result.state.artifacts.manager_report?.some((artifact) => artifact.endsWith('.diff.txt')) ?? false,
    false
  );

  const managerReportArtifact = result.artifacts.find((artifact) =>
    artifact.relativePath.endsWith('.manager-update.md')
  );
  assert.ok(managerReportArtifact);
  const managerMessage = await readFile(
    path.join(runDir, managerReportArtifact!.relativePath),
    'utf8'
  );

  assert.match(managerMessage, /# USER_UPDATE/);
  assert.match(managerMessage, /## TL;DR/);
  assert.match(managerMessage, /## What changed/);
  assert.match(managerMessage, /## Risks/);
  assert.match(managerMessage, /## Actions needed/);
  assert.match(managerMessage, /## Next/);
});

test('Orchestrator는 system_prompt_file을 읽어 phase systemPrompt를 구성한다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-system-prompt-file-'));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-system-prompt-file-workspace-'));
  const workflowPath = path.join(workspaceDir, 'system-prompt-file-flow.yaml');
  const roleDir = path.join(workspaceDir, 'roles');
  const recordedSystemPrompts: string[] = [];

  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await mkdir(roleDir, { recursive: true });
  await writeFile(
    path.join(roleDir, 'planner.md'),
    [
      '# Planner',
      '',
      '당신은 {{role}}이다.',
      '요청: {{request}}',
      '워크플로: {{workflow.name}}',
      ''
    ].join('\n'),
    'utf8'
  );
  await writeFile(workflowPath, SYSTEM_PROMPT_FILE_WORKFLOW_TEMPLATE, 'utf8');

  const provider: Provider = {
    id: 'mock',
    capabilities: {
      systemPromptMode: 'inline',
      supportsPatchOutput: true
    },
    async run(input) {
      recordedSystemPrompts.push(input.systemPrompt);
      const phaseId = readPhaseId(input.userPrompt);

      if (phaseId === 'plan') {
        return {
          text: 'PLAN OUTPUT',
          meta: {
            durationMs: 1,
            stdout: '',
            stderr: '',
            command: ['mock-provider']
          }
        };
      }

      if (phaseId === 'review') {
        return {
          text: 'REVIEW OUTPUT',
          meta: {
            durationMs: 1,
            stdout: '',
            stderr: '',
            command: ['mock-provider']
          }
        };
      }

      return {
        text: `UNEXPECTED:${phaseId}`,
        meta: {
          durationMs: 1,
          stdout: '',
          stderr: '',
          command: ['mock-provider']
        }
      };
    }
  };

  const orchestrator = new Orchestrator({
    providerResolver: () => provider,
    approvalHandler: async () => true
  });

  const result = await orchestrator.run({
    workflowPath,
    runDir,
    workspaceDir,
    request: '테스트 요청'
  });

  assert.equal(result.state.status, 'completed');
  assert.equal(recordedSystemPrompts.some((prompt) => prompt.includes('요청: 테스트 요청')), true);
  assert.equal(recordedSystemPrompts.some((prompt) => prompt.includes('워크플로: prompt-file-flow')), true);
  assert.equal(recordedSystemPrompts.some((prompt) => prompt.includes('당신은 planner')), true);
});

test('Orchestrator는 ASK 분기로 전환해 awaiting_input 상태를 기록한다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-ask-'));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-workspace-'));
  const workflowPath = path.join(workspaceDir, 'refactor.yaml');

  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await writeFile(workflowPath, WORKFLOW_TEMPLATE, 'utf8');
  await setupGitWorkspace(workspaceDir, 'alpha');

  const provider = createMockProvider((phaseId) => {
    if (phaseId === 'plan') {
      return 'PLAN OUTPUT';
    }

    if (phaseId === 'implement') {
      return createFilePatch('alpha', 'beta');
    }

    if (phaseId === 'evaluate') {
      return 'DECISION: ASK';
    }

    if (phaseId === 'ask') {
      return 'ASK OUTPUT';
    }

    if (phaseId === 'review') {
      return 'REVIEW OUTPUT';
    }

    return `UNEXPECTED:${phaseId}`;
  });

  const orchestrator = new Orchestrator({
    providerResolver: () => provider,
    approvalHandler: async () => true
  });

  const result = await orchestrator.run({
    workflowPath,
    runDir,
    workspaceDir,
    request: '테스트 요청'
  });

  assert.equal(result.state.status, 'awaiting_input');
  assert.deepEqual(result.executedPhases, ['plan', 'approve', 'implement', 'evaluate', 'ask']);

  const askArtifact = await readFile(path.join(runDir, 'artifacts', 'ask', 'iter-0005.raw.txt'), 'utf8');
  assert.equal(askArtifact, 'ASK OUTPUT');

  const implementDiff = await readFile(
    path.join(runDir, 'artifacts', 'implement', 'iter-0003.diff.txt'),
    'utf8'
  );
  assert.match(implementDiff, /\+beta/);

  const changedContent = await readFile(path.join(workspaceDir, TARGET_FILE_NAME), 'utf8');
  assert.equal(changedContent, 'beta\n');
});

test('Orchestrator는 gatekeeper 검증 실패 시 auto-fix 재시도를 수행한다.', async (t) => {
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-autofix-'));
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'adt-orchestrator-workspace-'));
  const workflowPath = path.join(workspaceDir, 'refactor.yaml');

  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await writeFile(workflowPath, WORKFLOW_TEMPLATE, 'utf8');
  await setupGitWorkspace(workspaceDir, 'alpha');

  const provider = createMockProvider((phaseId) => {
    if (phaseId === 'plan') {
      return 'PLAN OUTPUT';
    }

    if (phaseId === 'implement') {
      return createFilePatch('alpha', 'beta');
    }

    if (phaseId === 'fix') {
      return createFilePatch('beta', 'gamma');
    }

    if (phaseId === 'review') {
      return 'REVIEW OUTPUT';
    }

    return `UNEXPECTED:${phaseId}`;
  });

  let buildCallCount = 0;
  const gatekeeper = new Gatekeeper({
    commandRunner: {
      run: async ({ commandId }) => {
        if (commandId === 'git-diff-name-status') {
          return createCommandResult(commandId, 'M\tservice.txt\n', '', 0);
        }

        if (commandId === 'git-diff-numstat') {
          return createCommandResult(commandId, '1\t1\tservice.txt\n', '', 0);
        }

        if (commandId === 'build') {
          buildCallCount += 1;

          if (buildCallCount === 1) {
            return createCommandResult(commandId, '', 'build failed', 1);
          }

          return createCommandResult(commandId, 'build ok', '', 0);
        }

        if (commandId === 'test') {
          return createCommandResult(commandId, 'test ok', '', 0);
        }

        return createCommandResult(commandId, '', `unknown command: ${commandId}`, 1);
      }
    }
  });

  const orchestrator = new Orchestrator({
    providerResolver: () => provider,
    approvalHandler: async () => true,
    gatekeeper,
    checkCommandIds: ['build', 'test'],
    maxAutoFixRetries: 2
  });

  const result = await orchestrator.run({
    workflowPath,
    runDir,
    workspaceDir,
    request: '자동 검증 실패 시 fix 재시도'
  });

  assert.equal(result.state.status, 'completed');
  assert.equal(result.state.retries, 1);
  assert.deepEqual(result.executedPhases, ['plan', 'approve', 'implement', 'fix', 'review']);

  const finalContent = await readFile(path.join(workspaceDir, TARGET_FILE_NAME), 'utf8');
  assert.equal(finalContent, 'gamma\n');

  const checkArtifact = await readFile(
    path.join(runDir, 'artifacts', 'implement', 'iter-0003.check-build.txt'),
    'utf8'
  );
  assert.match(checkArtifact, /exit_code: 1/);
});

function createMockProvider(
  responder: (phaseId: string) => string,
  sink: string[] = []
): Provider {
  return {
    id: 'mock',
    capabilities: {
      systemPromptMode: 'inline',
      supportsPatchOutput: true
    },
    async run(input: ProviderRunInput) {
      const phaseId = readPhaseId(input.userPrompt);
      sink.push(phaseId);

      return {
        text: responder(phaseId),
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

function createNamedMockProvider(
  providerId: string,
  responder: (phaseId: string) => string
): Provider {
  return {
    id: providerId,
    capabilities: {
      systemPromptMode: 'inline',
      supportsPatchOutput: true
    },
    async run(input: ProviderRunInput) {
      const phaseId = readPhaseId(input.userPrompt);

      return {
        text: responder(phaseId),
        meta: {
          durationMs: 1,
          stdout: '',
          stderr: '',
          command: [providerId]
        }
      };
    }
  };
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

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe'
  });
}

function createCommandResult(
  commandId: string,
  stdout: string,
  stderr: string,
  exitCode: number
): {
  commandId: string;
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
} {
  return {
    commandId,
    command: [commandId],
    stdout,
    stderr,
    exitCode,
    durationMs: 1,
    timedOut: false
  };
}
