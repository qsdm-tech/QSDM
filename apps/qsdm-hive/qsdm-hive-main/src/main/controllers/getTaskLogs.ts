import { Event } from 'electron';
import path from 'path';

import * as readLastLines from 'read-last-lines';

import { ErrorType } from 'models';
import { GetTaskLogsParam, GetTaskLogsResponse } from 'models/api';
import { throwDetailedError } from 'utils';

import { getTaskNamespacePath } from '../node/helpers/taskPaths';

const getTaskLogs = async (
  event: Event,
  payload: GetTaskLogsParam
): Promise<GetTaskLogsResponse> => {
  const { taskAccountPubKey, noOfLines } = payload;

  try {
    const contents = await readLastLines.read(
      path.join(getTaskNamespacePath(taskAccountPubKey), 'task.log'),
      noOfLines
    );
    return contents;
  } catch (e: any) {
    console.error(e);
    return throwDetailedError({
      detailed: e,
      type: ErrorType.NO_TASK_SOURCECODE,
    });
  }
};

export default getTaskLogs;
