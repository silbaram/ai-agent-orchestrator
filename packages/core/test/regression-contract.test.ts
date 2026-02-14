import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CommandRunner,
  Gatekeeper,
  Orchestrator,
  parseToolsYaml,
  type Provider,
  type ProviderRunInput,
  type RunState
} from '../src/index.ts';

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
  '    next_on_ask: review',
  '  - id: fix',
  '    type: llm',
  '    role: fixer',
  '    provider: mock',
  '    prompt_template: "phase=fix eval={{phase.evaluate.output}}"',
  '    next: review',
  '  - id: review',
  '    type: llm',
  '    role: reviewer',
  '    provider: mock',
  '    prompt_template: "phase=review latest={{latest_output}}"',
  '    terminal_status: completed',
  ''
].join('\n');

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'regression'
);

test('회귀 계약: tiny repo A는 plan.md/patch-first 최소 계약을 만족한다.', async (t) => {
  const workspaceDir = await prepareFixtureWorkspace('tiny-repo-a');
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-regression-run-a-'));
  const workflowPath = path.join(workspaceDir, 'refactor.yaml');

  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await initializeGitWorkspace(workspaceDir);
  await writeFile(workflowPath, WORKFLOW_TEMPLATE, 'utf8');

  const orchestrator = createOrchestrator({
    workspaceDir,
    runDir,
    provider: createMockProvider({
      plan: createPlanMarkdown('tiny repo A 리팩터링 계획'),
      implement: createTinyRepoAImplementPatch(),
      evaluate: 'DECISION: PASS',
      review: 'review completed'
    })
  });

  const result = await orchestrator.run({
    workflowPath,
    runDir,
    workspaceDir,
    request: 'tiny repo A 계약 테스트'
  });

  assert.equal(result.state.status, 'completed');
  assert.equal(result.state.retries, 0);

  const planArtifact = mustFindArtifact(result.state, 'plan', '.plan.md');
  const planContent = await readFile(path.join(runDir, 'artifacts', planArtifact), 'utf8');
  assertPlanMarkdownContract(planContent);

  assertHasArtifacts(result.state, 'implement', ['.patch', '.diff.txt', '.diffstat.txt']);

  const buildCheckArtifact = mustFindArtifact(result.state, 'implement', '.check-build.txt');
  const buildCheck = await readFile(path.join(runDir, 'artifacts', buildCheckArtifact), 'utf8');
  assert.match(buildCheck, /exit_code: 0/);

  const testCheckArtifact = mustFindArtifact(result.state, 'implement', '.check-test.txt');
  const testCheck = await readFile(path.join(runDir, 'artifacts', testCheckArtifact), 'utf8');
  assert.match(testCheck, /exit_code: 0/);

  const changedSource = await readFile(path.join(workspaceDir, 'src', 'message.js'), 'utf8');
  assert.match(changedSource, /ready:/);
});

test('회귀 계약: tiny repo B는 테스트 실패 후 auto-fix로 복구된다.', async (t) => {
  const workspaceDir = await prepareFixtureWorkspace('tiny-repo-b');
  const runDir = await mkdtemp(path.join(tmpdir(), 'adt-regression-run-b-'));
  const workflowPath = path.join(workspaceDir, 'refactor.yaml');

  t.after(async () => {
    await rm(runDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  await initializeGitWorkspace(workspaceDir);
  await writeFile(workflowPath, WORKFLOW_TEMPLATE, 'utf8');

  const orchestrator = createOrchestrator({
    workspaceDir,
    runDir,
    provider: createMockProvider({
      plan: createPlanMarkdown('tiny repo B auto-fix 계획'),
      implement: createTinyRepoBImplementPatch(),
      evaluate: 'DECISION: PASS',
      fix: createTinyRepoBFixPatch(),
      review: 'review completed'
    }),
    maxAutoFixRetries: 2
  });

  const result = await orchestrator.run({
    workflowPath,
    runDir,
    workspaceDir,
    request: 'tiny repo B auto-fix 계약 테스트'
  });

  assert.equal(result.state.status, 'completed');
  assert.equal(result.state.retries, 1);
  assert.equal(result.executedPhases.includes('fix'), true);

  const planArtifact = mustFindArtifact(result.state, 'plan', '.plan.md');
  const planContent = await readFile(path.join(runDir, 'artifacts', planArtifact), 'utf8');
  assertPlanMarkdownContract(planContent);

  assertHasArtifacts(result.state, 'implement', ['.patch', '.diff.txt', '.diffstat.txt']);
  assertHasArtifacts(result.state, 'fix', ['.patch', '.diff.txt', '.diffstat.txt']);

  const implementTestCheckArtifact = mustFindArtifact(result.state, 'implement', '.check-test.txt');
  const implementTestCheck = await readFile(
    path.join(runDir, 'artifacts', implementTestCheckArtifact),
    'utf8'
  );
  assert.match(implementTestCheck, /exit_code: 1/);

  const fixTestCheckArtifact = mustFindArtifact(result.state, 'fix', '.check-test.txt');
  const fixTestCheck = await readFile(path.join(runDir, 'artifacts', fixTestCheckArtifact), 'utf8');
  assert.match(fixTestCheck, /exit_code: 0/);

  const fixedSource = await readFile(path.join(workspaceDir, 'src', 'math.js'), 'utf8');
  assert.match(fixedSource, /left \* right/);
});

function createOrchestrator(input: {
  workspaceDir: string;
  runDir: string;
  provider: Provider;
  maxAutoFixRetries?: number;
}): Orchestrator {
  const commandRunner = new CommandRunner({
    workspaceDir: input.workspaceDir,
    runDir: input.runDir,
    tools: parseToolsYaml(createToolsYaml(process.execPath))
  });
  const gatekeeper = new Gatekeeper({ commandRunner });

  return new Orchestrator({
    providerResolver: () => input.provider,
    approvalHandler: async () => true,
    gatekeeper,
    checkCommandIds: ['build', 'test'],
    maxAutoFixRetries: input.maxAutoFixRetries
  });
}

function createToolsYaml(nodeExecutable: string): string {
  return [
    'commands:',
    '  - id: git-diff-name-status',
    '    executable: git',
    '    args:',
    '      - diff',
    '      - --name-status',
    '  - id: git-diff-numstat',
    '    executable: git',
    '    args:',
    '      - diff',
    '      - --numstat',
    '  - id: build',
    `    executable: ${nodeExecutable}`,
    '    args:',
    '      - scripts/build.mjs',
    '  - id: test',
    `    executable: ${nodeExecutable}`,
    '    args:',
    '      - scripts/test.mjs',
    ''
  ].join('\n');
}

async function prepareFixtureWorkspace(name: string): Promise<string> {
  const sourceDir = path.join(FIXTURES_ROOT, name);
  const workspaceDir = await mkdtemp(path.join(tmpdir(), `adt-regression-${name}-`));
  await cp(sourceDir, workspaceDir, { recursive: true });
  return workspaceDir;
}

async function initializeGitWorkspace(workspaceDir: string): Promise<void> {
  runGit(workspaceDir, ['init']);
  runGit(workspaceDir, ['add', '.']);
}

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe'
  });
}

