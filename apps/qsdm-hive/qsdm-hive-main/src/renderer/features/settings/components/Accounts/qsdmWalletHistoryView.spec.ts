import {
  formatQsdmHistoryAmount,
  mergeQsdmWalletHistory,
  qsdmExplorerAddressUrl,
  qsdmExplorerTxUrl,
  shortQsdmHistoryAddress,
} from './qsdmWalletHistoryView';

import type { QsdmWalletHistoryItem } from 'models/api/qsdm';

const B = `${'b'.repeat(60)}cafe`;

const item = (
  txId: string,
  time: string,
  extra: Partial<QsdmWalletHistoryItem> = {}
): QsdmWalletHistoryItem => ({
  txId,
  time,
  type: 'sent',
  counterparty: B,
  amount: 1,
  outgoing: true,
  status: 'confirmed',
  source: 'chain',
  ...extra,
});

const local = (
  txId: string,
  time: string,
  status: QsdmWalletHistoryItem['status'] = 'pending'
) => item(txId, time, { source: 'local', status });

const ids = (items: QsdmWalletHistoryItem[]) =>
  items.map((entry) => `${entry.source}:${entry.txId}:${entry.status}`);

describe('Recent transactions view', () => {
  it('merges by tx_id: a send the network lists shows once, with its status', () => {
    const merged = mergeQsdmWalletHistory({
      chainItems: [item('tx-1', '2026-11-22T10:00:05Z')],
      localItems: [
        local('tx-2', '2026-11-22T10:05:00Z'),
        local('tx-1', '2026-11-22T10:00:00Z'),
      ],
      chainAvailable: true,
      hasMoreChain: false,
    });
    expect(ids(merged)).toEqual(['local:tx-2:pending', 'chain:tx-1:confirmed']);
  });

  it("keeps Hive's own pending sends until the network history has them", () => {
    const merged = mergeQsdmWalletHistory({
      chainItems: [],
      localItems: [local('tx-new', '2026-11-22T10:05:00Z')],
      chainAvailable: true,
      hasMoreChain: false,
    });
    expect(ids(merged)).toEqual(['local:tx-new:pending']);
  });

  it('places an older own send only once the page that covers it is loaded', () => {
    const page1 = [
      item('tx-a', '2026-11-22T10:00:00Z'),
      item('tx-b', '2026-11-21T10:00:00Z'),
    ];
    const oldLocal = [local('tx-old', '2026-11-20T10:00:00Z')];

    const firstPageOnly = mergeQsdmWalletHistory({
      chainItems: page1,
      localItems: oldLocal,
      chainAvailable: true,
      hasMoreChain: true,
    });
    expect(ids(firstPageOnly)).toEqual([
      'chain:tx-a:confirmed',
      'chain:tx-b:confirmed',
    ]);

    const page2 = [item('tx-c', '2026-11-19T10:00:00Z')];
    const bothPages = mergeQsdmWalletHistory({
      chainItems: [...page1, ...page2],
      localItems: oldLocal,
      chainAvailable: true,
      hasMoreChain: false,
    });
    expect(ids(bothPages)).toEqual([
      'chain:tx-a:confirmed',
      'chain:tx-b:confirmed',
      'local:tx-old:pending',
      'chain:tx-c:confirmed',
    ]);
  });

  it('shows each network entry once when pages overlap after new transactions', () => {
    const merged = mergeQsdmWalletHistory({
      chainItems: [
        item('tx-a', '2026-11-22T10:00:00Z', { index: 0 }),
        item('tx-a', '2026-11-22T10:00:00Z', { index: 0 }),
        item('tx-a', '2026-11-22T10:00:00Z', { index: 1, type: 'reward' }),
      ],
      localItems: [],
      chainAvailable: true,
      hasMoreChain: false,
    });
    expect(merged).toHaveLength(2);
  });

  it("without the network history shows Hive's own sends, newest first", () => {
    const merged = mergeQsdmWalletHistory({
      chainItems: [],
      localItems: [
        local('tx-old', '2026-11-20T10:00:00Z', 'confirmed'),
        local('tx-new', '2026-11-22T10:00:00Z'),
      ],
      chainAvailable: false,
      hasMoreChain: false,
    });
    expect(ids(merged)).toEqual([
      'local:tx-new:pending',
      'local:tx-old:confirmed',
    ]);
  });

  it('formats amounts, addresses and explorer links', () => {
    expect(
      formatQsdmHistoryAmount(item('t', '', { amount: 1234.123456789 }))
    ).toBe('−1,234.12345679 CELL');
    expect(
      formatQsdmHistoryAmount(
        item('t', '', { amount: 0.5, outgoing: false, type: 'received' })
      )
    ).toBe('+0.5 CELL');
    expect(shortQsdmHistoryAddress(B)).toBe('bbbbbbbb…cafe');
    expect(qsdmExplorerTxUrl('tx 1')).toBe(
      'https://qsdm.tech/explorer.html?tx=tx%201'
    );
    expect(qsdmExplorerAddressUrl(B)).toBe(
      `https://qsdm.tech/explorer.html?address=${B}`
    );
  });
});
