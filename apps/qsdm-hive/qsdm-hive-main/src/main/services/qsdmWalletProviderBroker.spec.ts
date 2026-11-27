/**
 * @jest-environment node
 */

import { dialog } from 'electron';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { getQsdmCellAccount } from 'main/controllers/qsdm/getQsdmCellAccount';

import {
  getQsdmWalletProviderPermissions,
  handleWalletProviderRequest,
  publicErrorText,
  QSDM_WALLET_PROVIDER_VERSION,
  revokeQsdmWalletProviderPermission,
  startQsdmWalletProviderBroker,
  stopQsdmWalletProviderBroker,
} from './qsdmWalletProviderBroker';

const mockGetAppDataPath = jest.fn();
const mockGetQsdmTaskActionSignerStatus = jest.fn();
const mockGetQsdmTaskActionSender = jest.fn();
const mockSignQsdmMessageWithCli = jest.fn();
const mockSubmitQsdmWalletTransferIntent = jest.fn();

jest.mock('main/node/helpers/getAppDataPath', () => ({
  getAppDataPath: () => mockGetAppDataPath(),
}));

jest.mock('main/services/qsdmTaskActionSigner', () => ({
  getQsdmTaskActionSignerStatus: () => mockGetQsdmTaskActionSignerStatus(),
  getQsdmTaskActionSender: () => mockGetQsdmTaskActionSender(),
}));

jest.mock('main/services/qsdmTaskActions', () => ({
  signQsdmMessageWithCli: (message: string) =>
    mockSignQsdmMessageWithCli(message),
}));

jest.mock('main/services/qsdmWalletTransfer', () => ({
  submitQsdmWalletTransferIntent: (payload: unknown) =>
    mockSubmitQsdmWalletTransferIntent(payload),
}));

jest.mock('main/controllers/qsdm/getQsdmCellAccount', () => ({
  getQsdmCellAccount: jest.fn(),
}));

const sender =
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const options = {
  openWallet: jest.fn(),
  showHive: jest.fn(),
};

const request = (method: string, params?: unknown) => ({
  version: QSDM_WALLET_PROVIDER_VERSION,
  id: 'request-1',
  origin: 'https://example.com',
  method,
  params,
});

const internalRequest = (method: string, params?: unknown) => ({
  ...request(method, params),
  origin: 'qsdm-extension://wallet-popup',
});

