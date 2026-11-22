import { ChildProcess } from 'child_process';

import { RendererEndpoints } from 'config/endpoints';
import { isQsdmPoolMinerSystemTaskId } from 'config/qsdmSystemTasks';
import {
  enrollQsdmMiner,
  fetchQsdmMinerEnrollmentRecord,
  getQsdmMinerConfiguredNodeId,
  QsdmMinerBondMode,
  readQsdmMinerBondChoice,
  rememberQsdmMinerBondChoice,
} from 'main/services/qsdmMinerEnrollment';
import { writeQsdmSystemTaskLog } from 'main/services/qsdmSystemTasks';
import { getQsdmTaskActionSender } from 'main/services/qsdmTaskActionSigner';
import { sendEventAllWindows } from 'utils/sendEventAllWindows';
import { LogLevel } from 'vendor/qsdm-chain/taskNode';

// While a miner task runs, Hive checks that its enrollment is still on the
// chain and enrolls again when the chain removed it.
//
// From block 1,190,000 the chain removes a "Use mining earnings" (deferred
// bond) enrollment whose bond is still empty 60,480 blocks after it was made
// (QSDM/source/pkg/mining/enrollment/deferred_prune.go). Pool-only miners
// never fill that bond from pooled payouts, so their enrollment ends after
// about 7 days and every later proof is rejected; Hive used to check the
// enrollment only when the miner started.

// The miner itself re-reads its enrollment from the same endpoint at this
// cadence (DefaultEnrollmentPollInterval in cmd/qsdmminer-console), so Hive
// learns of a removal as soon as the miner does, for one small GET per check.
export const QSDM_MINER_ENROLLMENT_CHECK_MS = 30_000;

export const QSDM_MINER_BOND_MODE_LABELS: Record<QsdmMinerBondMode, string> = {
  mining_rewards: 'Use mining earnings',
  upfront: 'Lock CELL now',
};

export const QSDM_MINER_ENROLLMENT_ENDED_MESSAGE =
  'Miner stopped: its enrollment expired. Start the miner to enroll again.';

type WatchedEnrollmentRecord = {
  owner?: string;
  phase?: string;
  bond_mode?: string;
};

export type QsdmMinerEnrollmentWatchDeps = {
  getNodeId: () => string | undefined;
  getSigner: () => string | undefined;
  // undefined: the chain has no enrollment for this NodeID (HTTP 404).
  fetchRecord: (nodeId: string) => Promise<WatchedEnrollmentRecord | undefined>;
  readBondChoice: (
    owner: string,
    nodeId: string
  ) => QsdmMinerBondMode | undefined;
  rememberBondChoice: (
    owner: string,
    nodeId: string,
    bondMode: QsdmMinerBondMode
  ) => void;
  enroll: (bondMode: QsdmMinerBondMode) => Promise<unknown>;
  restart: (taskId: string) => Promise<void>;
  stop: (taskId: string) => Promise<void>;
  notify: (taskId: string, level: LogLevel, message: string) => void;
};

// Errors from IPC controllers carry {"detailed": "...", "type": "..."} JSON.
export const describeQsdmWatchError = (error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error ?? 'unknown error');
  try {
    const parsed = JSON.parse(message) as { detailed?: unknown };
    if (typeof parsed?.detailed === 'string') return parsed.detailed;
  } catch {
    // Not JSON: the message itself.
  }
  return message;
};

