import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from 'react-query';

import * as services from 'renderer/services';

import {
  QSDM_WALLET_HISTORY_REFRESH_MS,
  QsdmWalletHistory,
} from './QsdmWalletHistory';

import type {
  QsdmWalletHistoryItem,
  QsdmWalletHistoryRequest,
  QsdmWalletHistoryResponse,
} from 'models/api/qsdm';

const mockCopyToClipboard = jest.fn();

jest.mock('renderer/components/ui', () => ({
  Button: ({
    label,
    onClick,
    disabled,
  }: {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  ),
  CopyButton: ({ onCopy }: { onCopy: (event?: React.MouseEvent) => void }) => (
    <button type="button" onClick={(event) => onCopy(event)}>
      Copy
    </button>
  ),
  ErrorMessage: ({ error }: { error?: unknown }) =>
    error ? <div role="alert">{String(error)}</div> : null,
  LoadingSpinner: () => <span data-testid="loading" />,
}));

jest.mock('renderer/features/common/hooks', () => ({
  useClipboard: () => ({
    copyToClipboard: mockCopyToClipboard,
    copied: false,
  }),
}));

jest.mock('renderer/services', () => ({
  QueryKeys: jest.requireActual('renderer/services/reactQueryService')
    .QueryKeys,
  getQsdmWalletHistory: jest.fn(),
  openBrowserWindow: jest.fn(),
}));

const mockedHistory = services.getQsdmWalletHistory as jest.Mock;
const mockedOpen = services.openBrowserWindow as jest.Mock;

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const PEER = `${'1'.repeat(8)}${'0'.repeat(52)}cafe`;

const send = (
  txId: string,
  time: string,
  extra: Partial<QsdmWalletHistoryItem> = {}
): QsdmWalletHistoryItem => ({
  txId,
  time,
  type: 'sent',
  counterparty: PEER,
  amount: 1,
  outgoing: true,
  status: 'pending',
  source: 'local',
  ...extra,
});

// What the main process answers, by wallet and list: the network history 404s unless pages are given.
type Answers = Record<
  string,
  {
    localSends?: QsdmWalletHistoryItem[];
    pages?: Record<
      string,
      Pick<QsdmWalletHistoryResponse, 'items' | 'nextBefore'>
    >;
  }
>;

const serve = (answers: Answers) => {
  mockedHistory.mockImplementation(
    async ({
      address,
      kind = 'transfers',
      before,
    }: QsdmWalletHistoryRequest) => {
      const wallet = answers[`${address}:${kind}`] || {};
      const page = wallet.pages?.[before || 'first'];
      return {
        address,
        kind,
        available: !!page,
        items: page?.items || [],
        nextBefore: page?.nextBefore || null,
        ...(kind === 'transfers' && !before
          ? { localSends: wallet.localSends || [] }
          : {}),
      };
    }
  );
};

const renderHistory = (address: string) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <QsdmWalletHistory address={address} />
    </QueryClientProvider>
  );
  const rerender = (next: string) =>
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <QsdmWalletHistory address={next} />
      </QueryClientProvider>
    );
  return { queryClient, view, rerender };
};

const rowOf = (text: string) =>
  screen.getByText(text).closest('[role="button"]') as HTMLElement;

