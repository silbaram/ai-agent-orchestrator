import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyArtifact,
  type Provider,
  ProviderError,
  type ProviderRunInput
} from '../src/index.ts';

test('createEmptyArtifact는 빈 content를 반환한다.', () => {
  assert.deepEqual(createEmptyArtifact(), { content: '' });
});

test('Provider 인터페이스 형태를 따르는 구현은 run 결과를 반환한다.', async () => {
  const provider: Provider = {
    id: 'mock-provider',
    capabilities: {
      systemPromptMode: 'inline',
      supportsPatchOutput: true
    },
    async run(input: ProviderRunInput) {
      return {
        text: `${input.systemPrompt}\n${input.userPrompt}`,
        meta: {
          durationMs: 1,
          stdout: 'ok',
          stderr: '',
          command: ['mock']
        }
      };
    }
  };

  const result = await provider.run({
    systemPrompt: 'system',
    userPrompt: 'user',
    workspaceDir: '/tmp/workspace',
    timeoutMs: 1000
  });

  assert.equal(result.text, 'system\nuser');
  assert.equal(provider.id, 'mock-provider');
  assert.equal(provider.capabilities.supportsPatchOutput, true);
  assert.deepEqual(result.meta.command, ['mock']);
});

test('ProviderError는 code와 meta를 유지한다.', () => {
  const error = new ProviderError('실행 실패', {
    code: 'EXECUTION_FAILED',
    meta: {
      durationMs: 10,
      stdout: '',
      stderr: 'boom',
      command: ['codex', 'exec'],
      exitCode: 1
    }
  });

  assert.equal(error.name, 'ProviderError');
  assert.equal(error.code, 'EXECUTION_FAILED');
  assert.equal(error.meta?.stderr, 'boom');
});
