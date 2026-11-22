/**
 * @jest-environment node
 */

import { Event } from 'electron';

import { notifyQsdmActiveWalletChanged } from 'main/services/qsdmActiveWallet';
import { qsdmGetJson } from 'main/services/qsdmHttpRead';

import getAccountBalance from './getAccountBalance';

// Each test uses its own wallets: the balance cache lives for the whole file.
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const E = 'e'.repeat(64);
const F = 'f'.repeat(64);
// The legacy main-account key the renderer passes for "the active wallet".
const LEGACY_MAIN_KEY = '7x8tP5ipyqPfrRSXoxgGz6EzfTe3S84J3WUvJwbTwgnY';

let mockActiveSender = '';

jest.mock('config/qsdm', () => ({
  buildQsdmCoreApiUrl: (path: string) =>
    `http://127.0.0.1:8080/api/v1/${path.replace(/^\/+/, '')}`,
  QSDM_CELL_DECIMALS: 9,
  QSDM_TASK_RUNTIME_MODE: 'qsdm-native',
  QSDM_WALLET_ADDRESS: '',
}));

jest.mock('main/services/qsdmTaskActionSigner', () => ({
  getQsdmTaskActionSender: () => mockActiveSender,
}));

jest.mock('main/services/qsdmCanonicalChain', () => ({
  getQsdmCanonicalChainSafety: jest.fn().mockResolvedValue({ safe: true }),
}));

jest.mock('main/services/qsdmHttpRead', () => ({
  qsdmGetJson: jest.fn(),
}));

jest.mock('main/services/sdk', () => ({
  k2Connection: { getBalance: jest.fn() },
}));

const mockedGetJson = qsdmGetJson as jest.Mock;
const balances: Record<string, number> = {
  [A]: 500,
  [B]: 7,
  [C]: 300,
  [E]: 40,
  [F]: 2,
};
const event = {} as Event;
const readAddresses = () =>
  mockedGetJson.mock.calls.map(([url]) =>
    new URL(url as string).searchParams.get('address')
  );

describe('getAccountBalance after a QSDM wallet switch', () => {
  let now: jest.SpyInstance;

  beforeEach(() => {
    mockedGetJson.mockReset();
    mockedGetJson.mockImplementation(async (url: string) => {
      const address = new URL(url).searchParams.get('address') || '';
      if (!(address in balances)) throw new Error('HTTP 429');
      return { address, balance: balances[address] };
    });
    now = jest.spyOn(Date, 'now');
  });

  afterEach(() => {
    now.mockRestore();
  });

  it("returns the new wallet's balance for the main-account key right after a switch", async () => {
    mockActiveSender = A;
    now.mockReturnValue(1_000_000);
    await expect(getAccountBalance(event, LEGACY_MAIN_KEY)).resolves.toBe(
      500_000_000_000
    );

    // Switch A -> B one second later: the 5 s cache must not answer with A's balance.
    mockActiveSender = B;
    now.mockReturnValue(1_001_000);
    await expect(getAccountBalance(event, LEGACY_MAIN_KEY)).resolves.toBe(
      7_000_000_000
    );
    expect(readAddresses()).toEqual([A, B]);
  });

  it("never falls back to the previous wallet's balance when the new one cannot be read", async () => {
    mockActiveSender = C;
    now.mockReturnValue(2_000_000);
    await expect(getAccountBalance(event, LEGACY_MAIN_KEY)).resolves.toBe(
      300_000_000_000
    );

    // D's balance cannot be read (rate limited): Hive has no balance for D yet.
    mockActiveSender = D;
    now.mockReturnValue(2_010_000);
    await expect(getAccountBalance(event, LEGACY_MAIN_KEY)).resolves.toBe(0);
  });

  it('reads a QSDM address as it is, not the active wallet', async () => {
    mockActiveSender = F;
    now.mockReturnValue(3_000_000);
    await expect(getAccountBalance(event, E)).resolves.toBe(40_000_000_000);
    await expect(getAccountBalance(event, F)).resolves.toBe(2_000_000_000);
    expect(readAddresses()).toEqual([E, F]);
  });

  it('a wallet switch drops the cached balances', async () => {
    mockActiveSender = A;
    now.mockReturnValue(4_000_000);
    await getAccountBalance(event, LEGACY_MAIN_KEY);
    await getAccountBalance(event, LEGACY_MAIN_KEY);
    expect(readAddresses()).toEqual([A]);

    notifyQsdmActiveWalletChanged(A);
    await getAccountBalance(event, LEGACY_MAIN_KEY);
    expect(readAddresses()).toEqual([A, A]);
  });
});
