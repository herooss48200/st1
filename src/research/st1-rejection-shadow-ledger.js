import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const seen = new Set();

const finiteOrNull = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export function buildSt1RejectionKey(record = {}) {
  const raw = [
    record.coin,
    record.signal,
    record.reason,
    record.setupSignature,
    record.setupCloseTime,
    record.crossingCloseTime
  ].map((value) => String(value ?? '')).join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

export function appendSt1RejectionShadow(record = {}, {
  enabled = true,
  storageFile = 'data/st1-rejection-shadow.jsonl',
  now = Date.now()
} = {}) {
  if (!enabled) return { recorded: false, reason: 'DISABLED' };
  const key = buildSt1RejectionKey(record);
  if (seen.has(key)) return { recorded: false, reason: 'DUPLICATE', key };

  const payload = {
    schemaVersion: 1,
    key,
    rejectedAt: now,
    coin: String(record.coin || '').toUpperCase() || null,
    signal: String(record.signal || '').toUpperCase() || null,
    reason: String(record.reason || '') || null,
    setupSignature: record.setupSignature || null,
    setupCloseTime: finiteOrNull(record.setupCloseTime),
    crossingCloseTime: finiteOrNull(record.crossingCloseTime),
    sourceInterval: record.sourceInterval || null,
    rsi: finiteOrNull(record.rsi),
    takerBuyRatio: finiteOrNull(record.takerBuyRatio),
    targetPrice: finiteOrNull(record.targetPrice),
    observedPrice: finiteOrNull(record.observedPrice),
    boxSize: finiteOrNull(record.boxSize),
    brickHigh: finiteOrNull(record.brickHigh),
    brickLow: finiteOrNull(record.brickLow),
    appVersion: record.appVersion || null,
    laneCandidate: record.laneCandidate || null,
    replayStatus: 'PENDING_HISTORICAL_OUTCOME'
  };

  const resolved = path.resolve(process.cwd(), storageFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(resolved, `${JSON.stringify(payload)}\n`, 'utf8');
  seen.add(key);
  return { recorded: true, key, payload };
}

export function resetSt1RejectionShadowDedupeForTests() {
  seen.clear();
}

export default { appendSt1RejectionShadow, buildSt1RejectionKey };
