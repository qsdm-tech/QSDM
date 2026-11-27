import { Event } from 'electron';

import { isQsdmMinerSystemTaskId } from 'config/qsdmSystemTasks';
import qsdmHiveTasks from 'main/services/qsdmHiveTasks';
import {
  isQsdmNoNvidiaGpuPc,
  QSDM_NO_NVIDIA_GPU_MESSAGE,
} from 'main/services/qsdmMinerEnrollment';
import { ErrorType } from 'models';
import { throwDetailedError } from 'utils';

import { getRunnedPrivateTasks } from './privateTasks';
import startTask from './startTask';
import { getSchedulerTasks } from './tasksScheduler/getSchedulerTasks';

type StartAllTasksParams = {
  runOnlyScheduledTasks?: boolean;
};

export const startAllTasks = async (
  _: Event,
  { runOnlyScheduledTasks }: StartAllTasksParams = {}
) => {
  try {
    const startedTasks = await qsdmHiveTasks.getStartedTasks();
    const schedulerTasks = await getSchedulerTasks({} as Event);
    // Asked once, only when a miner task would start: a PC without an NVIDIA
    // GPU leaves both miner tasks stopped instead of failing on every launch.
    let noNvidiaGpu: Promise<boolean> | undefined;

    for (const rawTaskData of startedTasks) {
      if (!rawTaskData.is_running) {
        const privateTasks = await getRunnedPrivateTasks();
        const isPrivate = privateTasks.includes(rawTaskData.task_id);

        /**
         * @dev if actions is triggered by tasks scheduler, we should start only scheduled tasks
         */
        if (
          runOnlyScheduledTasks &&
          !schedulerTasks.includes(rawTaskData.task_id)
        ) {
          console.warn(`Task ${rawTaskData.task_id} isn't scheduled, skip it.`);
          // eslint-disable-next-line no-continue
          continue;
        }
        if (isQsdmMinerSystemTaskId(rawTaskData.task_id)) {
          noNvidiaGpu = noNvidiaGpu || isQsdmNoNvidiaGpuPc();
          if (await noNvidiaGpu) {
            console.warn(
              `${QSDM_NO_NVIDIA_GPU_MESSAGE} Not starting ${rawTaskData.task_id}.`
            );
            // eslint-disable-next-line no-continue
            continue;
          }
        }
        try {
          await startTask({} as Event, {
            taskAccountPubKey: rawTaskData.task_id,
            isPrivate,
          });
        } catch (e) {
          console.error(e);
        }
      }
    }
  } catch (e: any) {
    if (e?.message !== 'Tasks not fetched yet') console.error(e);
    return throwDetailedError({
      detailed: e,
      type: ErrorType.GENERIC,
    });
  }
};
