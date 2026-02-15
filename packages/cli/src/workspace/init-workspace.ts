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
    '  manager: gemini-cli',
    '  planner: codex-cli',
    '  developer: claude-cli',
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
    '    system_prompt: "당신은 AAO의 manager다. 사용자에게 보여줄 메시지를 작성하되 코드 변경은 절대 생성하지 않는다."',
    '    prompt_template: "요청={{request}}|plan={{phase.plan.output}}. 아래 형식으로 사용자 승인 메시지를 작성하세요. # USER_UPDATE\\n## TL;DR\\n## What changed\\n## Risks\\n## Actions needed (Y/n 또는 선택지)\\n## Next"',
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
    '    system_prompt: "당신은 AAO의 manager다. 사용자가 이해할 수 있도록 상태만 전달하고 코드 변경은 생성하지 않는다."',
    '    prompt_template: "요청={{request}} evaluate={{phase.evaluate.output}}. 변경 요약, 다음 액션, 주의점만 정리한 아래 형식으로 사용자 메시지를 작성하세요. # USER_UPDATE\\n## TL;DR\\n## What changed\\n## Risks\\n## Actions needed (Y/n 또는 선택지)\\n## Next"',
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
  'config/workflows/feature.yaml': [
    'name: feature',
    'entry_phase: plan',
    'max_steps: 20',
    'phases:',
    '  - id: plan',
    '    type: llm',
    '    role: planner',
    '    provider: codex-cli',
    '    system_prompt: "당신은 주문 페이지 중심의 기능 개발 plan을 작성하는 planner다."',
    '    prompt_template: "요청={{request}}. 주문 페이지 기능 구현 계획을 작성하고 체크리스트 형태로 정리하세요."',
    '    next: manager_report_plan',
    '  - id: manager_report_plan',
    '    type: llm',
    '    role: manager',
    '    provider: gemini-cli',
    '    system_prompt: "당신은 AAO의 manager다. 사용자가 승인하기 쉬운 형태로만 요약 메시지를 작성하고 코드 변경은 생성하지 않는다."',
    '    prompt_template: "요청={{request}} plan={{phase.plan.output}}. 아래 형식으로 승인용 메시지를 작성하세요. # USER_UPDATE\\n## TL;DR\\n## What changed\\n## Risks\\n## Actions needed (Y/n 또는 선택지)\\n## Next"',
    '    next: approve',
    '  - id: approve',
    '    type: approval',
    '    prompt_template: "요청={{request}} plan={{phase.plan.output}} plan_msg={{phase.manager_report_plan.output}}"',
    '    next_on_approve: implement',
    '  - id: implement',
    '    type: llm',
    '    role: developer',
    '    provider: claude-cli',
    '    system_prompt: "당신은 주문 페이지 기능을 구현하는 developer다."',
    '    prompt_template: "요청={{request}} plan={{phase.plan.output}} 반드시 ```diff 코드블록 또는 ### PATCH 섹션으로 patch만 출력하세요."',
    '    next: evaluate',
    '  - id: evaluate',
    '    type: llm',
    '    role: evaluator',
    '    provider: codex-cli',
    '    system_prompt: "당신은 구현 결과를 build/test 체크 관점에서 평가하는 evaluator다."',
    '    prompt_template: "요청={{request}} implement={{phase.implement.output}} build/test 체크 결과를 반영해 DECISION: PASS|FIX|ASK 중 하나를 반드시 한 줄에 포함하세요."',
    '    decision_source: output_tag',
    '    next_on_pass: manager_report_result',
    '    next_on_fix: manager_report_result',
    '    next_on_ask: manager_report_result',
    '    next: manager_report_result',
    '  - id: manager_report_result',
    '    type: llm',
    '    role: manager',
    '    provider: gemini-cli',
    '    system_prompt: "당신은 AAO의 manager다. 구현/평가 결과를 사용자 메시지로 요약하고 코드 변경은 생성하지 않는다."',
    '    prompt_template: "요청={{request}} evaluate={{phase.evaluate.output}}. 아래 형식으로 변경보고서를 작성하세요. # USER_UPDATE\\n## TL;DR\\n## What changed\\n## Risks\\n## Actions needed (Y/n 또는 선택지)\\n## Next"',
    '    next: review',
    '  - id: review',
    '    type: llm',
    '    role: reviewer',
    '    provider: gemini-cli',
    '    system_prompt: "당신은 최종 결과를 review 관점에서 요약하는 reviewer다."',
    '    prompt_template: "요청={{request}} latest={{latest_output}}"',
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
    '    system_prompt: "당신은 AAO의 manager다. 사용자의 승인 판단에 필요한 메시지 전용 응답을 작성하고 코드 변경은 하지 않는다."',
    '    prompt_template: "요청={{request}} plan={{phase.plan.output}}. 아래 형식으로 승인용 메시지를 작성하세요. # USER_UPDATE\\n## TL;DR\\n## What changed\\n## Risks\\n## Actions needed (Y/n 또는 선택지)\\n## Next"',
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
    '    system_prompt: "당신은 AAO의 manager다. 결과를 사용자에게 알리는 메시지를 작성하고 코드 변경은 하지 않는다."',
    '    prompt_template: "요청={{request}} evaluate={{phase.evaluate.output}}. 구현/테스트 후 사용자용 보고서를 아래 형식으로 작성하세요. # USER_UPDATE\\n## TL;DR\\n## What changed\\n## Risks\\n## Actions needed (Y/n 또는 선택지)\\n## Next"',
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
