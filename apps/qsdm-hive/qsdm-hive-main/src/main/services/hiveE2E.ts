import { app } from '../app';

/**
 * True only while the end-to-end tests (e2e/, Playwright) drive a Hive
 * build that is not packaged, with QSDM_HIVE_E2E=1. A packaged (installed)
 * Hive never honours the switch.
 *
 * In such a run Hive:
 * - skips the signed version policy and the automatic updater (the tests
 *   run without qsdm.tech; the policy has its own unit tests);
 * - changes nothing outside its data folder: no start at login, no
 *   qsdm-hive:// protocol handler, no browser native-messaging host;
 * - reads the bug bounty ledger from QSDM_HIVE_E2E_BOUNTY_LEDGER_URL, so the
 *   tests can serve it from their local mock server.
 */
export function isHiveE2ETestRun(
  env: NodeJS.ProcessEnv = process.env,
  packaged = Boolean(app.isPackaged)
) {
  return !packaged && env.QSDM_HIVE_E2E === '1';
}
