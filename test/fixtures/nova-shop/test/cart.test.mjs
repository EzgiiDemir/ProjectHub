import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal } from '../src/cart.mjs';

test('sepet toplamı', () => {
  assert.equal(cartTotal([{ price: 209, qty: 2 }]), 418);
  assert.equal(cartTotal([{ price: 0.1, qty: 3 }]), 0.3);
});
