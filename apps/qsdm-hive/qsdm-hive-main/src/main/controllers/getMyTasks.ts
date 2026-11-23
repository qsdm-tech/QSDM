import { Event } from 'electron';
import * as fsSync from 'fs';
import path from 'path';

import { isQsdmHiveInternalTaskId } from 'config/qsdmSystemTasks';
import {
  getTaskNamespacePath,
  isSafeTaskId,
} from 'main/node/helpers/taskPaths';
import qsdmHiveTasks from 'main/services/qsdmHiveTasks';
import { ErrorType, PaginatedResponse, Task } from 'models';
import { GetMyTasksParam } from 'models/api';
import { throwDetailedError, checkErrorInLastLogTimestamp } from 'utils';

import { parseRawK2TaskData } from '../node/helpers/parseRawK2TaskData';

const getMyTasks = async (
  event: Event,
  payload: GetMyTasksParam
): Promise<PaginatedResponse<Task>> => {
  try {
    console.log('GETTING MY TASKS');
    const { offset, limit } = payload;
    ///
    const startedTasks = (await qsdmHiveTasks.getStartedTasks()).filter(
      (task) => !isQsdmHiveInternalTaskId(task.task_id)
    );

    const slicedTasks = startedTasks
      .slice(offset, offset + limit)
      .map((rawTaskData) => {
        // A task id that is not a plain name has no log folder.
        const taskLogPath = isSafeTaskId(rawTaskData.task_id)
          ? path.join(getTaskNamespacePath(rawTaskData.task_id), 'task.log')
          : '';

        const taskLogs =
          taskLogPath && fsSync.existsSync(taskLogPath)
            ? fsSync.readFileSync(taskLogPath, 'utf-8')
            : '';
        const hasError = checkErrorInLastLogTimestamp(taskLogs);

        return {
          publicKey: rawTaskData.task_id,
          data: parseRawK2TaskData({ rawTaskData, isRunning: true, hasError }),
        };
      });

    const response: PaginatedResponse<Task> = {
      content: slicedTasks,
      hasNext: slicedTasks.length === limit,
      itemsCount: startedTasks.length,
    };
    return response;
  } catch (e: any) {
    return throwDetailedError({
      detailed: e,
      type: ErrorType.GENERIC,
    });
  }
};

export default getMyTasks;
