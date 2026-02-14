import assert from 'node:assert/strict';

import { createMessage } from '../src/message.js';

assert.equal(createMessage('workspace'), 'draft:workspace');
