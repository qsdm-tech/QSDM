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

import { useQsdmWalletChangeListener } from 'renderer/features/settings/hooks/useQsdmWalletChangeListener';
import * as services from 'renderer/services';

import { QsdmWalletPanel } from './QsdmWalletPanel';

jest.mock('config/qsdm', () => ({
  QSDM_BRIDGE_CONFIG: {
    coreConnectionMode: 'official',
    coreApiUrl: 'https://api.qsdm.tech/api/v1',
  },
}));

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
  CopyButton: () => <button type="button">Copy</button>,
  ErrorMessage: ({ error }: { error?: unknown }) =>
    error ? (
      <div role="alert">
        {typeof error === 'string' ? error : (error as Error).message}
      </div>
    ) : null,
  LoadingSpinner: () => <span data-testid="loading" />,
}));

jest.mock('renderer/features/common/hooks', () => ({
  useClipboard: () => ({ copyToClipboard: jest.fn(), copied: false }),
}));

jest.mock('renderer/utils', () => ({
  isValidWalletAddress: jest.fn(async () => true),
}));

jest.mock('renderer/services', () => ({
  QueryKeys: jest.requireActual('renderer/services/reactQueryService')
    .QueryKeys,
  activateQsdmWallet: jest.fn(),
  createQsdmSignerWallet: jest.fn(),
  enableQsdmSignerLegacyRecovery: jest.fn(),
  exportQsdmSignerRecoveryWords: jest.fn(),
  exportQsdmSignerWalletBackup: jest.fn(),
  forgetQsdmWallet: jest.fn(),
  getQsdmCellAccount: jest.fn(),
  getQsdmCoreStatus: jest.fn(),
  getQsdmWalletHistory: jest.fn(),
  getQsdmWalletProviderPermissions: jest.fn(),
  importQsdmSignerWallet: jest.fn(),
  listQsdmWallets: jest.fn(),
  openBrowserWindow: jest.fn(),
  recoverQsdmWallet: jest.fn(),
  renameQsdmWallet: jest.fn(),
  restoreQsdmSignerWallet: jest.fn(),
  revokeQsdmWalletProviderPermission: jest.fn(),
  transferCellFromMainWallet: jest.fn(),
  unlockQsdmSignerWallet: jest.fn(),
}));

const mocked = services as unknown as Record<string, jest.Mock>;

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const RECIPIENT = 'd'.repeat(64);
// How the panel and the list print an address.
const panelAddress = (address: string) =>
  `${address.slice(0, 12)}...${address.slice(-12)}`;
const listAddress = (address: string) =>
  `${address.slice(0, 10)}...${address.slice(-10)}`;

type Wallet = {
  address: string;
  label: string;
  addedAt: string;
  source: string;
};

// A fake main process: one active wallet; reads resolve the active address when they START, like Hive's IPC handlers.
const backend = {
  active: A,
  wallets: [] as Wallet[],
  recoverable: [] as Array<Record<string, unknown>>,
  balances: { [A]: 500, [B]: 7, [C]: 12 } as Record<string, number>,
  nextNonces: { [A]: 41, [B]: 3, [C]: 1 } as Record<string, number>,
  // Each wallet's last send, as Recent transactions lists it.
  lastSend: { [A]: 25, [B]: 0.75, [C]: 1 } as Record<string, number>,
  accountGate: undefined as Promise<void> | undefined,
  walletChangedListeners: [] as Array<
    (event: unknown, payload: { address: string }) => void
  >,
};

const holdAccountReads = () => {
  let release: () => void = () => undefined;
  backend.accountGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    backend.accountGate = undefined;
    release();
  };
};

const wallet = (address: string, label: string): Wallet => ({
  address,
  label,
  addedAt: '2026-11-20T00:00:00.000Z',
  source: 'imported',
});

