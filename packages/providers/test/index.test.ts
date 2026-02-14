import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  buildCodexExecCommand,
  createProviderFromSelection,
  createProviderRegistry,
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
  assert.deepEqual(registry.list(), ['codex-cli']);
});

test('resolveProviderId는 fallback을 처리한다.', () => {
  const providerId = resolveProviderId({
    routingYaml: 'default_workflow: refactor',
    fallbackProviderId: 'codex-cli'
  });

  assert.equal(providerId, 'codex-cli');
});
