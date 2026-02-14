const PROVIDER_PATTERN = /^provider\s*:\s*(.+)$/;

export function parseProviderIdFromRoutingYaml(routingYamlText: string): string | undefined {
  const lines = routingYamlText.split(/\r?\n/);

  for (const line of lines) {
    const withoutComment = stripLineComment(line).trim();

    if (!withoutComment) {
      continue;
    }

    const match = withoutComment.match(PROVIDER_PATTERN);

    if (!match) {
      continue;
    }

    const providerId = unwrapYamlString(match[1]?.trim() ?? '');

    if (providerId) {
      return providerId;
    }
  }

  return undefined;
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