const installBackend = () => {
  backend.active = A;
  backend.wallets = [wallet(A, 'Main wallet'), wallet(B, 'Wallet 2')];
  backend.recoverable = [];
  backend.accountGate = undefined;
  backend.walletChangedListeners = [];

  mocked.getQsdmCellAccount.mockImplementation(async () => {
    const address = backend.active;
    if (backend.accountGate) await backend.accountGate;
    return {
      configured: true,
      reachable: true,
      apiUrl: 'https://api.qsdm.tech',
      dashboardUrl: 'https://qsdm.tech',
      tokenSymbol: 'CELL',
      address,
      balance: backend.balances[address],
      nonce: backend.nextNonces[address] - 1,
      nextNonce: backend.nextNonces[address],
      checkedAt: '2026-11-22T00:00:00.000Z',
    };
  });
  mocked.getQsdmCoreStatus.mockImplementation(async () => ({
    coreConnectionMode: 'official',
    effectiveCoreApiUrl: 'https://api.qsdm.tech/api/v1',
    canonicalSafety: { safe: true },
    taskSigner: {
      mode: 'cli',
      configured: true,
      ready: true,
      sender: backend.active,
      keystorePath: '/hive-signer/wallet.json',
      recoveryEnabled: true,
      recoveryWords: 24,
    },
  }));
  mocked.listQsdmWallets.mockImplementation(async () => ({
    active: backend.active,
    wallets: backend.wallets,
    recoverable: backend.recoverable,
    minerRunning: false,
  }));
  mocked.getQsdmWalletProviderPermissions.mockResolvedValue({
    permissions: [],
  });
  mocked.getQsdmWalletHistory.mockImplementation(
    async ({ address, kind }: { address: string; kind: string }) => ({
      address,
      kind,
      available: false,
      items: [],
      nextBefore: null,
      localSends: [
        {
          txId: `tx-${address.slice(0, 4)}`,
          time: '2026-11-22T10:00:00.000Z',
          type: 'sent',
          counterparty: RECIPIENT,
          amount: backend.lastSend[address],
          outgoing: true,
          status: 'confirmed',
          source: 'local',
        },
      ],
    })
  );
  mocked.activateQsdmWallet.mockImplementation(
    async ({ address }: { address: string }) => {
      // Hive's main process switches, then tells every window.
      emitWalletChanged(address);
      return { address, unlocked: true };
    }
  );
  mocked.forgetQsdmWallet.mockImplementation(
    async ({ address }: { address: string }) => {
      if (address === backend.active) {
        throw new Error('Switch to another wallet before removing this one');
      }
      backend.wallets = backend.wallets.filter((w) => w.address !== address);
      return { address };
    }
  );
  mocked.recoverQsdmWallet.mockImplementation(
    async ({ backupFile }: { backupFile: string }) => {
      const backup = backend.recoverable.find(
        (item) => item.backupFile === backupFile
      ) as { address: string };
      backend.recoverable = [];
      backend.wallets = [
        ...backend.wallets,
        wallet(backup.address, 'Recovered wallet'),
      ];
      return { address: backup.address };
    }
  );
  mocked.transferCellFromMainWallet.mockResolvedValue({
    transaction_id: 'tx-after-switch',
    status: 'accepted',
  });

  Object.defineProperty(window, 'main', {
    configurable: true,
    value: {
      onQsdmWalletChanged: jest.fn(
        (listener: (event: unknown, payload: { address: string }) => void) => {
          backend.walletChangedListeners.push(listener);
          return () => {
            backend.walletChangedListeners =
              backend.walletChangedListeners.filter((l) => l !== listener);
          };
        }
      ),
    },
  });
};

// AppWrapper mounts this listener for the whole app.
function WalletChangeListener() {
  useQsdmWalletChangeListener();
  return null;
}

const renderWalletSettings = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <WalletChangeListener />
      <QsdmWalletPanel />
    </QueryClientProvider>
  );
  return { queryClient, view };
};

const emitWalletChanged = (address: string) => {
  backend.active = address;
  backend.walletChangedListeners.forEach((listener) =>
    listener({}, { address })
  );
};

const walletRow = (label: string) =>
  screen.getByText(label).closest('.py-3') as HTMLElement;

const balanceCard = () =>
  screen.getByText('Balance').parentElement as HTMLElement;

const nonceCard = () => screen.getByText('Nonce').parentElement as HTMLElement;

const switchTo = async (label: string) => {
  fireEvent.click(
    within(walletRow(label)).getByRole('button', { name: 'Use This Wallet' })
  );
  await waitFor(() =>
    expect(within(walletRow(label)).getByText('Active')).toBeInTheDocument()
  );
};