describe('qsdmWalletProviderBroker', () => {
  let appDataPath = '';

  beforeEach(() => {
    appDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qsdm-wallet-provider-')
    );
    mockGetAppDataPath.mockReturnValue(appDataPath);
    mockGetQsdmTaskActionSignerStatus.mockReturnValue({
      ready: true,
      sender,
    });
    mockGetQsdmTaskActionSender.mockReturnValue(sender);
    mockSignQsdmMessageWithCli.mockClear();
    mockSignQsdmMessageWithCli.mockResolvedValue({
      address: sender,
      public_key: 'public-key',
      signature: 'signature',
    });
    mockSubmitQsdmWalletTransferIntent.mockClear();
    mockSubmitQsdmWalletTransferIntent.mockResolvedValue({
      transaction_id: 'transaction-id',
      status: 'accepted',
    });
    (dialog.showMessageBox as jest.Mock).mockReset();
    (dialog.showMessageBox as jest.Mock).mockResolvedValue({ response: 0 });
    options.openWallet.mockReset();
    options.showHive.mockReset();
    (getQsdmCellAccount as jest.Mock).mockClear();
    (getQsdmCellAccount as jest.Mock).mockResolvedValue({
      balance: 42.5,
      tokenSymbol: 'CELL',
      reachable: true,
    });
  });

  afterEach(() => {
    fs.rmSync(appDataPath, { recursive: true, force: true });
  });

  it('rejects obsolete protocol versions and insecure remote origins', async () => {
    await expect(
      handleWalletProviderRequest(
        { ...request('qsdm_ping'), version: 'obsolete' },
        options
      )
    ).rejects.toThrow('Unsupported QSDM wallet provider version');

    await expect(
      handleWalletProviderRequest(
        { ...request('qsdm_ping'), origin: 'http://example.com' },
        options
      )
    ).rejects.toThrow('require HTTPS');
  });

  it('persists an exact-origin grant without exposing wallet secrets', async () => {
    await expect(
      handleWalletProviderRequest(request('qsdm_requestAccounts'), options)
    ).resolves.toEqual([sender]);

    expect(options.showHive).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(getQsdmWalletProviderPermissions().permissions).toEqual([
      expect.objectContaining({
        origin: 'https://example.com',
        address: sender,
      }),
    ]);

    const stored = fs.readFileSync(
      path.join(appDataPath, 'wallet-provider', 'permissions.json'),
      'utf-8'
    );
    expect(stored).not.toContain('passphrase');
    expect(stored).not.toContain('private_key');
  });

  it('requires a grant and user approval before signing', async () => {
    await expect(
      handleWalletProviderRequest(
        request('qsdm_signMessage', { message: 'ownership challenge' }),
        options
      )
    ).rejects.toThrow('not connected');

    await handleWalletProviderRequest(request('qsdm_requestAccounts'), options);
    await expect(
      handleWalletProviderRequest(
        request('qsdm_signMessage', { message: 'ownership challenge' }),
        options
      )
    ).resolves.toEqual({
      address: sender,
      public_key: 'public-key',
      signature: 'signature',
    });
    expect(mockSignQsdmMessageWithCli).toHaveBeenCalledWith(
      'ownership challenge'
    );
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('never shows or signs a QSDM Account message for another website', async () => {
    await handleWalletProviderRequest(request('qsdm_requestAccounts'), options);
    (dialog.showMessageBox as jest.Mock).mockClear();
    options.showHive.mockClear();
    const signIn = `QSDM Account wallet sign-in\nVersion: 1\nOrigin: https://qsdm.tech\nAddress: ${sender}\nChallenge: c1`;

    await expect(
      handleWalletProviderRequest(
        request('qsdm_signMessage', { message: signIn }),
        options
      )
    ).rejects.toThrow(
      'This message is for https://qsdm.tech, but https://example.com asked to sign it.'
    );
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(options.showHive).not.toHaveBeenCalled();
    expect(mockSignQsdmMessageWithCli).not.toHaveBeenCalled();
  });

  it('shows a QSDM Account sign-in from its own website as a sign-in', async () => {
    const accountRequest = (method: string, params?: unknown) => ({
      ...request(method, params),
      origin: 'https://qsdm.tech',
    });
    await handleWalletProviderRequest(
      accountRequest('qsdm_requestAccounts'),
      options
    );
    (dialog.showMessageBox as jest.Mock).mockClear();
    const signIn = `QSDM Account wallet sign-in\nVersion: 1\nOrigin: https://qsdm.tech\nAddress: ${sender}\nChallenge: c1`;

    await expect(
      handleWalletProviderRequest(
        accountRequest('qsdm_signMessage', { message: signIn }),
        options
      )
    ).resolves.toEqual(expect.objectContaining({ signature: 'signature' }));
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const shown = (dialog.showMessageBox as jest.Mock).mock.calls[0].at(-1);
    expect(shown).toEqual(
      expect.objectContaining({
        title: 'Sign in to QSDM Account',
        buttons: ['Sign in', 'Reject'],
      })
    );
    expect(shown.detail).toContain('It cannot send CELL.');
    expect(shown.detail).toContain(signIn);
    expect(mockSignQsdmMessageWithCli).toHaveBeenCalledWith(signIn);
  });

  it('revokes a site grant immediately', async () => {
    await handleWalletProviderRequest(request('qsdm_requestAccounts'), options);

    expect(revokeQsdmWalletProviderPermission('https://example.com')).toEqual({
      origin: 'https://example.com',
      revoked: true,
    });
    expect(getQsdmWalletProviderPermissions().permissions).toEqual([]);
    await expect(
      handleWalletProviderRequest(request('qsdm_accounts'), options)
    ).resolves.toEqual([]);
  });

  it('rejects invalid recipients before displaying a transfer approval', async () => {
    await handleWalletProviderRequest(request('qsdm_requestAccounts'), options);
    (dialog.showMessageBox as jest.Mock).mockClear();

    await expect(
      handleWalletProviderRequest(
        request('qsdm_sendTransaction', {
          recipient: '../not-a-wallet',
          amount: 1,
        }),
        options
      )
    ).rejects.toThrow('valid QSDM wallet address');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(mockSubmitQsdmWalletTransferIntent).not.toHaveBeenCalled();
  });

  it('accepts CELL precision up to eight decimals and rejects finer values', async () => {
    await handleWalletProviderRequest(request('qsdm_requestAccounts'), options);
    (dialog.showMessageBox as jest.Mock).mockClear();

    await expect(
      handleWalletProviderRequest(
        request('qsdm_sendTransaction', {
          recipient: sender,
          amount: 0.000000001,
        }),
        options
      )
    ).rejects.toThrow('no more than 8 decimal places');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();

    await expect(
      handleWalletProviderRequest(
        request('qsdm_sendTransaction', {
          recipient: sender,
          amount: 0.00000001,
        }),
        options
      )
    ).resolves.toEqual({
      transaction_id: 'transaction-id',
      status: 'accepted',
    });
    expect(mockSubmitQsdmWalletTransferIntent).toHaveBeenCalledWith({
      recipient: sender,
      amount: 0.00000001,
      expectedSender: sender,
    });
  });

  it('lets the trusted extension read the active balance without a site grant', async () => {
    await expect(
      handleWalletProviderRequest(internalRequest('qsdm_getBalance'), options)
    ).resolves.toEqual({
      address: sender,
      balance: 42.5,
      token: 'CELL',
      reachable: true,
    });
    expect(getQsdmWalletProviderPermissions().permissions).toEqual([]);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('lets the trusted extension request a transfer only after Hive approval', async () => {
    await expect(
      handleWalletProviderRequest(
        internalRequest('qsdm_sendTransaction', {
          recipient: sender,
          amount: 1.25,
        }),
        options
      )
    ).resolves.toEqual({
      transaction_id: 'transaction-id',
      status: 'accepted',
    });
    expect(options.showHive).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mockSubmitQsdmWalletTransferIntent).toHaveBeenCalledWith({
      recipient: sender,
      amount: 1.25,
      expectedSender: sender,
    });
    expect(getQsdmWalletProviderPermissions().permissions).toEqual([]);
  });

  it('continues to reject internal message-signing requests', async () => {
    await expect(
      handleWalletProviderRequest(
        internalRequest('qsdm_signMessage', { message: 'do not sign' }),
        options
      )
    ).rejects.toThrow('cannot request wallet signatures');
    expect(mockSignQsdmMessageWithCli).not.toHaveBeenCalled();
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('answers a failed request without local paths', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    mockGetQsdmTaskActionSignerStatus.mockImplementation(() => {
      throw new Error('spawn /home/jane/.local/qsdm/bin/qsdmcli ENOENT');
    });
    await startQsdmWalletProviderBroker(options);
    try {
      const state = JSON.parse(
        fs.readFileSync(
          path.join(appDataPath, 'wallet-provider', 'broker.json'),
          'utf-8'
        )
      ) as { port: number; token: string };
      const reply = await new Promise<{ status?: number; body: string }>(
        (resolve, reject) => {
          const body = JSON.stringify(request('qsdm_ping'));
          const post = http.request(
            {
              host: '127.0.0.1',
              port: state.port,
              path: '/v1/request',
              method: 'POST',
              headers: {
                Authorization: `Bearer ${state.token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              },
            },
            (response) => {
              let text = '';
              response.setEncoding('utf8');
              response.on('data', (chunk) => {
                text += chunk;
              });
              response.on('end', () =>
                resolve({ status: response.statusCode, body: text })
              );
            }
          );
          post.on('error', reject);
          post.end(body);
        }
      );

      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toEqual({
        ok: false,
        error: 'QSDM wallet request failed',
      });
      expect(reply.body).not.toContain('jane');
      expect(warn).toHaveBeenCalled();
    } finally {
      stopQsdmWalletProviderBroker();
      warn.mockRestore();
    }
  });
});

describe('publicErrorText', () => {
  it('uses a generic message for unexpected errors and thrown values', () => {
    expect(publicErrorText(new Error('Internal wallet tool diagnostic'))).toBe(
      'QSDM wallet request failed'
    );
    expect(publicErrorText('Internal wallet tool failure')).toBe(
      'QSDM wallet request failed'
    );
  });
});
