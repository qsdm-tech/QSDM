import React, { MouseEvent, useEffect, useState } from 'react';
import { useInfiniteQuery } from 'react-query';

import {
  Button,
  CopyButton,
  ErrorMessage,
  LoadingSpinner,
} from 'renderer/components/ui';
import { useClipboard } from 'renderer/features/common/hooks';
import {
  getQsdmWalletHistory,
  openBrowserWindow,
  QueryKeys,
} from 'renderer/services';

import {
  formatQsdmHistoryAmount,
  formatQsdmHistoryTime,
  mergeQsdmWalletHistory,
  qsdmExplorerAddressUrl,
  qsdmExplorerTxUrl,
  QSDM_HISTORY_STATUS_LABELS,
  QSDM_HISTORY_TYPE_LABELS,
  shortQsdmHistoryAddress,
} from './qsdmWalletHistoryView';

import type {
  QsdmWalletHistoryItem,
  QsdmWalletHistoryKind,
} from 'models/api/qsdm';

const PAGE_SIZE = 50;
// The public API allows about 100 requests a minute per IP: only the active wallet's newest page, once a minute.
export const QSDM_WALLET_HISTORY_REFRESH_MS = 60_000;

const KINDS: Array<[QsdmWalletHistoryKind, string]> = [
  ['transfers', 'Transfers'],
  ['rewards', 'Mining rewards'],
];

const STATUS_CLASSES: Record<QsdmWalletHistoryItem['status'], string> = {
  pending: 'text-qsdm-warn',
  confirmed: 'text-qsdm-success',
  failed: 'text-qsdm-danger',
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const itemKey = (item: QsdmWalletHistoryItem) =>
  `${item.source}:${item.txId}:${item.index ?? ''}`;

/** Recent transactions of the active wallet: Hive's own sends and, once the network serves it, the full history. */
export function QsdmWalletHistory({ address }: { address?: string }) {
  const [kind, setKind] = useState<QsdmWalletHistoryKind>('transfers');
  const [localShown, setLocalShown] = useState(PAGE_SIZE);
  const [copiedKey, setCopiedKey] = useState('');
  const { copyToClipboard, copied } = useClipboard();

  const history = useInfiniteQuery(
    [QueryKeys.QsdmWalletHistory, address, kind],
    ({ pageParam }) =>
      getQsdmWalletHistory({
        address: address as string,
        kind,
        before: pageParam as string | undefined,
        limit: PAGE_SIZE,
      }),
    {
      enabled: !!address,
      getNextPageParam: (lastPage) => lastPage.nextBefore || undefined,
      retry: false,
    }
  );
  const { refetch } = history;

  useEffect(() => {
    setLocalShown(PAGE_SIZE);
  }, [address, kind]);

  useEffect(() => {
    if (!address) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      refetch({ refetchPage: (_page, index) => index === 0 });
    }, QSDM_WALLET_HISTORY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [address, kind, refetch]);

  if (!address) return null;

  const pages = history.data?.pages || [];
  const available = !!pages[0]?.available;
  const merged = mergeQsdmWalletHistory({
    chainItems: pages.flatMap((page) => page.items),
    localItems: kind === 'transfers' ? pages[0]?.localSends || [] : [],
    chainAvailable: available,
    hasMoreChain: !!history.hasNextPage,
  });
  const items = available ? merged : merged.slice(0, localShown);
  const canLoadMore = available
    ? !!history.hasNextPage
    : merged.length > localShown;

  const loadMore = () => {
    if (available) history.fetchNextPage();
    else setLocalShown((shown) => shown + PAGE_SIZE);
  };

  const openTransaction = (item: QsdmWalletHistoryItem) =>
    openBrowserWindow(qsdmExplorerTxUrl(item.txId));

  return (
    <div className="mt-5 border-t border-qsdm-border pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-base font-semibold">Recent transactions</div>
        <div className="flex gap-2" role="tablist" aria-label="Transactions">
          {KINDS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={kind === value}
              onClick={() => setKind(value)}
              className={`h-8 px-3 rounded-lg text-xs font-semibold transition ${
                kind === value
                  ? 'border border-qsdm-teal/60 bg-qsdm-teal/15 text-qsdm-teal'
                  : 'border border-qsdm-border bg-black/20 text-qsdm-text-2 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="pt-2">
        {history.isLoading ? (
          <LoadingSpinner />
        ) : items.length ? (
          <div className="divide-y divide-qsdm-border">
            {items.map((item) => {
              const key = itemKey(item);
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  title="Open in the explorer"
                  onClick={() => openTransaction(item)}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      event.target === event.currentTarget
                    ) {
                      openTransaction(item);
                    }
                  }}
                  className="grid cursor-pointer grid-cols-[1.4fr_0.8fr_1.4fr_1.4fr_0.9fr] items-center gap-3 py-2 text-xs hover:bg-white/5"
                >
                  <span className="text-finnieGray-secondary">
                    {formatQsdmHistoryTime(item.time)}
                  </span>
                  <span className="font-semibold">
                    {QSDM_HISTORY_TYPE_LABELS[item.type]}
                  </span>
                  <span
                    className="flex items-center gap-1 font-mono"
                    title={item.counterparty}
                  >
                    {shortQsdmHistoryAddress(item.counterparty) || '-'}
                    {item.counterparty && (
                      <CopyButton
                        onCopy={(event?: MouseEvent) => {
                          // Copy only; the row's click opens the explorer.
                          event?.stopPropagation();
                          setCopiedKey(key);
                          copyToClipboard(item.counterparty as string);
                        }}
                        isCopied={copied && copiedKey === key}
                      />
                    )}
                  </span>
                  <span
                    className={`font-mono ${
                      item.outgoing ? '' : 'text-qsdm-success'
                    }`}
                  >
                    {formatQsdmHistoryAmount(item)}
                  </span>
                  <span className={STATUS_CLASSES[item.status]}>
                    {QSDM_HISTORY_STATUS_LABELS[item.status]}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-finnieGray-secondary">
            {kind === 'rewards'
              ? 'No mining rewards yet.'
              : 'No transactions yet.'}
          </div>
        )}
      </div>

      {canLoadMore && (
        <Button
          label="Load more"
          onClick={loadMore}
          disabled={history.isFetchingNextPage}
          loading={history.isFetchingNextPage}
          className="mt-3 h-9 w-32"
        />
      )}

      {!history.isLoading && !available && (
        <div className="pt-3 text-xs text-finnieGray-secondary">
          Full history is coming soon. Older and received transactions are in
          the{' '}
          <button
            type="button"
            className="underline hover:text-white"
            onClick={() => openBrowserWindow(qsdmExplorerAddressUrl(address))}
          >
            explorer
          </button>
          .
        </div>
      )}

      <ErrorMessage
        error={
          history.error
            ? `Recent transactions: ${getErrorMessage(history.error)}`
            : null
        }
        className="py-2"
      />
    </div>
  );
}
