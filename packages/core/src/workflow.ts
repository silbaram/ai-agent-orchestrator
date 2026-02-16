import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunStatus } from './state-store.ts';

export type WorkflowPhaseType = 'llm' | 'approval';
export type WorkflowDecision = 'pass' | 'fix' | 'ask';

interface WorkflowPhaseBase {
  id: string;
  type: WorkflowPhaseType;
  promptTemplate: string;
  terminalStatus?: RunStatus;
}

export interface LlmWorkflowPhase extends WorkflowPhaseBase {
  type: 'llm';
  role: string;
  provider?: string;
  systemPromptTemplate?: string;
  systemPromptFile?: string;
  next?: string;
  decisionSource?: 'output_tag';
  nextOnPass?: string;
  nextOnFix?: string;
  nextOnAsk?: string;
}

export interface ApprovalWorkflowPhase extends WorkflowPhaseBase {
  type: 'approval';
  nextOnApprove?: string;
  nextOnReject?: string;
}

export type WorkflowPhase = LlmWorkflowPhase | ApprovalWorkflowPhase;

export interface WorkflowDefinition {
  name: string;
  entryPhase: string;
  maxSteps: number;
  phases: WorkflowPhase[];
}

const DEFAULT_MAX_STEPS = 20;
const VALID_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'created',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'completed',
  'failed',
  'canceled'
]);

export async function loadWorkflowFromFile(filePath: string): Promise<WorkflowDefinition> {
  const absolutePath = path.resolve(filePath);
  const raw = await readFile(absolutePath, 'utf8');
  return parseWorkflowYaml(raw);
}

export function parseWorkflowYaml(yamlText: string): WorkflowDefinition {
  const lines = yamlText.split(/\r?\n/);
  const topLevel = new Map<string, string>();
  const phaseEntries: Array<Record<string, string>> = [];

  let inPhases = false;
  let currentPhase: Record<string, string> | null = null;

  for (const originalLine of lines) {
    const withoutComment = stripLineComment(originalLine).trimEnd();

    if (!withoutComment.trim()) {
      continue;
    }

    const indentation = countLeadingSpaces(withoutComment);
    const trimmed = withoutComment.trim();

    if (inPhases && indentation < 2) {
      inPhases = false;
      currentPhase = null;
    }

    if (!inPhases) {
      if (trimmed === 'phases:') {
        inPhases = true;
        continue;
      }

      const [key, value] = parseKeyValue(trimmed);
      topLevel.set(key, value);
      continue;
    }

    if (trimmed.startsWith('- ')) {
      currentPhase = {};
      phaseEntries.push(currentPhase);

      const inline = trimmed.slice(2).trim();
      if (inline) {
        const [key, value] = parseKeyValue(inline);
        currentPhase[key] = value;
      }

      continue;
    }

    if (indentation < 4 || !currentPhase) {
      throw new Error(`지원하지 않는 workflow phases 형식입니다: ${originalLine}`);
    }

    const [key, value] = parseKeyValue(trimmed);
    currentPhase[key] = value;
  }

  const name = requiredValue(topLevel.get('name'), 'name');
  if (phaseEntries.length === 0) {
    throw new Error('phases는 최소 1개 이상이어야 합니다.');
  }

  const phases = phaseEntries.map(parsePhaseEntry);
  const phaseIds = new Set<string>();

  for (const phase of phases) {
    if (phaseIds.has(phase.id)) {
      throw new Error(`phase id가 중복되었습니다: ${phase.id}`);
    }

    phaseIds.add(phase.id);
  }

  const entryPhase = topLevel.get('entry_phase')?.trim() || phases[0]?.id;
  if (!entryPhase) {
    throw new Error('entry phase를 결정할 수 없습니다.');
  }

  if (!phaseIds.has(entryPhase)) {
    throw new Error(`entry_phase가 phases에 없습니다: ${entryPhase}`);
  }

  const maxStepsRaw = topLevel.get('max_steps');
  const maxSteps = maxStepsRaw ? parsePositiveInteger(maxStepsRaw, 'max_steps') : DEFAULT_MAX_STEPS;

  for (const phase of phases) {
    validatePhaseTransitions(phase, phaseIds);
  }

  return {
    name,
    entryPhase,
    maxSteps,
    phases
  };
}