function createMockProvider(responses: Record<string, string>): Provider {
  return {
    id: 'mock',
    capabilities: {
      systemPromptMode: 'inline',
      supportsPatchOutput: true
    },
    async run(input: ProviderRunInput) {
      const phaseId = readPhaseId(input.userPrompt);

      return {
        text: responses[phaseId] ?? `UNEXPECTED:${phaseId}`,
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

function readPhaseId(prompt: string): string {
  const match = prompt.match(/phase=([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? 'unknown';
}

function createPlanMarkdown(title: string): string {
  return [
    '# Plan',
    '',
    `## 목표`,
    `- ${title}`,
    '',
    '## 작업 항목',
    '- [ ] 핵심 파일 변경',
    '- [ ] 빌드/테스트 확인',
    '',
    '## 검증',
    '- build: node scripts/build.mjs',
    '- test: node scripts/test.mjs'
  ].join('\n');
}

function assertPlanMarkdownContract(value: string): void {
  assert.match(value, /^#\s+Plan/m);
  assert.match(value, /^##\s+목표/m);
  assert.match(value, /^##\s+작업 항목/m);
  assert.match(value, /^##\s+검증/m);
  assert.match(value, /^- \[[ x]\]\s+/m);
}

function assertHasArtifacts(state: RunState, phaseId: string, requiredSuffixes: string[]): void {
  const artifacts = state.artifacts[phaseId] ?? [];

  for (const suffix of requiredSuffixes) {
    assert.equal(
      artifacts.some((artifact) => artifact.endsWith(suffix)),
      true,
      `${phaseId} phase에 ${suffix} artifact가 없습니다.`
    );
  }
}

function mustFindArtifact(state: RunState, phaseId: string, suffix: string): string {
  const artifacts = state.artifacts[phaseId] ?? [];
  const found = artifacts.find((artifact) => artifact.endsWith(suffix));

  assert.ok(found, `${phaseId} phase에 ${suffix} artifact가 없습니다.`);
  return found;
}

function createTinyRepoAImplementPatch(): string {
  return [
    '```diff',
    'diff --git a/src/message.js b/src/message.js',
    '--- a/src/message.js',
    '+++ b/src/message.js',
    '@@ -1,3 +1,3 @@',
    ' export function createMessage(scope) {',
    '-  return `draft:${scope}`;',
    '+  return `ready:${scope}`;',
    ' }',
    'diff --git a/scripts/build.mjs b/scripts/build.mjs',
    '--- a/scripts/build.mjs',
    '+++ b/scripts/build.mjs',
    '@@ -3,4 +3,4 @@',
    " import { createMessage } from '../src/message.js';",
    ' ',
    " assert.equal(typeof createMessage, 'function');",
    "-assert.equal(createMessage('workspace'), 'draft:workspace');",
    "+assert.equal(createMessage('workspace'), 'ready:workspace');",
    'diff --git a/scripts/test.mjs b/scripts/test.mjs',
    '--- a/scripts/test.mjs',
    '+++ b/scripts/test.mjs',
    '@@ -1,5 +1,5 @@',
    " import assert from 'node:assert/strict';",
    ' ',
    " import { createMessage } from '../src/message.js';",
    ' ',
    "-assert.equal(createMessage('workspace'), 'draft:workspace');",
    "+assert.equal(createMessage('workspace'), 'ready:workspace');",
    '```'
  ].join('\n');
}

function createTinyRepoBImplementPatch(): string {
  return [
    '```diff',
    'diff --git a/README.md b/README.md',
    '--- a/README.md',
    '+++ b/README.md',
    '@@ -1,3 +1,5 @@',
    ' # Tiny Repo B',
    ' ',
    ' Phase 09 auto-fix 회귀 테스트용 fixture.',
    '+',
    '+phase: implement',
    '```'
  ].join('\n');
}

function createTinyRepoBFixPatch(): string {
  return [
    '```diff',
    'diff --git a/src/math.js b/src/math.js',
    '--- a/src/math.js',
    '+++ b/src/math.js',
    '@@ -1,3 +1,3 @@',
    ' export function multiply(left, right) {',
    '-  return left + right;',
    '+  return left * right;',
    ' }',
    '```'
  ].join('\n');
}
