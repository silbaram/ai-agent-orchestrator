import assert from 'node:assert/strict';
import test from 'node:test';

import { multiply } from '../src/math.js';

test('multiply는 두 수의 곱을 계산한다.', () => {
  assert.equal(multiply(2, 3), 6);
});
