import { NATIVE_TOKEN_SYMBOL } from 'config/nativeToken';

import type { QsdmWalletHistoryItem } from 'models/api/qsdm';

export const QSDM_EXPLORER_URL = 'https://qsdm.tech/explorer.html';

export const qsdmExplorerTxUrl = (txId: string) =>
  `${QSDM_EXPLORER_URL}?tx=${encodeURIComponent(txId)}`;

export const qsdmExplorerAddressUrl = (address: string) =>
  `${QSDM_EXPLORER_URL}?address=${encodeURIComponent(address)}`;

const timeOf = (item: QsdmWalletHistoryItem) => {
  const parsed = Date.parse(item.time);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const newestFirst = (a: QsdmWalletHistoryItem, b: QsdmWalletHistoryItem) =>
  timeOf(b) - timeOf(a);

/**
 * One list, newest first: every loaded page of the network history (each entry once) and Hive's own sends that the
 * loaded pages do not list yet (Pending, or confirmed but not indexed yet). A send older than the oldest loaded page
 * waits for Load more, so it shows where it belongs. Without the network history: Hive's own sends only.
 */
export const mergeQsdmWalletHistory = ({
  chainItems,
  localItems,
  chainAvailable,
  hasMoreChain,
}: {
  chainItems: QsdmWalletHistoryItem[];
  localItems: QsdmWalletHistoryItem[];
  chainAvailable: boolean;
  hasMoreChain: boolean;
}) => {
  if (!chainAvailable) return [...localItems].sort(newestFirst);
  const seen = new Set<string>();
  const chain = chainItems.filter((item) => {
    const key = `${item.txId}:${item.index ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const onChain = new Set(chain.map((item) => item.txId));
  const oldestLoaded = chain.length
    ? Math.min(...chain.map(timeOf))
    : undefined;
  const local = localItems.filter(
    (item) =>
      !onChain.has(item.txId) &&
      (!hasMoreChain ||
        oldestLoaded === undefined ||
        timeOf(item) >= oldestLoaded)
  );
  return [...chain, ...local].sort(newestFirst);
};

/** abcd1234…wxyz */
export const shortQsdmHistoryAddress = (address?: string) => {
  if (!address) return '';
  return address.length > 14
    ? `${address.slice(0, 8)}…${address.slice(-4)}`
    : address;
};

/** +1,234.5 CELL or −0.25 CELL: up to 8 decimals, thousands separators. */
export const formatQsdmHistoryAmount = (item: QsdmWalletHistoryItem) =>
  `${item.outgoing ? '−' : '+'}${item.amount.toLocaleString('en-US', {
    maximumFractionDigits: 8,
  })} ${NATIVE_TOKEN_SYMBOL}`;

export const formatQsdmHistoryTime = (time: string) => {
  const parsed = new Date(time);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
};

export const QSDM_HISTORY_TYPE_LABELS: Record<
  QsdmWalletHistoryItem['type'],
  string
> = {
  sent: 'Sent',
  received: 'Received',
  reward: 'Reward',
  other: 'Other',
};

export const QSDM_HISTORY_STATUS_LABELS: Record<
  QsdmWalletHistoryItem['status'],
  string
> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  failed: 'Failed',
};
