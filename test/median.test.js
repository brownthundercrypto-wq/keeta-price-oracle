// (1) MEDIAN — odd count, even count (= mean of two middle), single value, unsorted input.
// Hermetic: pure function, no network / chain / db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../src/priceFeed.js';

test('median: odd count returns the middle element', () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([10, 20, 30, 40, 50]), 30);
});

test('median: even count returns the mean of the two middle values', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5); // (2 + 3) / 2
  assert.equal(median([2, 4, 8, 10]), 6); // (4 + 8) / 2
});

test('median: single value returns that value', () => {
  assert.equal(median([42]), 42);
  assert.equal(median([0.1173]), 0.1173);
});

test('median: unsorted input is sorted internally (odd and even)', () => {
  assert.equal(median([5, 1, 3]), 3); // -> [1,3,5]
  assert.equal(median([10, 2, 8, 4]), 6); // -> [2,4,8,10] -> (4+8)/2
});

test('median: does not mutate the caller array', () => {
  const input = [3, 1, 2];
  const snapshot = [...input];
  median(input);
  assert.deepEqual(input, snapshot);
});