export const createQsdmMinerEnrollmentWatch = (
  taskId: string,
  deps: QsdmMinerEnrollmentWatchDeps
) => {
  // A miner task starts only with an active enrollment.
  let lastPhase = 'active';
  let busy = false;
  let handled = false;

  const handleRemoved = async (signer: string, nodeId: string) => {
    handled = true;
    // Enroll again only the way this wallet chose for this NodeID; without a
    // known choice, never pick one (an upfront bond would spend CELL).
    const bondMode = deps.readBondChoice(signer, nodeId);
    if (!bondMode) {
      deps.notify(taskId, LogLevel.Warn, QSDM_MINER_ENROLLMENT_ENDED_MESSAGE);
      await deps.stop(taskId);
      return;
    }
    deps.notify(
      taskId,
      LogLevel.Warn,
      `Miner enrollment expired. Enrolling again with "${QSDM_MINER_BOND_MODE_LABELS[bondMode]}" and restarting the miner.`
    );
    try {
      await deps.enroll(bondMode);
    } catch (error) {
      deps.notify(
        taskId,
        LogLevel.Error,
        `Miner stopped: enrolling again failed. ${describeQsdmWatchError(
          error
        )}`
      );
      await deps.stop(taskId);
      return;
    }
    try {
      await deps.restart(taskId);
    } catch (error) {
      deps.notify(
        taskId,
        LogLevel.Error,
        `Miner enrolled again but did not restart. Start it again. ${describeQsdmWatchError(
          error
        )}`
      );
    }
  };

  const checkOnce = async () => {
    const nodeId = deps.getNodeId();
    const signer = deps.getSigner();
    if (!nodeId || !signer) return;
    let record: WatchedEnrollmentRecord | undefined;
    try {
      record = await deps.fetchRecord(nodeId);
    } catch {
      // No answer (offline, HTTP 429 or 5xx): the next check asks again.
      return;
    }
    if (record) {
      lastPhase = record.phase || lastPhase;
      if (
        record.phase === 'active' &&
        record.owner?.toLowerCase() === signer.toLowerCase()
      ) {
        deps.rememberBondChoice(
          signer,
          nodeId,
          record.bond_mode === 'mining_rewards' ? 'mining_rewards' : 'upfront'
        );
      }
      return;
    }
    // An unenrolled or slashed enrollment passes through pending_unbond or
    // revoked before it disappears. It ended on purpose: never enroll again.
    if (lastPhase !== 'active') return;
    await handleRemoved(signer, nodeId);
  };

  return {
    check: async () => {
      if (busy || handled) return;
      busy = true;
      try {
        await checkOnce();
      } finally {
        busy = false;
      }
    },
  };
};

type QsdmMinerTaskControls = Pick<
  QsdmMinerEnrollmentWatchDeps,
  'restart' | 'stop'
>;

// Set by the startTask controller, which owns starting and stopping tasks.
let minerTaskControls: QsdmMinerTaskControls | undefined;

export const setQsdmMinerTaskControls = (controls: QsdmMinerTaskControls) => {
  minerTaskControls = controls;
};

const notifyMinerTask = (taskId: string, level: LogLevel, message: string) => {
  writeQsdmSystemTaskLog(taskId, message);
  sendEventAllWindows(RendererEndpoints.TASK_NOTIFICATION_RECEIVED, {
    level,
    message,
    action: null,
    taskId,
    taskName: isQsdmPoolMinerSystemTaskId(taskId)
      ? 'QSDM Pool Miner'
      : 'QSDM Miner',
  });
};

const defaultDeps = (): QsdmMinerEnrollmentWatchDeps => ({
  getNodeId: getQsdmMinerConfiguredNodeId,
  getSigner: getQsdmTaskActionSender,
  fetchRecord: fetchQsdmMinerEnrollmentRecord,
  readBondChoice: readQsdmMinerBondChoice,
  rememberBondChoice: rememberQsdmMinerBondChoice,
  enroll: enrollQsdmMiner,
  restart: async (taskId) => {
    if (!minerTaskControls) throw new Error('Hive cannot restart tasks yet.');
    await minerTaskControls.restart(taskId);
  },
  stop: async (taskId) => {
    await minerTaskControls?.stop(taskId);
  },
  notify: notifyMinerTask,
});

const stopWatches = new Map<string, () => void>();

export const stopQsdmMinerEnrollmentWatch = (taskId: string) => {
  stopWatches.get(taskId)?.();
};

// Checks every QSDM_MINER_ENROLLMENT_CHECK_MS while `child` is this task's
// miner; ends when the child exits or another child replaces it.
export const startQsdmMinerEnrollmentWatch = (
  taskId: string,
  child: ChildProcess,
  isCurrent: () => boolean,
  deps: QsdmMinerEnrollmentWatchDeps = defaultDeps()
) => {
  stopQsdmMinerEnrollmentWatch(taskId);
  const watch = createQsdmMinerEnrollmentWatch(taskId, deps);
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
    child.removeListener('exit', stop);
    if (stopWatches.get(taskId) === stop) stopWatches.delete(taskId);
  };
  timer = setInterval(() => {
    if (!isCurrent()) {
      stop();
      return;
    }
    watch.check().catch((error) => {
      writeQsdmSystemTaskLog(
        taskId,
        `Enrollment check failed: ${describeQsdmWatchError(error)}`
      );
    });
  }, QSDM_MINER_ENROLLMENT_CHECK_MS);
  stopWatches.set(taskId, stop);
  child.once('exit', stop);
  return stop;
};
