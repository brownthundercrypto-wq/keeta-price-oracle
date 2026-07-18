// (2) DECIMALS / SCALING — price string <-> priceScaled/priceScaleDecimals round-trip + consistency.
// priceScaleDecimals is PRICE fixed-point precision (8) — never any token's on-chain decimals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDecimalString, toPriceScaled } from '../src/priceFeed.js';
import { PRICE_SCALE_DECIMALS } from '../src/config.js';

// Reconstruct the float a consumer would compute from the integer form.
const fromScaled = (scaled, decimals) => Number(scaled) / 10 ** decimals;

test('priceScaleDecimals is price precision (8), a plain number', () => {
  assert.equal(PRICE_SCALE_DECIMALS, 8);
  assert.equal(typeof PRICE_SCALE_DECIMALS, 'number');
});

test('toPriceScaled scales by 10^PRICE_SCALE_DECIMALS with rounding', () => {
  assert.equal(toPriceScaled(0.1173), '11730000');
  assert.equal(toPriceScaled(1), String(10 ** PRICE_SCALE_DECIMALS));
  // Rounds at the 8th place rather than truncating (0.111111119 * 1e8 = 11111111.9 -> 11111112).
  assert.equal(toPriceScaled(0.111111119), '11111112');
});

test('price string <-> priceScaled round-trip is consistent', () => {
  for (const n of [0.1173, 1.08123456, 0.99998888, 3456.789, 65000.12345678]) {
    const priceStr = toDecimalString(n);
    const scaled = toPriceScaled(n);
    // The decimal string is the exact value; scaled reconstructs it to 8dp precision.
    assert.equal(Number(priceStr), n);
    const back = fromScaled(scaled, PRICE_SCALE_DECIMALS);
    assert.ok(Math.abs(back - n) <= 0.5 / 10 ** PRICE_SCALE_DECIMALS, `round-trip ${n} -> ${scaled} -> ${back}`);
  }
});

test('toDecimalString never emits exponential notation', () => {
  const s = toDecimalString(0.00000123);
  assert.ok(!/e/i.test(s), `unexpected exponent in ${s}`);
  assert.equal(Number(s), 0.00000123);
});

test('scaled form stays a pure integer string (on-chain integer math friendly)', () => {
  for (const n of [0.1173, 65000.12345678, 1.08]) {
    assert.match(toPriceScaled(n), /^\d+$/);
  }
});