function parsePhaseEntry(entry: Record<string, string>): WorkflowPhase {
  const id = requiredValue(entry.id, 'phases[].id');
  const phaseType = (entry.type?.trim() || 'llm') as WorkflowPhaseType;
  const promptTemplate = requiredValue(
    entry.prompt_template ?? entry.prompt,
    `phases[${id}].prompt_template`
  );

  const terminalStatus = parseOptionalRunStatus(entry.terminal_status);

  if (phaseType === 'approval') {
    return {
      id,
      type: 'approval',
      promptTemplate,
      nextOnApprove: optionalValue(entry.next_on_approve),
      nextOnReject: optionalValue(entry.next_on_reject),
      terminalStatus
    };
  }

  if (phaseType !== 'llm') {
    throw new Error(`지원하지 않는 phase.type입니다: ${phaseType}`);
  }

  const role = requiredValue(entry.role, `phases[${id}].role`);
  const decisionSourceRaw = optionalValue(entry.decision_source);
  if (decisionSourceRaw && decisionSourceRaw !== 'output_tag') {
    throw new Error(`지원하지 않는 decision_source입니다: ${decisionSourceRaw}`);
  }

  return {
    id,
    type: 'llm',
    role,
    provider: optionalValue(entry.provider),
    systemPromptTemplate: optionalValue(entry.system_prompt),
    systemPromptFile: optionalValue(entry.system_prompt_file),
    promptTemplate,
    next: optionalValue(entry.next),
    decisionSource: decisionSourceRaw,
    nextOnPass: optionalValue(entry.next_on_pass),
    nextOnFix: optionalValue(entry.next_on_fix),
    nextOnAsk: optionalValue(entry.next_on_ask),
    terminalStatus
  };
}

function validatePhaseTransitions(phase: WorkflowPhase, phaseIds: Set<string>): void {
  if (phase.type === 'approval') {
    assertTransitionTarget(phase.nextOnApprove, phaseIds, `${phase.id}.next_on_approve`);
    assertTransitionTarget(phase.nextOnReject, phaseIds, `${phase.id}.next_on_reject`);
    return;
  }

  assertTransitionTarget(phase.next, phaseIds, `${phase.id}.next`);
  assertTransitionTarget(phase.nextOnPass, phaseIds, `${phase.id}.next_on_pass`);
  assertTransitionTarget(phase.nextOnFix, phaseIds, `${phase.id}.next_on_fix`);
  assertTransitionTarget(phase.nextOnAsk, phaseIds, `${phase.id}.next_on_ask`);
}

function assertTransitionTarget(
  candidatePhaseId: string | undefined,
  phaseIds: Set<string>,
  label: string
): void {
  if (!candidatePhaseId) {
    return;
  }

  if (!phaseIds.has(candidatePhaseId)) {
    throw new Error(`전이 대상 phase가 없습니다: ${label} -> ${candidatePhaseId}`);
  }
}

function parseOptionalRunStatus(value: string | undefined): RunStatus | undefined {
  const normalized = optionalValue(value);
  if (!normalized) {
    return undefined;
  }

  if (!VALID_RUN_STATUSES.has(normalized as RunStatus)) {
    throw new Error(`지원하지 않는 terminal_status입니다: ${normalized}`);
  }

  return normalized as RunStatus;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value.trim(), 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label}는 1 이상의 정수여야 합니다: ${value}`);
  }

  return parsed;
}

function parseKeyValue(line: string): [string, string] {
  const separatorIndex = line.indexOf(':');

  if (separatorIndex === -1) {
    throw new Error(`key: value 형식이 아닙니다: ${line}`);
  }

  const key = line.slice(0, separatorIndex).trim();
  const rawValue = line.slice(separatorIndex + 1).trim();

  if (!key) {
    throw new Error(`key가 비어 있습니다: ${line}`);
  }

  return [key, parseScalarValue(rawValue)];
}

function parseScalarValue(raw: string): string {
  if (!raw) {
    return '';
  }

  const first = raw[0];
  const last = raw[raw.length - 1];

  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    const body = raw.slice(1, -1);
    const unescaped = body
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
      .replaceAll('\\"', '"')
      .replaceAll("\\'", "'")
      .replaceAll('\\\\', '\\');

    return unescaped;
  }

  return raw;
}

function stripLineComment(line: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (character === '#' && !inSingleQuote && !inDoubleQuote) {
      return line.slice(0, index);
    }
  }

  return line;
}

function countLeadingSpaces(line: string): number {
  let count = 0;

  while (count < line.length && line[count] === ' ') {
    count += 1;
  }

  return count;
}

function requiredValue(value: string | undefined, label: string): string {
  const normalized = optionalValue(value);
  if (!normalized) {
    throw new Error(`${label}는 필수입니다.`);
  }

  return normalized;
}

function optionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
