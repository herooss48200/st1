import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendSt1RejectionShadow,
  resetSt1RejectionShadowDedupeForTests
} from '../../src/research/st1-rejection-shadow-ledger.js';

describe('ST1 rejection shadow ledger', () => {
  beforeEach(() => resetSt1RejectionShadowDedupeForTests());

  test('persists a replayable rejection once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st1-rejection-'));
    const file = path.join(dir, 'ledger.jsonl');
    const record = {
      coin: 'TESTUSDT', signal: 'BUY', reason: 'ST1_ORDERFLOW_CLOSED_PRICE_CHASE_LIMIT',
      setupSignature: 'sig-1', setupCloseTime: 123, rsi: 26.4, takerBuyRatio: 0.64,
      targetPrice: 10, observedPrice: 10.1, laneCandidate: 'R438_SHADOW'
    };
    const first = appendSt1RejectionShadow(record, { storageFile: file, now: 456 });
    const duplicate = appendSt1RejectionShadow(record, { storageFile: file, now: 789 });
    expect(first.recorded).toBe(true);
    expect(duplicate).toMatchObject({ recorded: false, reason: 'DUPLICATE' });
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      coin: 'TESTUSDT', rejectedAt: 456, rsi: 26.4,
      replayStatus: 'PENDING_HISTORICAL_OUTCOME'
    });
  });
});
