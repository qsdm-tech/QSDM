/**
 * @jest-environment node
 */
import { ChildProcess } from 'child_process';
import { app } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { QSDM_MINER_SYSTEM_TASK_ID } from 'config/qsdmSystemTasks';
import { LogLevel } from 'vendor/qsdm-chain/taskNode';

import {
  readQsdmMinerBondChoice,
  rememberQsdmMinerBondChoice,
} from './qsdmMinerEnrollment';
import {
  createQsdmMinerEnrollmentWatch,
  describeQsdmWatchError,
  QSDM_MINER_ENROLLMENT_CHECK_MS,
  QSDM_MINER_ENROLLMENT_ENDED_MESSAGE,
  QsdmMinerEnrollmentWatchDeps,
  startQsdmMinerEnrollmentWatch,
} from './qsdmMinerEnrollmentWatch';

jest.mock('main/services/qsdmTaskActionSigner', () => ({
  getQsdmTaskActionCliPath: jest.fn(),
  getQsdmTaskActionKeystorePath: jest.fn(),
  getQsdmTaskActionPassphraseFile: jest.fn(),
  getQsdmTaskActionSender: jest.fn(),
}));

const SIGNER = 'a'.repeat(64);
const NODE_ID = 'hive-pc-0123456789ab';
const TASK = QSDM_MINER_SYSTEM_TASK_ID;

const active = (bondMode?: string, owner = SIGNER) => ({
  owner,
  phase: 'active',
  ...(bondMode ? { bond_mode: bondMode } : {}),
});

