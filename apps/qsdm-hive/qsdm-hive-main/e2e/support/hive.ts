import fs from 'fs';
import os from 'os';
import path from 'path';

import { _electron as electron, expect } from '@playwright/test';
import { hash } from 'bcryptjs';

import type { MockApi } from './mockApi';
import type { ElectronApplication, Page } from '@playwright/test';

export const APP_DIR = path.resolve(__dirname, '..', '..');
// release/app holds the runtime package.json ("main": dist/main/main.js), so
// Electron starts Hive with its own name and version.
const RUNTIME_DIR = path.join(APP_DIR, 'release', 'app');
const MAIN_JS = path.join(RUNTIME_DIR, 'dist', 'main', 'main.js');
// A test PIN for a throwaway profile; not a secret.
export const E2E_PIN = '246810';

export type Hive = {
  app: ElectronApplication;
  page: Page;
  profileDir: string;
  close: () => Promise<void>;
};

/**
 * Starts the real Hive build (release/app/dist) with a fresh profile in a
 * temp folder and every QSDM URL pointed at the local mock API. Hive runs in
 * its e2e mode (QSDM_HIVE_E2E=1, only honoured when not packaged): no version
 * policy or updater, and nothing written outside the profile folder.
 */
export const launchHive = async (api: MockApi): Promise<Hive> => {
  if (!fs.existsSync(MAIN_JS)) {
    throw new Error(`Build Hive first (npm run build): ${MAIN_JS} is missing.`);
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qsdm-hive-e2e-'));
  const home = path.join(profileDir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const apiV1 = `${api.url}/api/v1`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    QSDM_HIVE_E2E: '1',
    QSDM_HIVE_APPDATA_ROOT: path.join(profileDir, 'appdata'),
    QSDM_PUBLIC_API_BASE_URL: api.url,
    QSDM_CORE_API_URL: apiV1,
    QSDM_CANONICAL_API_URL: apiV1,
    QSDM_GATEWAY_API_URL: apiV1,
    QSDM_HIVE_API_URL: apiV1,
    QSDM_HIVE_E2E_BOUNTY_LEDGER_URL: `${api.url}/bounty/payouts.json`,
    QSDM_HIVE_UPDATE_FEED_URL: `${api.url}/downloads/hive-v2`,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === 'linux') {
    env.HOME = home;
    env.XDG_CONFIG_HOME = path.join(home, '.config');
  }
  const app = await electron.launch({
    args: [RUNTIME_DIR],
    cwd: APP_DIR,
    env,
    timeout: 120_000,
  });
  const page = await app.firstWindow();
  // The first page is the startup screen; the renderer follows in the same window.
  await page.waitForURL(/index\.html/, { timeout: 120_000 });
  return {
    app,
    page,
    profileDir,
    close: async () => {
      await app.evaluate(({ app: electronApp }) => {
        (electronApp as unknown as { isQuitting: boolean }).isQuitting = true;
      });
      await app.close().catch(() => undefined);
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
};

type HiveMainApi = {
  generateSeedPhrase: () => Promise<string>;
  createNodeWallets: (payload: {
    mnemonic: string;
    accountName: string;
    encryptedSecretPhrase: string;
  }) => Promise<unknown>;
  setActiveAccount: (payload: { accountName: string }) => Promise<boolean>;
  storeUserConfig: (payload: {
    settings: Record<string, unknown>;
  }) => Promise<boolean>;
};

/**
 * Finishes the first-run setup through Hive's own IPC (the same calls the
 * onboarding screens make): a local Hive profile and the Access PIN. The
 * onboarding screens themselves are covered by the launch test.
 */
export const setUpProfile = async (page: Page) => {
  const pinHash = await hash(E2E_PIN, 10);
  await page.evaluate(async (hashedPin) => {
    const { main } = window as unknown as { main: HiveMainApi };
    const mnemonic = await main.generateSeedPhrase();
    await main.createNodeWallets({
      mnemonic,
      accountName: 'e2e',
      encryptedSecretPhrase: 'e2e-test-profile',
    });
    await main.setActiveAccount({ accountName: 'e2e' });
    await main.storeUserConfig({
      settings: {
        pin: hashedPin,
        onboardingCompleted: true,
        hasCopiedReferralCode: false,
        hasStartedTheMainnetMigration: true,
        hasFinishedTheMainnetMigration: true,
        launchOnRestart: false,
      },
    });
  }, pinHash);
};

export const goTo = async (page: Page, route: string) => {
  await page.evaluate((hashRoute) => {
    window.location.hash = hashRoute;
  }, `#${route}`);
};

/** Reloads the renderer at / and unlocks with the PIN. */
export const unlock = async (page: Page) => {
  await page.evaluate(() => {
    window.location.hash = '#/';
    window.location.reload();
  });
  await page.waitForURL(/#\/unlock/, { timeout: 120_000 });
  const firstDigit = page.locator('input').first();
  await expect(firstDigit).toBeVisible();
  await firstDigit.click();
  await page.keyboard.type(E2E_PIN, { delay: 50 });
  await page.waitForURL((url) => !url.hash.startsWith('#/unlock'), {
    timeout: 60_000,
  });
};