describe('Recent transactions', () => {
  let rendered: ReturnType<typeof renderHistory> | undefined;

  beforeEach(() => {
    mockedHistory.mockReset();
    mockedOpen.mockReset();
    mockCopyToClipboard.mockReset();
  });

  afterEach(() => {
    rendered?.view.unmount();
    rendered?.queryClient.clear();
    rendered = undefined;
    jest.restoreAllMocks();
  });

  it("wallet B never shows wallet A's sends", async () => {
    serve({
      [`${A}:transfers`]: {
        localSends: [send('tx-from-a', '2026-11-22T10:00:00Z', { amount: 5 })],
      },
      [`${B}:transfers`]: {
        localSends: [send('tx-from-b', '2026-11-22T11:00:00Z', { amount: 7 })],
      },
    });

    rendered = renderHistory(A);
    expect(await screen.findByText('−5 CELL')).toBeInTheDocument();

    rendered.rerender(B);
    expect(await screen.findByText('−7 CELL')).toBeInTheDocument();
    expect(screen.queryByText('−5 CELL')).not.toBeInTheDocument();
    expect(
      mockedHistory.mock.calls.map(([request]) => request.address)
    ).toEqual([A, B]);
  });

  it('shows a send as Pending and moves it to Confirmed or Failed', async () => {
    let status: QsdmWalletHistoryItem['status'] = 'pending';
    mockedHistory.mockImplementation(async ({ address, kind }) => ({
      address,
      kind,
      available: false,
      items: [],
      nextBefore: null,
      localSends: [send('tx-1', '2026-11-22T10:00:00Z', { status })],
    }));

    rendered = renderHistory(A);
    expect(await screen.findByText('Pending')).toBeInTheDocument();

    status = 'confirmed';
    await act(async () => {
      await rendered?.queryClient.invalidateQueries();
    });
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();

    status = 'failed';
    await act(async () => {
      await rendered?.queryClient.invalidateQueries();
    });
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
  });

  it("falls back to Hive's own sends when the history endpoint is not live", async () => {
    serve({
      [`${A}:transfers`]: {
        localSends: [send('tx-1', '2026-11-22T10:00:00Z', { amount: 2.5 })],
      },
    });

    rendered = renderHistory(A);
    expect(await screen.findByText('−2.5 CELL')).toBeInTheDocument();
    expect(
      screen.getByText(/Full history is coming soon\./)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'explorer' }));
    expect(mockedOpen).toHaveBeenCalledWith(
      `https://qsdm.tech/explorer.html?address=${A}`
    );
  });

  it('merges by tx_id: a send the network lists shows once; a pending one stays', async () => {
    serve({
      [`${A}:transfers`]: {
        localSends: [
          send('tx-new', '2026-11-22T12:00:00Z', { amount: 3 }),
          send('tx-old', '2026-11-22T10:00:00Z', { amount: 9 }),
        ],
        pages: {
          first: {
            items: [
              send('tx-old', '2026-11-22T10:00:07Z', {
                amount: 9,
                status: 'confirmed',
                source: 'chain',
              }),
              send('tx-in', '2026-11-22T09:00:00Z', {
                amount: 1234.5,
                type: 'received',
                outgoing: false,
                status: 'confirmed',
                source: 'chain',
              }),
            ],
            nextBefore: null,
          },
        },
      },
    });

    rendered = renderHistory(A);
    expect(await screen.findByText('−3 CELL')).toBeInTheDocument();
    expect(screen.getAllByText('−9 CELL')).toHaveLength(1);
    expect(within(rowOf('−9 CELL')).getByText('Confirmed')).toBeInTheDocument();
    expect(within(rowOf('−3 CELL')).getByText('Pending')).toBeInTheDocument();
    expect(
      within(rowOf('+1,234.5 CELL')).getByText('Received')
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Full history is coming soon/)
    ).not.toBeInTheDocument();
    // Newest first.
    expect(
      screen
        .getAllByRole('button', { name: /CELL/ })
        .map((row) => within(row).getByText(/CELL$/).textContent)
    ).toEqual(['−3 CELL', '−9 CELL', '+1,234.5 CELL']);
  });

  it('Load more pages through the network history with before', async () => {
    serve({
      [`${A}:transfers`]: {
        pages: {
          first: {
            items: [
              send('tx-1', '2026-11-22T10:00:00Z', {
                amount: 1,
                status: 'confirmed',
                source: 'chain',
              }),
            ],
            nextBefore: 'cursor-1',
          },
          'cursor-1': {
            items: [
              send('tx-2', '2026-11-21T10:00:00Z', {
                amount: 2,
                status: 'confirmed',
                source: 'chain',
              }),
            ],
            nextBefore: null,
          },
        },
      },
    });

    rendered = renderHistory(A);
    expect(await screen.findByText('−1 CELL')).toBeInTheDocument();
    expect(screen.queryByText('−2 CELL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('−2 CELL')).toBeInTheDocument();
    expect(mockedHistory).toHaveBeenLastCalledWith({
      address: A,
      kind: 'transfers',
      before: 'cursor-1',
      limit: 50,
    });
    expect(
      screen.queryByRole('button', { name: 'Load more' })
    ).not.toBeInTheDocument();
  });

  it('Mining rewards asks for kind=rewards and keeps rewards out of the transfers', async () => {
    serve({
      [`${A}:transfers`]: {
        localSends: [send('tx-1', '2026-11-22T10:00:00Z', { amount: 2 })],
      },
      [`${A}:rewards`]: {
        pages: {
          first: {
            items: [
              send('reward-1', '2026-11-22T09:00:00Z', {
                amount: 4.56,
                type: 'reward',
                outgoing: false,
                counterparty: undefined,
                status: 'confirmed',
                source: 'chain',
                index: 2,
              }),
            ],
            nextBefore: null,
          },
        },
      },
    });

    rendered = renderHistory(A);
    expect(await screen.findByText('−2 CELL')).toBeInTheDocument();
    expect(screen.queryByText('+4.56 CELL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Mining rewards' }));
    expect(await screen.findByText('+4.56 CELL')).toBeInTheDocument();
    expect(screen.queryByText('−2 CELL')).not.toBeInTheDocument();
    expect(mockedHistory).toHaveBeenLastCalledWith({
      address: A,
      kind: 'rewards',
      before: undefined,
      limit: 50,
    });
  });

  it('a row opens the transaction in the explorer; Copy only copies', async () => {
    serve({
      [`${A}:transfers`]: {
        localSends: [send('tx-1', '2026-11-22T10:00:00Z', { amount: 2 })],
      },
    });

    rendered = renderHistory(A);
    await screen.findByText('−2 CELL');
    const row = rowOf('−2 CELL');
    expect(within(row).getByText('11111111…cafe')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Copy' }));
    expect(mockCopyToClipboard).toHaveBeenCalledWith(PEER);
    expect(mockedOpen).not.toHaveBeenCalled();

    fireEvent.click(row);
    expect(mockedOpen).toHaveBeenCalledWith(
      'https://qsdm.tech/explorer.html?tx=tx-1'
    );
  });

  it('refreshes the newest page every 60 s while shown', async () => {
    const setIntervalSpy = jest.spyOn(window, 'setInterval');
    serve({
      [`${A}:transfers`]: {
        localSends: [send('tx-1', '2026-11-22T10:00:00Z')],
      },
    });

    rendered = renderHistory(A);
    expect(await screen.findByText('Pending')).toBeInTheDocument();
    expect(mockedHistory).toHaveBeenCalledTimes(1);

    const refresh = setIntervalSpy.mock.calls.find(
      ([, ms]) => ms === QSDM_WALLET_HISTORY_REFRESH_MS
    )?.[0] as () => void;
    expect(refresh).toBeDefined();
    await act(async () => {
      refresh();
    });
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(2));
    expect(mockedHistory).toHaveBeenLastCalledWith({
      address: A,
      kind: 'transfers',
      before: undefined,
      limit: 50,
    });
  });
});