describe('QSDM wallet switch in Settings > Wallet', () => {
  let rendered: ReturnType<typeof renderWalletSettings> | undefined;

  beforeEach(() => {
    Object.values(mocked).forEach((value) => {
      if (typeof value === 'function' && 'mockReset' in value) {
        value.mockReset();
      }
    });
    installBackend();
  });

  afterEach(() => {
    rendered?.view.unmount();
    rendered?.queryClient.clear();
    rendered = undefined;
  });

  it("switch A -> B: shows B's balance, nonce and history and never A's numbers under B", async () => {
    rendered = renderWalletSettings();
    await waitFor(() =>
      expect(within(balanceCard()).getByText('500.000')).toBeInTheDocument()
    );
    expect(screen.getByText(panelAddress(A))).toBeInTheDocument();
    expect(await screen.findByText('−25 CELL')).toBeInTheDocument();

    const release = holdAccountReads();
    await switchTo('Wallet 2');

    // B is active now; while B's account is still loading nothing of A may be shown.
    expect(screen.queryByText('500.000')).not.toBeInTheDocument();
    expect(screen.queryByText(panelAddress(A))).not.toBeInTheDocument();
    expect(screen.queryByText('−25 CELL')).not.toBeInTheDocument();

    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(within(balanceCard()).getByText('7.000')).toBeInTheDocument()
    );
    expect(screen.getByText(panelAddress(B))).toBeInTheDocument();
    expect(within(nonceCard()).getByText('3')).toBeInTheDocument();
    expect(await screen.findByText('−0.75 CELL')).toBeInTheDocument();
    expect(screen.queryByText('500.000')).not.toBeInTheDocument();
    expect(screen.queryByText('−25 CELL')).not.toBeInTheDocument();
    expect(
      mocked.getQsdmWalletHistory.mock.calls.map(([request]) => request.address)
    ).not.toContain(undefined);
  });

  it('a switch made elsewhere (adding a wallet with "Switch to the new wallet now") drops the previous wallet too', async () => {
    backend.wallets = [...backend.wallets, wallet(C, 'Wallet 3')];
    rendered = renderWalletSettings();
    await waitFor(() =>
      expect(within(balanceCard()).getByText('500.000')).toBeInTheDocument()
    );

    const release = holdAccountReads();
    act(() => {
      emitWalletChanged(C);
    });
    await waitFor(() =>
      expect(
        within(walletRow('Wallet 3')).getByText('Active')
      ).toBeInTheDocument()
    );
    expect(screen.queryByText('500.000')).not.toBeInTheDocument();
    expect(screen.queryByText(panelAddress(A))).not.toBeInTheDocument();

    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(within(balanceCard()).getByText('12.000')).toBeInTheDocument()
    );
    expect(screen.getByText(panelAddress(C))).toBeInTheDocument();
  });

  it('a send after the switch carries the address the screen showed (B)', async () => {
    rendered = renderWalletSettings();
    await waitFor(() =>
      expect(within(balanceCard()).getByText('500.000')).toBeInTheDocument()
    );
    await switchTo('Wallet 2');
    await waitFor(() =>
      expect(within(balanceCard()).getByText('7.000')).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText('Destination'), {
      target: { value: RECIPIENT },
    });
    fireEvent.change(screen.getByLabelText('Amount'), {
      target: { value: '2' },
    });
    const send = screen.getByRole('button', { name: 'Send CELL' });
    await waitFor(() => expect(send).not.toBeDisabled());
    fireEvent.click(send);

    await waitFor(() =>
      expect(mocked.transferCellFromMainWallet).toHaveBeenCalledTimes(1)
    );
    expect(mocked.transferCellFromMainWallet).toHaveBeenCalledWith(
      '__qsdm_signer__',
      2,
      RECIPIENT,
      B
    );
  });

  it("removing the previously active wallet keeps showing the active wallet's data", async () => {
    rendered = renderWalletSettings();
    await waitFor(() =>
      expect(within(balanceCard()).getByText('500.000')).toBeInTheDocument()
    );
    // The active wallet has no Remove button: Hive switches first, then removes.
    expect(
      within(walletRow('Main wallet')).queryByRole('button', {
        name: 'Remove',
      })
    ).not.toBeInTheDocument();

    await switchTo('Wallet 2');
    await waitFor(() =>
      expect(within(balanceCard()).getByText('7.000')).toBeInTheDocument()
    );

    fireEvent.click(
      within(walletRow('Main wallet')).getByRole('button', { name: 'Remove' })
    );
    fireEvent.change(
      screen.getByLabelText('Type or paste the full address to confirm'),
      { target: { value: A } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Wallet' }));

    await waitFor(() =>
      expect(screen.queryByText('Main wallet')).not.toBeInTheDocument()
    );
    expect(mocked.forgetQsdmWallet).toHaveBeenCalledWith({
      address: A,
      confirmAddress: A,
    });
    expect(within(balanceCard()).getByText('7.000')).toBeInTheDocument();
    expect(screen.getByText(panelAddress(B))).toBeInTheDocument();
    expect(screen.queryByText('500.000')).not.toBeInTheDocument();
  });

  it("Add Back lists the recovered wallet and keeps the active wallet's data", async () => {
    backend.recoverable = [
      {
        address: C,
        backupFile: 'wallet.json.bak-1795029829858',
        backedUpAt: '2026-11-18T00:00:00.000Z',
        hasPassphraseBackup: true,
      },
    ];
    rendered = renderWalletSettings();
    await waitFor(() =>
      expect(within(balanceCard()).getByText('500.000')).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Back' }));
    await waitFor(() =>
      expect(screen.getByText('Recovered wallet')).toBeInTheDocument()
    );

    expect(
      within(walletRow('Recovered wallet')).queryByText('Active')
    ).not.toBeInTheDocument();
    expect(
      within(walletRow('Main wallet')).getByText('Active')
    ).toBeInTheDocument();
    expect(screen.getByText(listAddress(C))).toBeInTheDocument();
    expect(within(balanceCard()).getByText('500.000')).toBeInTheDocument();
    expect(screen.getByText(panelAddress(A))).toBeInTheDocument();
    expect(screen.queryByText('12.000')).not.toBeInTheDocument();
  });
});
