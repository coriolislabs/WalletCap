// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256Hex } from '../dist/_keccak.js';

test('keccak256 matches the Ethereum vectors', async () => {
  assert.equal(
    keccak256Hex(''),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  );
  assert.equal(
    keccak256Hex('abc'),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );
  assert.equal(
    keccak256Hex('testing'),
    '5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02',
  );
});
