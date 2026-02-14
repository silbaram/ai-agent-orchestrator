import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_WORKSPACE_NAME = 'ai-dev-team';
const WORKSPACE_DIRECTORIES = [
  'artifacts',
  'roles',
  'rules',
  'config',
  'config/workflows',
  'state'
] as const;
const WORKSPACE_TEMPLATES: Record<string, string> = {
  'config/routing.yaml': [
    'provider: codex-cli',
    'default_workflow: refactor',
    'roles:',
    '  planner: planner',
    '  developer: developer',
    '  evaluator: evaluator',
    '  fixer: fixer',
    '  reviewer: reviewer',
    ''
  ].join('\n'),
  'config/gatekeeper.yaml': [
    'approval:',
    '  required_for:',
    '    - delete_file',
    '    - large_change',
    '    - security_change',
    'auto_fix:',
    '  max_retries: 2',
    'checks:',
    '  command_ids:',
    '    - build',
    '    - test',
    ''
  ].join('\n'),
  'config/tools.yaml': [
    'commands:',
    '  - id: git-diff-name-status',
    '    executable: git',
    '    args:',
    '      - diff',
    '      - --name-status',
    '    timeout_ms: 15000',
    '  - id: git-diff-numstat',
    '    executable: git',
    '    args:',
    '      - diff',
    '      - --numstat',
    '    timeout_ms: 15000',
    '  - id: build',
    '    executable: pnpm',
    '    args:',
    '      - -w',
    '      - build',
    '    timeout_ms: 180000',
    '  - id: test',
    '    executable: pnpm',
    '    args:',
    '      - -w',
    '      - test',
    '    timeout_ms: 180000',
    ''
  ].join('\n'),
  'config/workflows/refactor.yaml': [
    'name: refactor',
    'entry_phase: plan',
    'max_steps: 16',
    'phases:',
    '  - id: plan',
    '    type: llm',
    '    role: planner',
    '    provider: codex-cli',
    '    system_prompt: "당신은 요청을 실행 계획으로 분해하는 planner다."',
    '    prompt_template: "phase=plan request={{request}}"',
    '    next: approve',
    '  - id: approve',
    '    type: approval',
    '    prompt_template: "계획안을 승인할까요? 계획: {{phase.plan.output}}"',
    '    next_on_approve: implement',
    '    next_on_reject: ask',
    '  - id: implement',
    '    type: llm',
    '    role: developer',
    '    provider: codex-cli',
    '    system_prompt: "당신은 승인된 계획을 코드 변경안으로 구현하는 developer다."',
    '    prompt_template: "phase=implement request={{request}} plan={{phase.plan.output}} 반드시 ```diff 코드블록 또는 ### PATCH 섹션으로 patch만 출력하세요."',
    '    next: evaluate',
    '  - id: evaluate',
    '    type: llm',
    '    role: evaluator',
    '    provider: codex-cli',
    '    system_prompt: "당신은 결과 품질을 평가하는 evaluator다."',
    '    prompt_template: "phase=evaluate implementation={{phase.implement.output}} DECISION: PASS|FIX|ASK 중 하나를 반드시 포함하세요."',
    '    decision_source: output_tag',
    '    next_on_pass: review',
    '    next_on_fix: fix',
    '    next_on_ask: ask',
    '  - id: fix',
    '    type: llm',
    '    role: fixer',
    '    provider: codex-cli',
    '    system_prompt: "당신은 평가 피드백을 반영해 수정하는 fixer다."',
    '    prompt_template: "phase=fix feedback={{phase.evaluate.output}} request={{request}} 반드시 ```diff 코드블록 또는 ### PATCH 섹션으로 patch만 출력하세요."',
    '    next: review',
    '  - id: ask',
    '    type: llm',
    '    role: planner',
    '    provider: codex-cli',
    '    system_prompt: "당신은 진행에 필요한 추가 정보를 요청하는 planner다."',
    '    prompt_template: "phase=ask feedback={{phase.evaluate.output}} request={{request}}"',
    '    terminal_status: awaiting_input',
    '  - id: review',
    '    type: llm',
    '    role: reviewer',
    '    provider: codex-cli',
    '    system_prompt: "당신은 최종 결과를 요약하는 reviewer다."',
    '    prompt_template: "phase=review latest={{latest_output}} request={{request}}"',
    '    terminal_status: completed',
    ''
  ].join('\n')
};

export interface InitWorkspaceOptions {
  baseDir?: string;
  workspaceName?: string;
  force?: boolean;
}

export interface InitWorkspaceResult {
  workspacePath: string;
  createdPaths: string[];
}

export async function initWorkspace(
  options: InitWorkspaceOptions = {}
): Promise<InitWorkspaceResult> {
  const baseDir = options.baseDir ?? process.cwd();
  const workspaceName = options.workspaceName ?? DEFAULT_WORKSPACE_NAME;
  const force = options.force ?? false;
  const workspacePath = path.resolve(baseDir, workspaceName);

  if (force) {
    throw new Error('--force 옵션은 아직 지원되지 않습니다.');
  }

  if (await exists(workspacePath)) {
    throw new Error(`워크스페이스가 이미 존재합니다: ${workspacePath}`);
  }

  const createdPaths: string[] = [];

  await mkdir(workspacePath);
  createdPaths.push(workspacePath);

  for (const relativeDirectory of WORKSPACE_DIRECTORIES) {
    const directoryPath = path.join(workspacePath, relativeDirectory);
    await mkdir(directoryPath, { recursive: true });
    createdPaths.push(directoryPath);
  }

  for (const [relativeFilePath, content] of Object.entries(WORKSPACE_TEMPLATES)) {
    const filePath = path.join(workspacePath, relativeFilePath);
    await writeFile(filePath, content, 'utf8');
    createdPaths.push(filePath);
  }

  return { workspacePath, createdPaths };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