const fakeDeps = (
  records: Array<object | undefined | Error>,
  choice?: 'upfront' | 'mining_rewards'
) => {
  const remembered: Record<string, string> = {};
  const deps = {
    getNodeId: jest.fn(() => NODE_ID),
    getSigner: jest.fn(() => SIGNER),
    fetchRecord: jest.fn(async () => {
      const next = records.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
    readBondChoice: jest.fn(() => choice),
    rememberBondChoice: jest.fn((owner, nodeId, mode) => {
      remembered[`${owner}:${nodeId}`] = mode;
    }),
    enroll: jest.fn(async () => ({ ready: true })),
    restart: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    notify: jest.fn(),
  };
  return {
    deps: deps as QsdmMinerEnrollmentWatchDeps & typeof deps,
    remembered,
  };
};

describe('miner enrollment watch', () => {
  it('remembers the bond mode of the active enrollment', async () => {
    const { deps, remembered } = fakeDeps([
      active('mining_rewards'),
      active(),
      active('mining_rewards', 'b'.repeat(64)),
    ]);
    const watch = createQsdmMinerEnrollmentWatch(TASK, deps);

    await watch.check();
    expect(remembered).toEqual({ [`${SIGNER}:${NODE_ID}`]: 'mining_rewards' });
    // No bond_mode on the record: the chain treats it as an upfront bond.
    await watch.check();
    expect(remembered[`${SIGNER}:${NODE_ID}`]).toBe('upfront');
    // Another wallet's enrollment is not this wallet's choice.
    await watch.check();
    expect(deps.rememberBondChoice).toHaveBeenCalledTimes(2);
    expect(deps.enroll).not.toHaveBeenCalled();
  });

  it('enrolls again with the remembered choice and restarts the miner', async () => {
    const { deps } = fakeDeps(
      [active('mining_rewards'), undefined],
      'mining_rewards'
    );
    const watch = createQsdmMinerEnrollmentWatch(TASK, deps);

    await watch.check();
    await watch.check();

    expect(deps.enroll).toHaveBeenCalledWith('mining_rewards');
    expect(deps.restart).toHaveBeenCalledWith(TASK);
    expect(deps.stop).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith(
      TASK,
      LogLevel.Warn,
      'Miner enrollment expired. Enrolling again with "Use mining earnings" and restarting the miner.'
    );

    // Handled once: later checks do nothing.
    await watch.check();
    expect(deps.fetchRecord).toHaveBeenCalledTimes(2);
    expect(deps.enroll).toHaveBeenCalledTimes(1);
  });

  it('locks CELL again only when the user chose "Lock CELL now"', async () => {
    const { deps } = fakeDeps([undefined], 'upfront');

    await createQsdmMinerEnrollmentWatch(TASK, deps).check();

    expect(deps.enroll).toHaveBeenCalledWith('upfront');
  });

  it('never picks a bond itself: without a choice it stops the miner', async () => {
    const { deps } = fakeDeps([undefined]);

    await createQsdmMinerEnrollmentWatch(TASK, deps).check();

    expect(deps.enroll).not.toHaveBeenCalled();
    expect(deps.restart).not.toHaveBeenCalled();
    expect(deps.stop).toHaveBeenCalledWith(TASK);
    expect(deps.notify).toHaveBeenCalledWith(
      TASK,
      LogLevel.Warn,
      QSDM_MINER_ENROLLMENT_ENDED_MESSAGE
    );
  });

  it('leaves an enrollment that was unenrolled or slashed alone', async () => {
    const { deps } = fakeDeps(
      [{ owner: SIGNER, phase: 'pending_unbond' }, undefined],
      'upfront'
    );
    const watch = createQsdmMinerEnrollmentWatch(TASK, deps);

    await watch.check();
    await watch.check();

    expect(deps.enroll).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it('treats an API error (HTTP 429) as no answer, not as a removal', async () => {
    const { deps } = fakeDeps(
      [new Error('Request failed with status code 429'), undefined],
      'mining_rewards'
    );
    const watch = createQsdmMinerEnrollmentWatch(TASK, deps);

    await watch.check();
    expect(deps.enroll).not.toHaveBeenCalled();
    await watch.check();
    expect(deps.enroll).toHaveBeenCalledWith('mining_rewards');
  });

  it('stops the miner with the reason when enrolling again fails', async () => {
    const { deps } = fakeDeps([undefined], 'mining_rewards');
    deps.enroll.mockRejectedValueOnce(
      new Error(
        JSON.stringify({ detailed: 'Unlock your QSDM wallet.', type: 'x' })
      )
    );

    await createQsdmMinerEnrollmentWatch(TASK, deps).check();

    expect(deps.restart).not.toHaveBeenCalled();
    expect(deps.stop).toHaveBeenCalledWith(TASK);
    expect(deps.notify).toHaveBeenLastCalledWith(
      TASK,
      LogLevel.Error,
      'Miner stopped: enrolling again failed. Unlock your QSDM wallet.'
    );
  });

  it('runs one check at a time', async () => {
    const { deps } = fakeDeps([active('mining_rewards'), active()]);
    const watch = createQsdmMinerEnrollmentWatch(TASK, deps);

    await Promise.all([watch.check(), watch.check()]);

    expect(deps.fetchRecord).toHaveBeenCalledTimes(1);
  });

  it('reads the reason of controller errors', () => {
    expect(
      describeQsdmWatchError(
        new Error(JSON.stringify({ detailed: 'plain reason', type: 'x' }))
      )
    ).toBe('plain reason');
    expect(describeQsdmWatchError(new Error('as is'))).toBe('as is');
  });

  it('checks on the miner cadence while the task runs and ends on exit', async () => {
    jest.useFakeTimers();
    try {
      const { deps } = fakeDeps([active(), active(), active()]);
      const child = new EventEmitter() as ChildProcess;
      startQsdmMinerEnrollmentWatch(TASK, child, () => true, deps);

      jest.advanceTimersByTime(QSDM_MINER_ENROLLMENT_CHECK_MS - 1);
      expect(deps.fetchRecord).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(deps.fetchRecord).toHaveBeenCalledTimes(1);

      child.emit('exit', 0, null);
      jest.advanceTimersByTime(QSDM_MINER_ENROLLMENT_CHECK_MS * 3);
      expect(deps.fetchRecord).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('remembered bond choice', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qsdm-bond-choice-'));
    (app.getPath as jest.Mock).mockReturnValue(root);
  });

  afterEach(() => {
    (app.getPath as jest.Mock).mockImplementation(() => process.cwd());
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is kept per wallet and NodeID', () => {
    expect(readQsdmMinerBondChoice(SIGNER, NODE_ID)).toBeUndefined();

    rememberQsdmMinerBondChoice(
      SIGNER.toUpperCase(),
      NODE_ID,
      'mining_rewards'
    );
    rememberQsdmMinerBondChoice('b'.repeat(64), NODE_ID, 'upfront');

    expect(readQsdmMinerBondChoice(SIGNER, NODE_ID)).toBe('mining_rewards');
    expect(readQsdmMinerBondChoice('b'.repeat(64), NODE_ID)).toBe('upfront');
    expect(readQsdmMinerBondChoice(SIGNER, 'hive-other')).toBeUndefined();
  });
});
