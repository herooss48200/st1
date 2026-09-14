import { TradeRepository } from '../../src/repositories/repositories.js';

describe('PAPER snapshot research reconciliation', () => {
  test('marks only inactive prior-session opens and never fabricates an exit', async () => {
    const repository = new TradeRepository();
    repository.trades = [
      { id: '1', tradeId: 'old-open', sessionId: 'old', entryTime: 100 },
      { id: '2', tradeId: 'active-old', sessionId: 'old', entryTime: 100 },
      { id: '3', tradeId: 'current-open', sessionId: 'current', entryTime: 1_100 },
      { id: '4', tradeId: 'old-closed', sessionId: 'old', entryTime: 100, exitTime: 200 }
    ];
    let saveCalls = 0;
    repository.saveTradesToDisk = () => { saveCalls += 1; };

    const updated = await repository.markOrphanedPaperSnapshots({
      currentSessionId: 'current',
      currentSessionStartedAt: 1_000,
      activeTradeIds: ['active-old'],
      orphanedAt: 2_000
    });

    expect(updated).toBe(1);
    expect(saveCalls).toBe(1);
    expect(repository.trades[0]).toMatchObject({
      researchStatus: 'ORPHANED_PRIOR_PAPER_SESSION',
      orphanedAt: 2_000,
      orphanedBySessionId: 'current'
    });
    expect(repository.trades[0].exitTime).toBeUndefined();
    expect(repository.trades[1].researchStatus).toBeUndefined();
    expect(repository.trades[2].researchStatus).toBeUndefined();
    expect(repository.trades[3].researchStatus).toBeUndefined();
  });
});
