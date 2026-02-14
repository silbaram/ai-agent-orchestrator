import assert from 'node:assert/strict';
import test from 'node:test';

import { createMessage } from '../src/message.js';

test('createMessage는 prefix를 포함한 문자열을 반환한다.', () => {
  assert.equal(createMessage('workspace'), 'draft:workspace');
});
