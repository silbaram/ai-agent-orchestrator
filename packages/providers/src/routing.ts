const PROVIDER_PATTERN = /^provider\s*:\s*(.+)$/;
const DEFAULT_WORKFLOW_PATTERN = /^default_workflow\s*:\s*(.+)$/;
const ROLE_SECTION_START = /^roles\s*:\s*$/;
const ROLE_ENTRY_PATTERN = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/;

export interface RoutingConfig {
  provider?: string;
  defaultWorkflow?: string;
  roles: Record<string, string>;
}

export function parseRoutingYaml(routingYamlText: string): RoutingConfig {
  const lines = routingYamlText.split(/\r?\n/);
  const roles: Record<string, string> = {};
  let provider: string | undefined;
  let defaultWorkflow: string | undefined;
  let inRoles = false;
  let roleIndent = 0;

  for (const rawLine of lines) {
    const withoutComment = stripLineComment(rawLine);
    const trimmed = withoutComment.trim();

    if (!trimmed) {
      continue;
    }

    const indentation = countLeadingSpaces(withoutComment);

    if (indentation === 0) {
      inRoles = false;
      roleIndent = 0;

      const providerMatch = trimmed.match(PROVIDER_PATTERN);
      if (providerMatch) {
        provider = unwrapYamlString(providerMatch[1]?.trim() ?? '');
        continue;
      }

      const defaultWorkflowMatch = trimmed.match(DEFAULT_WORKFLOW_PATTERN);
      if (defaultWorkflowMatch) {
        defaultWorkflow = unwrapYamlString(defaultWorkflowMatch[1]?.trim() ?? '');
        continue;
      }

      if (ROLE_SECTION_START.test(trimmed)) {
        inRoles = true;
        roleIndent = indentation + 2;
      }

      continue;
    }

    if (!inRoles) {
      continue;
    }

    if (indentation < roleIndent) {
      inRoles = false;
      roleIndent = 0;
      continue;
    }

    if (indentation === roleIndent) {
      const match = trimmed.match(ROLE_ENTRY_PATTERN);
      if (match) {
        const role = unwrapYamlString(match[1]?.trim() ?? '');
        const providerId = unwrapYamlString(match[2]?.trim() ?? '');

        if (role && providerId) {
          roles[normalizeRole(role)] = providerId;
        }
      }
    }
  }

  return {
    provider,
    defaultWorkflow,
    roles
  };
}

export function resolveProviderForRole(
  config: RoutingConfig,
  role: string | undefined,
  fallbackProviderId?: string
): string | undefined {
  if (!role) {
    return fallbackProviderId;
  }

  const roleProviderId = config.roles[normalizeRole(role)];
  return roleProviderId ?? fallbackProviderId;
}

export function parseProviderIdFromRoutingYaml(routingYamlText: string): string | undefined {
  const parsed = parseRoutingYaml(routingYamlText);
  return parsed.provider;
}

export function parseDefaultWorkflowFromRoutingYaml(routingYamlText: string): string | undefined {
  const parsed = parseRoutingYaml(routingYamlText);
  return parsed.defaultWorkflow;
}
 
function normalizeRole(value: string): string {
  return value.trim().toLowerCase();
}

function stripLineComment(line: string): string {
  const commentIndex = line.indexOf('#');

  if (commentIndex === -1) {
    return line;
  }

  return line.slice(0, commentIndex);
}

function unwrapYamlString(value: string): string {
  if (!value) {
    return '';
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }

  return value.trim();
}

function countLeadingSpaces(value: string): number {
  let count = 0;

  while (count < value.length && value[count] === ' ') {
    count += 1;
  }

  return count;
}
