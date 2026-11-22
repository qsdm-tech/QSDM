/**
 * @jest-environment node
 */
import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

import {
  QSDM_EDGE_WORKER_SYSTEM_TASK_ID,
  QSDM_MINER_SYSTEM_TASK_ID,
  QSDM_MOTHER_HIVE_SYSTEM_TASK_ID,
  QSDM_POOL_MINER_SYSTEM_TASK_ID,
  QSDM_SKYFANG_LINK_SYSTEM_TASK_ID,
  qsdmTaskSendsSignedStopAction,
} from 'config/qsdmSystemTasks';

import { QsdmHiveTaskService } from './QsdmHiveTaskService';
import { submitQsdmTaskActionIntent } from './qsdmTaskActions';

jest.mock('./qsdmTaskActions', () => ({
  submitQsdmTaskActionIntent: jest.fn(async () => ({})),
}));

jest.mock('./sdk', () => ({ __esModule: true, default: {} }));

jest.mock('./qsdmMinerEnrollmentWatch', () => ({
  startQsdmMinerEnrollmentWatch: jest.fn(),
}));

jest.mock('../node/helpers/Namespace', () => {
  let running = '[]';
  return {
    Namespace: jest.fn(),
    namespaceInstance: {
      storeGet: jest.fn(async () => running),
      storeSet: jest.fn(async (_key: string, value: string) => {
        running = value;
      }),
    },
  };
});

const fakeChild = () =>
  Object.assign(new EventEmitter(), {
    pid: 4242,
    kill: jest.fn(() => true),
  }) as unknown as ChildProcess;

const run = async (service: QsdmHiveTaskService, taskId: string) => {
  const child = fakeChild();
  service.RUNNING_TASKS[taskId] = {
    child,
    namespace: {} as never,
    expressAppPort: 0,
    secret: 'test-only',
  };
  await service.addRunningTaskPubKey(taskId);
  return child;
};

describe('signed stop actions', () => {
  beforeEach(() => {
    (submitQsdmTaskActionIntent as jest.Mock).mockClear();
  });

  it('are kept for every task but the two miner tasks', () => {
    expect(qsdmTaskSendsSignedStopAction(QSDM_MINER_SYSTEM_TASK_ID)).toBe(
      false
    );
    expect(qsdmTaskSendsSignedStopAction(QSDM_POOL_MINER_SYSTEM_TASK_ID)).toBe(
      false
    );
    [
      QSDM_EDGE_WORKER_SYSTEM_TASK_ID,
      QSDM_MOTHER_HIVE_SYSTEM_TASK_ID,
      QSDM_SKYFANG_LINK_SYSTEM_TASK_ID,
      'some-community-task',
    ].forEach((taskId) =>
      expect(qsdmTaskSendsSignedStopAction(taskId)).toBe(true)
    );
  });

  it.each([QSDM_MINER_SYSTEM_TASK_ID, QSDM_POOL_MINER_SYSTEM_TASK_ID])(
    'stopping %s sends no signed stop action',
    async (taskId) => {
      const service = new QsdmHiveTaskService();
      const child = await run(service, taskId);

      await service.stopTask(taskId);

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(service.RUNNING_TASKS[taskId]).toBeUndefined();
      expect(submitQsdmTaskActionIntent).not.toHaveBeenCalled();
    }
  );

  it('a miner that exits by itself sends no signed stop action', async () => {
    const service = new QsdmHiveTaskService();
    const child = await run(service, QSDM_MINER_SYSTEM_TASK_ID);

    await service.handleQsdmNativeTaskProcessExit(
      QSDM_MINER_SYSTEM_TASK_ID,
      'qsdm-system-process-exit',
      undefined,
      child
    );

    expect(submitQsdmTaskActionIntent).not.toHaveBeenCalled();
  });

  it('stopping another system task still sends its signed stop action', async () => {
    const service = new QsdmHiveTaskService();
    await run(service, QSDM_MOTHER_HIVE_SYSTEM_TASK_ID);

    await service.stopTask(QSDM_MOTHER_HIVE_SYSTEM_TASK_ID);

    expect(submitQsdmTaskActionIntent).toHaveBeenCalledWith({
      taskId: QSDM_MOTHER_HIVE_SYSTEM_TASK_ID,
      action: 'stop',
      payload: { reason: 'local-task-stop' },
    });
  });
});
