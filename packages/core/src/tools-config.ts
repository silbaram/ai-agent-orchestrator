export interface AllowedToolCommand {
  id: string;
  executable: string;
  args: string[];
  timeoutMs?: number;
}

export interface ToolsConfig {
  commands: AllowedToolCommand[];
}

export function parseToolsYaml(yamlText: string): ToolsConfig {
  const lines = yamlText.split(/\r?\n/);
  const commands: AllowedToolCommand[] = [];

  let inCommandsSection = false;
  let inArgsSection = false;
  let current: Partial<AllowedToolCommand> | null = null;
  let currentArgs: string[] = [];

  for (const originalLine of lines) {
    const withoutComment = stripLineComment(originalLine).trimEnd();

    if (!withoutComment.trim()) {
      continue;
    }

    const indentation = countLeadingSpaces(withoutComment);
    const trimmed = withoutComment.trim();

    if (indentation === 0) {
      if (trimmed === 'commands:') {
        inCommandsSection = true;
        inArgsSection = false;
        continue;
      }

      if (inCommandsSection) {
        flushCurrentCommand(commands, current, currentArgs);
        current = null;
        currentArgs = [];
      }

      inCommandsSection = false;
      inArgsSection = false;
      continue;
    }

    if (!inCommandsSection) {
      continue;
    }

    if (indentation === 2 && trimmed.startsWith('- ')) {
      flushCurrentCommand(commands, current, currentArgs);

      current = {};
      currentArgs = [];
      inArgsSection = false;

      const inline = trimmed.slice(2).trim();
      if (inline) {
        const [key, value] = parseKeyValue(inline);
        assignCommandProperty(current, key, value);
      }

      continue;
    }

    if (!current) {
      throw new Error(`tools.yaml 파싱 실패: command 항목이 없습니다. (${originalLine})`);
    }

    if (indentation === 4 && trimmed === 'args:') {
      inArgsSection = true;
      continue;
    }

    if (indentation >= 6 && inArgsSection && trimmed.startsWith('- ')) {
      currentArgs.push(unwrapYamlString(trimmed.slice(2).trim()));
      continue;
    }

    if (indentation === 4) {
      inArgsSection = false;
      const [key, value] = parseKeyValue(trimmed);
      assignCommandProperty(current, key, value);
      continue;
    }

    throw new Error(`tools.yaml 파싱 실패: 지원하지 않는 형식입니다. (${originalLine})`);
  }

  flushCurrentCommand(commands, current, currentArgs);

  if (commands.length === 0) {
    throw new Error('tools.yaml 파싱 실패: commands 항목이 비어 있습니다.');
  }

  assertNoDuplicateCommandIds(commands);

  return { commands };
}

function flushCurrentCommand(
  target: AllowedToolCommand[],
  current: Partial<AllowedToolCommand> | null,
  args: string[]
): void {
  if (!current) {
    return;
  }

  const id = requiredValue(current.id, 'commands[].id');
  const executable = requiredValue(current.executable, `commands[${id}].executable`);
  const timeoutMs = current.timeoutMs;

  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`commands[${id}].timeout_ms는 1 이상의 정수여야 합니다.`);
  }

  target.push({
    id,
    executable,
    args: [...args],
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  });
}

function assignCommandProperty(
  command: Partial<AllowedToolCommand>,
  key: string,
  value: string
): void {
  if (key === 'id') {
    command.id = unwrapYamlString(value);
    return;
  }

  if (key === 'executable') {
    command.executable = unwrapYamlString(value);
    return;
  }

  if (key === 'timeout_ms') {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`timeout_ms는 1 이상의 정수여야 합니다: ${value}`);
    }

    command.timeoutMs = parsed;
    return;
  }

  throw new Error(`tools.yaml 파싱 실패: 지원하지 않는 key입니다 (${key})`);
}

function parseKeyValue(line: string): [string, string] {
  const separatorIndex = line.indexOf(':');

  if (separatorIndex === -1) {
    throw new Error(`key: value 형식이 아닙니다: ${line}`);
  }

  const key = line.slice(0, separatorIndex).trim();
  const value = line.slice(separatorIndex + 1).trim();

  if (!key) {
    throw new Error(`key가 비어 있습니다: ${line}`);
  }

  return [key, value];
}

function requiredValue(value: string | undefined, label: string): string {
  const normalized = value?.trim();

  if (!normalized) {
    throw new Error(`${label}는 필수입니다.`);
  }

  return normalized;
}

function stripLineComment(line: string): string {
  const commentIndex = line.indexOf('#');

  if (commentIndex === -1) {
    return line;
  }

  return line.slice(0, commentIndex);
}

function countLeadingSpaces(value: string): number {
  let count = 0;

  while (count < value.length && value[count] === ' ') {
    count += 1;
  }

  return count;
}

function unwrapYamlString(value: string): string {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function assertNoDuplicateCommandIds(commands: AllowedToolCommand[]): void {
  const seen = new Set<string>();

  for (const command of commands) {
    if (seen.has(command.id)) {
      throw new Error(`tools.yaml 파싱 실패: command id가 중복되었습니다 (${command.id}).`);
    }

    seen.add(command.id);
  }
}
