import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideCheckFailure,
  evaluateRiskFromDiffOutputs,
  type CommandExecutionResult
} from '../src/index.ts';

test('Gatekeeper는 파일 삭제/보안 경로/대규모 변경을 승인 필요로 판정한다.', () => {
  const decision = evaluateRiskFromDiffOutputs({
    nameStatusOutput: ['D\tlegacy.txt', 'M\tauth/service.ts', 'M\tsrc/module.ts'].join('\n'),
    numstatOutput: ['10\t2\tauth/service.ts', '400\t300\tsrc/module.ts'].join('\n'),
    largeChangeFileThreshold: 20,
    largeChangeLineThreshold: 500
  });

  assert.equal(decision.requiresApproval, true);
  assert.equal(decision.deletedFiles.includes('legacy.txt'), true);
  assert.equal(decision.securitySensitiveFiles.includes('auth/service.ts'), true);
  assert.equal(decision.totalChangedLines >= 500, true);
  assert.match(decision.reasons.join('\n'), /파일 삭제 감지/);
  assert.match(decision.reasons.join('\n'), /보안 민감 경로 변경 감지/);
  assert.match(decision.reasons.join('\n'), /대규모 변경 감지/);
});

test('Gatekeeper는 검증 실패 시 남은 재시도가 있으면 auto_fix를 선택한다.', () => {
  const result = decideCheckFailure({
    checkResults: [createCheckResult({ commandId: 'test', exitCode: 1 })],
    retryCount: 0,
    maxAutoFixRetries: 2
  });

  assert.equal(result.action, 'auto_fix');
  assert.deepEqual(result.failedCommandIds, ['test']);
});

test('Gatekeeper는 검증 실패 + 재시도 소진 시 fail을 선택한다.', () => {
  const result = decideCheckFailure({
    checkResults: [createCheckResult({ commandId: 'build', exitCode: 2 })],
    retryCount: 2,
    maxAutoFixRetries: 2
  });

  assert.equal(result.action, 'fail');
  assert.deepEqual(result.failedCommandIds, ['build']);
});

function createCheckResult(seed: {
  commandId: string;
  exitCode: number;
}): CommandExecutionResult {
  return {
    commandId: seed.commandId,
    command: [seed.commandId],
    stdout: '',
    stderr: 'failed',
    exitCode: seed.exitCode,
    durationMs: 1,
    timedOut: false
  };
}
