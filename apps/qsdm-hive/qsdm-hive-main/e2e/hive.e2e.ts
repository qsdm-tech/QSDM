import { expect, test } from '@playwright/test';

import { goTo, Hive, launchHive, setUpProfile, unlock } from './support/hive';
import { E2E_HUNTER, MockApi, startMockApi } from './support/mockApi';

import type { Locator, Page } from '@playwright/test';

// One Hive, one fresh profile, the flows in order: each step builds on the
// one before (the profile, then the wallets, then their history).
test.describe.configure({ mode: 'serial' });

// Throwaway passphrases for throwaway test wallets; not secrets.
const PASSPHRASE_1 = 'e2e-wallet-one-passphrase';
const PASSPHRASE_2 = 'e2e-wallet-two-passphrase';

let api: MockApi;
let hive: Hive;
let page: Page;

// The wallet addresses in Settings > Wallet > Wallets, in list order.
const walletAddresses = async (p: Page) =>
  p
    .locator('div.font-mono[title]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('title') || '')
        .filter((title) => /^[0-9a-f]{64}$/.test(title))
    );

const walletRow = (p: Page, address: string): Locator =>
  p.locator('div.py-3', {
    has: p.locator(`div.font-mono[title="${address}"]`),
  });

const activeWallet = async (p: Page) => {
  for (const address of await walletAddresses(p)) {
    if (
      // eslint-disable-next-line no-await-in-loop
      await walletRow(p, address)
        .getByText('Active', { exact: true })
        .isVisible()
    ) {
      return address;
    }
  }
  return null;
};

const createWallet = async (p: Page, passphrase: string) => {
  await p
    .getByRole('button', { name: 'Create New Wallet', exact: true })
    .click();
  await p.locator('#qsdm-new-passphrase').fill(passphrase);
  await p.locator('#qsdm-confirm-passphrase').fill(passphrase);
  await p.getByRole('button', { name: 'Create Wallet', exact: true }).click();
  await expect(
    p.getByText('Write down these 24 QSDM Recovery Words')
  ).toBeVisible({ timeout: 90_000 });
  await expect(p.locator('ol li')).toHaveCount(24);
  await p
    .getByRole('button', { name: 'I Saved These Words', exact: true })
    .click();
};

test.beforeAll(async () => {
  api = await startMockApi();
  hive = await launchHive(api);
  page = hive.page;
});

test.afterAll(async () => {
  await hive?.close();
  await api?.close();
});

// Playwright needs the destructuring pattern; no fixture is used here.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && page) {
    await testInfo.attach('screen', {
      body: await page.screenshot().catch(() => Buffer.from('')),
      contentType: 'image/png',
    });
  }
});

test('launch: the window opens on the first-run screens', async () => {
  expect(await hive.app.evaluate(({ app }) => app.isPackaged)).toBe(false);
  await expect(page.getByText('three simple steps.')).toBeVisible();
  await page.getByRole('button', { name: 'Start now!', exact: true }).click();
  await expect(page.getByText('Confirm your Access PIN.')).toBeVisible();
  // Nothing in this run reaches qsdm.tech: the release feed was not asked.
  expect(api.requests.some((r) => r.path.includes('hive-v2'))).toBe(false);
});

test('create wallet: a new QSDM wallet with 24 recovery words', async () => {
  await setUpProfile(page);
  await unlock(page);
  await goTo(page, '/settings/wallet');
  await expect(
    page.getByText('QSDM Wallet', { exact: true }).first()
  ).toBeVisible();

  await createWallet(page, PASSPHRASE_1);

  await expect.poll(async () => (await walletAddresses(page)).length).toBe(1);
  const [first] = await walletAddresses(page);
  expect(await activeWallet(page)).toBe(first);
});

test('wallet switch: a second wallet, then Use This Wallet', async () => {
  const [first] = await walletAddresses(page);

  // Added without switching: the first wallet stays active.
  await page
    .getByRole('button', { name: 'Create New Wallet', exact: true })
    .click();
  const switchNow = page.getByRole('checkbox', {
    name: 'Switch to the new wallet now',
  });
  await expect(switchNow).toBeVisible();
  await switchNow.uncheck();
  await createWallet(page, PASSPHRASE_2);

  await expect.poll(async () => (await walletAddresses(page)).length).toBe(2);
  const second = (await walletAddresses(page)).find((a) => a !== first);
  expect(second).toBeTruthy();
  expect(await activeWallet(page)).toBe(first);

  await walletRow(page, second as string)
    .getByRole('button', { name: 'Use This Wallet', exact: true })
    .click();
  await expect.poll(() => activeWallet(page)).toBe(second);
  await expect(
    walletRow(page, first).getByRole('button', {
      name: 'Use This Wallet',
      exact: true,
    })
  ).toBeVisible();
});

test('recent transactions: the active wallet, from the (mocked) network', async () => {
  const active = await activeWallet(page);
  expect(active).toMatch(/^[0-9a-f]{64}$/);

  await expect(
    page.getByText('Recent transactions', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('+12.5 CELL')).toBeVisible();
  await expect(page.getByText('−3 CELL')).toBeVisible();
  await expect(page.getByText('Received', { exact: true })).toBeVisible();
  await expect(page.getByText('Sent', { exact: true })).toBeVisible();
  expect(
    api.requests.some(
      (r) =>
        r.path.endsWith('/wallet/history') &&
        r.query.get('address') === active &&
        r.query.get('kind') === 'transfers'
    )
  ).toBe(true);

  await page.getByRole('tab', { name: 'Mining rewards', exact: true }).click();
  await expect(page.getByText('+0.5 CELL')).toBeVisible();
  await expect(page.getByText('Reward', { exact: true })).toBeVisible();
  expect(
    api.requests.some(
      (r) =>
        r.path.endsWith('/wallet/history') &&
        r.query.get('address') === active &&
        r.query.get('kind') === 'rewards'
    )
  ).toBe(true);
});

test('bug bounty row: totals and top hunters from the (mocked) ledger', async () => {
  await goTo(page, '/add-tasks');
  const row = page.locator('#bug-bounty-row');
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.getByText('QSDM Bug Bounty')).toBeVisible();
  await expect(row.getByText('Your bounty: 0 CELL')).toBeVisible();

  await row.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(row.getByText('Your bounty total')).toBeVisible();
  // The hunter of the mocked ledger is on the leaderboard (and, in the
  // ledger's month, also on this month's list).
  await expect(
    row.getByRole('cell', { name: E2E_HUNTER }).first()
  ).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Report a vulnerability', exact: true })
  ).toBeVisible();
  expect(api.requests.some((r) => r.path === '/bounty/payouts.json')).toBe(
    true
  );
});
