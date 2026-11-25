import http from 'http';

import type { AddressInfo } from 'net';

// A local stand-in for api.qsdm.tech and qsdm.tech during the e2e tests.
// It answers the two things the tests check (the wallet history and the bug
// bounty ledger) and 404 for everything else, so Hive never reaches the real
// network. Every request is recorded.

export const E2E_HUNTER = 'e2e-hunter';
export const E2E_HUNTER_ADDRESS = 'ab'.repeat(32);
export const E2E_COUNTERPARTY = 'cd'.repeat(32);

export type MockRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
};

export type MockApi = {
  url: string;
  requests: MockRequest[];
  close: () => Promise<void>;
};

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
};

const walletHistory = (address: string, kind: string) => {
  if (kind === 'rewards') {
    return {
      items: [
        {
          tx_id: 'e2e-reward-1',
          kind: 'reward',
          to: address,
          amount: 0.5,
          time: '2026-11-21T08:00:00Z',
          status: 1,
          height: 1200001,
        },
      ],
      next_before: null,
    };
  }
  return {
    items: [
      {
        tx_id: 'e2e-received-1',
        kind: 'receive',
        from: E2E_COUNTERPARTY,
        to: address,
        amount: 12.5,
        fee: 0.001,
        time: '2026-11-20T10:00:00Z',
        status: 1,
        height: 1200000,
      },
      {
        tx_id: 'e2e-sent-1',
        kind: 'send',
        from: address,
        to: E2E_COUNTERPARTY,
        amount: 3,
        fee: 0.001,
        time: '2026-11-19T10:00:00Z',
        status: 1,
        height: 1199000,
      },
    ],
    next_before: null,
  };
};

const bountyLedger = () => ({
  schema: 'qsdm.bounty-ledger.v1',
  updated: '2026-11-20T00:00:00Z',
  wallet: 'ef'.repeat(32),
  pool_cell: 100000,
  monthly_prizes_cell: [1000, 500, 250],
  links: {
    report: 'https://github.com/qsdm-tech/QSDM/security/advisories/new',
    advisories:
      'https://github.com/qsdm-tech/QSDM/security/advisories?state=published',
    rules: 'https://qsdm.tech/security.html',
    page: 'https://qsdm.tech/bounty.html',
  },
  payouts: [
    {
      tx: 'e2e-bounty-1',
      block: 1190000,
      time: '2026-11-15T12:00:00Z',
      address: E2E_HUNTER_ADDRESS,
      amount_cell: 1000,
      kind: 'bounty',
      hunter: E2E_HUNTER,
      advisory: null,
    },
  ],
});

export const startMockApi = async (): Promise<MockApi> => {
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requests.push({
      method: req.method || 'GET',
      path: url.pathname,
      query: url.searchParams,
    });
    if (url.pathname.endsWith('/wallet/history')) {
      const address = (url.searchParams.get('address') || '').toLowerCase();
      json(
        res,
        200,
        walletHistory(address, url.searchParams.get('kind') || 'transfers')
      );
      return;
    }
    if (url.pathname === '/bounty/payouts.json') {
      json(res, 200, bountyLedger());
      return;
    }
    json(res, 404, { error: 'not served by the e2e mock' });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
};
