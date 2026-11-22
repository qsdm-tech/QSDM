/**
 * @jest-environment node
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { qsdmGetJson } from './qsdmHttpRead';
import {
  getQsdmWalletHistoryPage,
  readQsdmWalletSends,
  recordQsdmWalletSend,
} from './qsdmWalletHistory';

let mockSignerDir = '';

jest.mock('config/qsdm', () => ({
  buildQsdmCoreApiUrl: (route: string) =>
    `https://api.qsdm.tech/api/v1/${route.replace(/^\/+/, '')}`,
}));

jest.mock('./qsdmTaskActionSigner', () => ({
  getQsdmDefaultLocalSignerPaths: () => ({
    signerDir: mockSignerDir,
    keystorePath: `${mockSignerDir}/wallet.json`,
    passphraseFile: `${mockSignerDir}/passphrase.txt`,
  }),
}));

jest.mock('./qsdmHttpRead', () => ({
  qsdmGetJson: jest.fn(),
}));

const mockedGetJson = qsdmGetJson as jest.Mock;
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const notFound = () =>
  Object.assign(new Error('HTTP 404'), {
    isAxiosError: true,
    response: { status: 404 },
  });

// A fake public API: /wallet/history is not live (404) unless a test gives pages; receipts by transaction id.
let historyPages: Record<string, unknown> | undefined;
let receipts: Record<string, unknown>;

const requestedUrls = () =>
  mockedGetJson.mock.calls.map(([url]) => new URL(url as string));

describe('Recent transactions (main process)', () => {
  beforeEach(() => {
    mockSignerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsdm-history-'));
    historyPages = undefined;
    receipts = {};
    mockedGetJson.mockReset();
    mockedGetJson.mockImplementation(async (raw: string) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/wallet/history')) {
        const page = historyPages?.[url.searchParams.get('before') || 'first'];
        if (!page) throw notFound();
        return page;
      }
      const receiptId = decodeURIComponent(url.pathname.split('/').pop() || '');
      if (!(receiptId in receipts)) throw notFound();
      return receipts[receiptId];
    });
  });

  afterEach(() => {
    fs.rmSync(mockSignerDir, { recursive: true, force: true });
  });

  it("keeps a separate log per wallet: B never shows A's sends", async () => {
    recordQsdmWalletSend(A, {
      txId: 'tx-a-1',
      to: C,
      amount: 5,
      fee: 0,
      time: '2026-11-22T10:00:00.000Z',
    });

    const forB = await getQsdmWalletHistoryPage({ address: B });
    expect(forB.localSends).toEqual([]);

    const forA = await getQsdmWalletHistoryPage({ address: A });
    expect(forA.localSends?.map((item) => item.txId)).toEqual(['tx-a-1']);
    expect(forA.localSends?.[0]).toMatchObject({
      type: 'sent',
      counterparty: C,
      amount: 5,
      outgoing: true,
      status: 'pending',
      source: 'local',
    });

    // The log is next to the wallet store and holds no secrets.
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(mockSignerDir, 'wallet-sends', `${A}.json`),
        'utf-8'
      )
    ) as { sends: Array<Record<string, unknown>> };
    expect(Object.keys(stored).sort()).toEqual(['address', 'sends', 'version']);
    expect(Object.keys(stored.sends[0]).sort()).toEqual([
      'amount',
      'fee',
      'status',
      'time',
      'to',
      'txId',
    ]);
    expect(
      fs.existsSync(path.join(mockSignerDir, 'wallet-sends', `${B}.json`))
    ).toBe(false);
  });

  it('shows a send as Pending, then Confirmed (status 1) or Failed', async () => {
    recordQsdmWalletSend(A, {
      txId: 'tx-ok',
      to: C,
      amount: 1,
      fee: 0,
      time: '2026-11-22T10:00:00.000Z',
    });
    recordQsdmWalletSend(A, {
      txId: 'tx-bad',
      to: C,
      amount: 2,
      fee: 0,
      time: '2026-11-22T10:01:00.000Z',
    });

    const first = await getQsdmWalletHistoryPage({ address: A });
    expect(first.localSends?.map((s) => [s.txId, s.status])).toEqual([
      ['tx-bad', 'pending'],
      ['tx-ok', 'pending'],
    ]);

    receipts['tx-ok'] = { tx_id: 'tx-ok', status: 1 };
    receipts['tx-bad'] = { receipt: { tx_id: 'tx-bad', status: 0 } };
    const second = await getQsdmWalletHistoryPage({ address: A });
    expect(second.localSends?.map((s) => [s.txId, s.status])).toEqual([
      ['tx-bad', 'failed'],
      ['tx-ok', 'confirmed'],
    ]);

    // Final statuses are kept and not asked again.
    mockedGetJson.mockClear();
    const third = await getQsdmWalletHistoryPage({ address: A });
    expect(third.localSends?.map((s) => s.status)).toEqual([
      'failed',
      'confirmed',
    ]);
    expect(
      requestedUrls().filter((url) => url.pathname.includes('/receipts/'))
    ).toEqual([]);
    expect(readQsdmWalletSends(A).map((s) => s.status)).toEqual([
      'failed',
      'confirmed',
    ]);
  });

  it("falls back to Hive's own sends when /wallet/history answers 404", async () => {
    recordQsdmWalletSend(A, {
      txId: 'tx-a-1',
      to: C,
      amount: 3,
      fee: 0,
      time: '2026-11-22T10:00:00.000Z',
    });

    const page = await getQsdmWalletHistoryPage({ address: A });
    expect(page.available).toBe(false);
    expect(page.items).toEqual([]);
    expect(page.nextBefore).toBeNull();
    expect(page.localSends?.map((s) => s.txId)).toEqual(['tx-a-1']);
    const historyUrl = requestedUrls().find((url) =>
      url.pathname.endsWith('/wallet/history')
    );
    expect(historyUrl?.searchParams.get('address')).toBe(A);
    expect(historyUrl?.searchParams.get('kind')).toBe('transfers');
    expect(historyUrl?.searchParams.get('limit')).toBe('50');
  });

  it('takes the status from the network history for a send it already lists', async () => {
    recordQsdmWalletSend(A, {
      txId: 'tx-a-1',
      to: C,
      amount: 3,
      fee: 0,
      time: '2026-11-22T10:00:00.000Z',
    });
    historyPages = {
      first: {
        address: A,
        indexed_tip: 10,
        chain_tip: 10,
        items: [
          {
            tx_id: 'tx-a-1',
            height: 9,
            time: '2026-11-22T10:00:05Z',
            kind: 'send',
            contract: 'qsdm/wallet-transfer/v1',
            from: A,
            to: C,
            amount: 3,
            fee: 0,
            status: 1,
            index: 0,
          },
        ],
        next_before: null,
      },
    };

    const page = await getQsdmWalletHistoryPage({ address: A });
    expect(page.available).toBe(true);
    expect(page.items[0]).toMatchObject({
      txId: 'tx-a-1',
      type: 'sent',
      counterparty: C,
      outgoing: true,
      status: 'confirmed',
      height: 9,
      source: 'chain',
    });
    expect(page.localSends?.[0].status).toBe('confirmed');
    expect(
      requestedUrls().filter((url) => url.pathname.includes('/receipts/'))
    ).toEqual([]);
  });

  it('pages with before and returns the next cursor', async () => {
    historyPages = {
      first: {
        items: [
          {
            tx_id: 'tx-new',
            time: '2026-11-22T10:00:00Z',
            kind: 'receive',
            from: B,
            to: A,
            amount: 1.5,
            fee: 0,
            status: 1,
            index: 0,
          },
        ],
        next_before: 'cursor-1',
      },
      'cursor-1': {
        items: [
          {
            tx_id: 'tx-old',
            time: '2026-11-21T10:00:00Z',
            kind: 'send',
            from: A,
            to: B,
            amount: 0.25,
            fee: 0.001,
            status: 0,
            index: 0,
          },
        ],
        next_before: null,
      },
    };

    const first = await getQsdmWalletHistoryPage({ address: A });
    expect(first.nextBefore).toBe('cursor-1');
    expect(first.items[0]).toMatchObject({
      txId: 'tx-new',
      type: 'received',
      counterparty: B,
      outgoing: false,
      amount: 1.5,
    });

    const older = await getQsdmWalletHistoryPage({
      address: A,
      before: 'cursor-1',
    });
    expect(older.nextBefore).toBeNull();
    expect(older.localSends).toBeUndefined();
    expect(older.items[0]).toMatchObject({
      txId: 'tx-old',
      type: 'sent',
      status: 'failed',
      fee: 0.001,
    });
    expect(requestedUrls().pop()?.searchParams.get('before')).toBe('cursor-1');
  });

  it('asks for kind=rewards on the Mining rewards list and never mixes in sends', async () => {
    recordQsdmWalletSend(A, {
      txId: 'tx-a-1',
      to: C,
      amount: 3,
      fee: 0,
      time: '2026-11-22T10:00:00.000Z',
    });
    historyPages = {
      first: {
        items: [
          {
            tx_id: 'reward-1',
            time: '2026-11-22T09:00:00Z',
            kind: 'reward',
            from: '',
            to: A,
            amount: 4.56,
            fee: 0,
            status: 1,
            index: 3,
          },
        ],
        next_before: null,
      },
    };

    const rewards = await getQsdmWalletHistoryPage({
      address: A,
      kind: 'rewards',
    });
    expect(requestedUrls()[0].searchParams.get('kind')).toBe('rewards');
    expect(rewards.kind).toBe('rewards');
    expect(rewards.localSends).toBeUndefined();
    expect(rewards.items).toEqual([
      expect.objectContaining({
        txId: 'reward-1',
        index: 3,
        type: 'reward',
        outgoing: false,
        amount: 4.56,
      }),
    ]);
  });

  it('does not ask the network for an invalid address', async () => {
    const page = await getQsdmWalletHistoryPage({ address: 'not-an-address' });
    expect(page).toMatchObject({ available: false, items: [] });
    expect(mockedGetJson).not.toHaveBeenCalled();
  });
});
