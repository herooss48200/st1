import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEconomicOutcome, selectFilledProtectiveOrder } from '../src/utils/close-truth.js';

test('net loss remains LOSS even when a TP trigger exists elsewhere', () => {
  assert.equal(classifyEconomicOutcome(-0.03), 'LOSS');
  assert.equal(classifyEconomicOutcome(0.03), 'PROFIT');
  assert.equal(classifyEconomicOutcome(0), 'NEUTRAL');
});

test('an unfilled TP order can never be selected as the close cause', () => {
  const tp = { id: 'tp-1', type: 'TAKE_PROFIT_MARKET', status: 'CANCELED' };
  const sl = { id: 'sl-1', type: 'STOP_MARKET', status: 'NEW' };
  assert.equal(selectFilledProtectiveOrder([tp, sl]), null);
});

test('only the actually FILLED protective order is selected', () => {
  const tp = { id: 'tp-1', type: 'TAKE_PROFIT_MARKET', status: 'CANCELED' };
  const sl = { id: 'sl-1', type: 'STOP_MARKET', status: 'FILLED' };
  assert.equal(selectFilledProtectiveOrder([tp, sl])?.id, 'sl-1');
});
