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
    '  manager: gemini',
    '  planner: codex-cli',
    '  developer: claude',
    '  evaluator: codex-cli',
    '  fixer: codex-cli',
    '  reviewer: codex-cli',
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
    '    system_prompt: "당신은 요청을 실행 계획으로 분해하는 planner다."',
    '    prompt_template: "phase=plan request={{request}}"',
    '    next: manager_plan_report',
    '  - id: manager_plan_report',
    '    type: llm',
    '    role: manager',
    '    system_prompt: "당신은 AAO의 manager다. 사용자의 승인 판단에 필요한 핵심 요약과 승인 문구를 생성한다."',
    '    prompt_template: "요청={{request}}|plan={{phase.plan.output}}. 위 내용을 바탕으로 사용자에게 보여줄 승인 메시지를 생성하세요."',
    '    next: approve',
    '  - id: approve',
    '    type: approval',
    '    prompt_template: "다음 내용을 확인하고 승인하세요: {{phase.manager_plan_report.output}}"',
    '    next_on_approve: implement',
    '    next_on_reject: ask',
    '  - id: implement',
    '    type: llm',
    '    role: developer',
    '    system_prompt: "당신은 승인된 계획을 코드 변경안으로 구현하는 developer다."',
    '    prompt_template: "phase=implement request={{request}} plan={{phase.plan.output}} 반드시 ```diff 코드블록 또는 ### PATCH 섹션으로 patch만 출력하세요."',
    '    next: evaluate',
    '  - id: evaluate',
    '    type: llm',
    '    role: evaluator',
    '    system_prompt: "당신은 결과 품질을 평가하는 evaluator다."',
    '    prompt_template: "phase=evaluate implementation={{phase.implement.output}} DECISION: PASS|FIX|ASK 중 하나를 반드시 포함하세요."',
    '    decision_source: output_tag',
    '    next_on_pass: manager_review_report',
    '    next_on_fix: fix',
    '    next_on_ask: ask',
    '  - id: manager_review_report',
    '    type: llm',
    '    role: manager',
    '    system_prompt: "당신은 AAO의 manager다. 평가 결과를 바탕으로 사용자 친화적인 리뷰 요약을 생성한다."',
    '    prompt_template: "요청={{request}}|evaluate={{phase.evaluate.output}}. 검토 보고서를 한글로 작성하고 사용자 확인 사항을 1~2개 제안하세요."',
    '    next: review',
    '  - id: fix',
    '    type: llm',
    '    role: fixer',
    '    system_prompt: "당신은 평가 피드백을 반영해 수정하는 fixer다."',
    '    prompt_template: "phase=fix feedback={{phase.evaluate.output}} request={{request}} 반드시 ```diff 코드블록 또는 ### PATCH 섹션으로 patch만 출력하세요."',
    '    next: review',
    '  - id: ask',
    '    type: llm',
    '    role: planner',
    '    system_prompt: "당신은 진행에 필요한 추가 정보를 요청하는 planner다."',
    '    prompt_template: "phase=ask feedback={{phase.evaluate.output}} request={{request}}"',
    '    terminal_status: awaiting_input',
    '  - id: review',
    '    type: llm',
    '    role: reviewer',
    '    system_prompt: "당신은 최종 결과를 요약하는 reviewer다."',
    '    prompt_template: "phase=review latest={{latest_output}} request={{request}}"',
    '    terminal_status: completed',
    ''
  ].join('\n'),
  'config/workflows/feature-order-page.yaml': [
    'name: feature-order-page',
    'entry_phase: plan',
    'max_steps: 20',
    'phases:',
    '  - id: plan',
    '    type: llm',
    '    role: planner',
    '    system_prompt: "당신은 주문 페이지 기획/기능 범위를 작성하는 planner다."',
    '    prompt_template: "요청={{request}} 주문 페이지 요구사항을 계획 단계로 분해하세요."',
    '    next: manager_plan_report',
    '  - id: manager_plan_report',
    '    type: llm',
    '    role: manager',
    '    system_prompt: "당신은 AAO의 manager다. 사용자 승인용 계획 보고서를 작성한다."',
    '    prompt_template: "요청={{request}} plan={{phase.plan.output}}. 이 계획의 범위, 영향, 리스크를 요약해 승인 문구로 작성하세요."',
    '    next: approve',
    '  - id: approve',
    '    type: approval',
    '    prompt_template: "주문 페이지 작업 승인 필요: {{phase.manager_plan_report.output}}"',
    '    next_on_approve: implement',
    '    next_on_reject: ask',
    '  - id: implement',
    '    type: llm',
    '    role: developer',
    '    system_prompt: "당신은 주문 페이지 기능을 구현하는 developer다."',
    '    prompt_template: "phase=implement request={{request}} plan={{phase.plan.output}} 반드시 ```diff 코드블록 또는 ### PATCH 섹션으로 patch만 출력하세요."',
    '    next: evaluate',
    '  - id: evaluate',
    '    type: llm',
    '    role: evaluator',
    '    system_prompt: "당신은 주문 페이지 결과를 테스트 기반으로 평가한다."',
    '    prompt_template: "phase=evaluate implementation={{phase.implement.output}} DECISION: PASS|FIX|ASK 중 하나를 반드시 포함하세요."',
    '    decision_source: output_tag',
    '    next_on_pass: manager_review_report',
    '    next_on_fix: fix',
    '    next_on_ask: ask',
    '  - id: manager_review_report',
    '    type: llm',
    '    role: manager',
    '    system_prompt: "당신은 AAO의 manager다. 평가 후 사용자에게 품질 요약 및 운영 리스크를 전달한다."',
    '    prompt_template: "요청={{request}} evaluate={{phase.evaluate.output}} 리뷰 요약을 한글로 생성하고 사용자 확인 포인트를 제시하세요."',
    '    next: review',
    '  - id: fix',
    '    type: llm',
    '    role: fixer',
    '    system_prompt: "당신은 평가 피드백을 반영해 주문 페이지를 수정하는 fixer다."',
    '    prompt_template: "phase=fix feedback={{phase.evaluate.output}} request={{request}} 반드시 ```diff 코드블록 또는 ### PATCH 섹션으로 patch만 출력하세요."',
    '    next: review',
    '  - id: ask',
    '    type: llm',
    '    role: planner',
    '    system_prompt: "당신은 필요한 추가 정보를 요청하는 planner다."',
    '    prompt_template: "phase=ask feedback={{phase.evaluate.output}} request={{request}}"',
    '    terminal_status: awaiting_input',
    '  - id: review',
    '    type: llm',
    '    role: reviewer',
    '    system_prompt: "당신은 주문 페이지 작업 결과를 요약하는 reviewer다."',
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
