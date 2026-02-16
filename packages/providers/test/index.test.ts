import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  buildCodexExecCommand,
  buildClaudeExecCommand,
  buildGeminiExecCommand,
  createProviderFromSelection,
  createProviderRegistry,
  parseDefaultWorkflowFromRoutingYaml,
  parseRoutingYaml,
  resolveProviderForRole,
  resolveProviderForRoleFromRoutingYaml,
  parseProviderIdFromRoutingYaml,
  resolveProviderId
} from '../src/index.ts';

test('buildCodexExecCommand는 기본 codex exec 명령을 구성한다.', () => {
  const command = buildCodexExecCommand({
    systemPrompt: '시스템',
    userPrompt: '유저',
    workspaceDir: './workspace'
  });

  assert.equal(command.command, 'codex');
  assert.deepEqual(command.args, ['exec', '--color', 'never', '-C', path.resolve('./workspace')]);
  assert.match(command.stdin, /\[SYSTEM\]\n시스템/);
  assert.match(command.stdin, /\[USER\]\n유저/);
});

test('buildCodexExecCommand는 sandbox/approval 옵션을 인자로 포함한다.', () => {
  const command = buildCodexExecCommand(
    {
      systemPrompt: 'system',
      userPrompt: 'user',
      workspaceDir: '/tmp/default-workspace'
    },
    {
      codexBinary: 'codex-custom',
      workspaceRoot: '/tmp/workspace-root',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      extraArgs: ['--skip-git-repo-check']
    }
  );

  assert.equal(command.command, 'codex-custom');
  assert.deepEqual(command.args, [
    'exec',
    '--color',
    'never',
    '-C',
    path.resolve('/tmp/workspace-root'),
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="on-request"',
    '--skip-git-repo-check'
  ]);
});

test('buildGeminiExecCommand는 -p 프롬프트 모드로 통합 입력을 구성한다.', () => {
  const command = buildGeminiExecCommand(
    {
      systemPrompt: 'sys',
      userPrompt: 'user',
      workspaceDir: '/tmp/workspace-root'
    },
    {
      geminiBinary: 'gemini-cli-custom',
      workspaceRoot: '/tmp/g-root',
      extraArgs: ['--max-tokens', '1024']
    }
  );

  assert.equal(command.command, 'gemini-cli-custom');
  assert.deepEqual(command.args, [
    '-p',
    '[SYSTEM]\nsys\n\n[USER]\nuser',
    '--max-tokens',
    '1024'
  ]);
  assert.equal(command.cwd, path.resolve('/tmp/g-root'));
});

test('buildClaudeExecCommand는 -p 프롬프트 모드로 통합 입력을 구성한다.', () => {
  const command = buildClaudeExecCommand(
    {
      systemPrompt: 's',
      userPrompt: 'u',
      workspaceDir: '/tmp/workspace-root'
    },
    {
      claudeBinary: 'claude-cli-custom'
    }
  );

  assert.equal(command.command, 'claude-cli-custom');
  assert.deepEqual(command.args, ['-p', '[SYSTEM]\ns\n\n[USER]\nu']);
  assert.equal(command.cwd, path.resolve('/tmp/workspace-root'));
});

test('parseProviderIdFromRoutingYaml은 provider 키를 읽는다.', () => {
  const providerId = parseProviderIdFromRoutingYaml(
    ['default_workflow: refactor', 'provider: "codex-cli"', 'roles:', '  planner: planner'].join(
      '\n'
    )
  );

  assert.equal(providerId, 'codex-cli');
});

test('registry/factory는 routing 설정으로 provider를 선택한다.', () => {
  const registry = createProviderRegistry();
  const provider = createProviderFromSelection(registry, {
    routingYaml: ['provider: codex-cli', 'default_workflow: refactor'].join('\n')
  });

  assert.equal(provider.id, 'codex-cli');
  assert.deepEqual(registry.list(), ['claude', 'claude-cli', 'codex-cli', 'gemini', 'gemini-cli']);
});

test('resolveProviderId는 fallback을 처리한다.', () => {
  const providerId = resolveProviderId({
    routingYaml: 'default_workflow: refactor',
    fallbackProviderId: 'codex-cli'
  });

  assert.equal(providerId, 'codex-cli');
});

test('resolveProviderId는 role 매핑이 있으면 그 provider를 선택한다.', () => {
  const providerId = resolveProviderId({
    routingYaml: [
      'provider: codex-cli',
      'roles:',
      '  planner: gemini-cli',
      '  developer: claude-cli'
    ].join('\n'),
    role: 'developer'
  });

  assert.equal(providerId, 'claude-cli');
});

test('resolveProviderId는 role 매핑이 없으면 global provider로 폴백한다.', () => {
  const providerId = resolveProviderId({
    routingYaml: ['provider: gemini-cli', 'roles:', '  planner: claude-cli'].join('\n'),
    role: 'analyzer',
    fallbackProviderId: 'codex-cli'
  });

  assert.equal(providerId, 'gemini-cli');
});

test('parseRoutingYaml는 roles 및 default_workflow를 파싱한다.', () => {
  const config = parseRoutingYaml(
    [
      'provider: codex-cli',
      'default_workflow: refactor',
      'roles:',
      '  manager: gemini',
      '  planner: codex-cli',
      '  developer: claude'
    ].join('\n')
  );

  assert.equal(config.provider, 'codex-cli');
  assert.equal(config.defaultWorkflow, 'refactor');
  assert.equal(config.roles.manager, 'gemini');
  assert.equal(config.roles.developer, 'claude');
});

test('parseDefaultWorkflowFromRoutingYaml는 default_workflow를 추출한다.', () => {
  const defaultWorkflow = parseDefaultWorkflowFromRoutingYaml('default_workflow: release');
  assert.equal(defaultWorkflow, 'release');
});

test('resolveProviderForRole는 role 매핑을 사용해 provider를 선택한다.', () => {
  const config = parseRoutingYaml(
    ['roles:', '  planner: claude', '  developer: gemini'].join('\n')
  );

  assert.equal(resolveProviderForRole(config, 'planner'), 'claude');
  assert.equal(resolveProviderForRole(config, 'unknown', 'codex-cli'), 'codex-cli');
});

test('resolveProviderForRoleFromRoutingYaml는 role별 provider를 선택한다.', () => {
  const providerId = resolveProviderForRoleFromRoutingYaml(
    ['roles:', '  planner: claude', '  developer: gemini'].join('\n'),
    'developer',
    'codex-cli'
  );

  assert.equal(providerId, 'gemini');
});
