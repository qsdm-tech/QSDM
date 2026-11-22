import { Event } from 'electron';

import {
  QSDM_MINER_SYSTEM_TASK_ID,
  QSDM_POOL_MINER_SYSTEM_TASK_ID,
} from 'config/qsdmSystemTasks';
import qsdmHiveTasks from 'main/services/qsdmHiveTasks';
import { isQsdmNoNvidiaGpuPc } from 'main/services/qsdmMinerEnrollment';

import { getRunnedPrivateTasks } from './privateTasks';
import startTask from './startTask';
import { startAllTasks } from './startAllTasks';
import { getSchedulerTasks } from './tasksScheduler/getSchedulerTasks';

jest.mock('main/services/qsdmHiveTasks', () => ({
  __esModule: true,
  default: {
    getStartedTasks: jest.fn(),
  },
}));

jest.mock('./privateTasks', () => ({
  getRunnedPrivateTasks: jest.fn(),
}));

jest.mock('./startTask', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('./tasksScheduler/getSchedulerTasks', () => ({
  getSchedulerTasks: jest.fn(),
}));

jest.mock('main/services/qsdmMinerEnrollment', () => ({
  isQsdmNoNvidiaGpuPc: jest.fn(),
  QSDM_NO_NVIDIA_GPU_MESSAGE:
    'This PC has no NVIDIA GPU. QSDM mining needs one.',
}));

describe('startAllTasks scheduled mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getRunnedPrivateTasks as jest.Mock).mockResolvedValue([]);
    (isQsdmNoNvidiaGpuPc as jest.Mock).mockResolvedValue(false);
  });

  it('leaves both miner tasks stopped on a PC without an NVIDIA GPU', async () => {
    (qsdmHiveTasks.getStartedTasks as jest.Mock).mockResolvedValue([
      { task_id: QSDM_MINER_SYSTEM_TASK_ID, is_running: false },
      { task_id: QSDM_POOL_MINER_SYSTEM_TASK_ID, is_running: false },
      { task_id: 'other-task', is_running: false },
    ]);
    (getSchedulerTasks as jest.Mock).mockResolvedValue([]);
    (isQsdmNoNvidiaGpuPc as jest.Mock).mockResolvedValue(true);
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    await startAllTasks({} as Event);

    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith({} as Event, {
      taskAccountPubKey: 'other-task',
      isPrivate: false,
    });
    expect(isQsdmNoNvidiaGpuPc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `This PC has no NVIDIA GPU. QSDM mining needs one. Not starting ${QSDM_MINER_SYSTEM_TASK_ID}.`
    );
    warn.mockRestore();
  });

  it('starts the miner task on a PC with an NVIDIA GPU', async () => {
    (qsdmHiveTasks.getStartedTasks as jest.Mock).mockResolvedValue([
      { task_id: QSDM_MINER_SYSTEM_TASK_ID, is_running: false },
    ]);
    (getSchedulerTasks as jest.Mock).mockResolvedValue([]);

    await startAllTasks({} as Event);

    expect(startTask).toHaveBeenCalledWith({} as Event, {
      taskAccountPubKey: QSDM_MINER_SYSTEM_TASK_ID,
      isPrivate: false,
    });
  });

  it('skips unscheduled tasks without blocking later scheduled tasks', async () => {
    (qsdmHiveTasks.getStartedTasks as jest.Mock).mockResolvedValue([
      { task_id: 'unscheduled-task', is_running: false },
      { task_id: 'scheduled-task', is_running: false },
    ]);
    (getSchedulerTasks as jest.Mock).mockResolvedValue(['scheduled-task']);

    await startAllTasks({} as Event, { runOnlyScheduledTasks: true });

    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask).toHaveBeenCalledWith({} as Event, {
      taskAccountPubKey: 'scheduled-task',
      isPrivate: false,
    });
  });
});
