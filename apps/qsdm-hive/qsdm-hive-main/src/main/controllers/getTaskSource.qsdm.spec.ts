/**
 * @jest-environment node
 */
// cspell:ignore bafybeiabhpqrknrzz otptaw lubz kruk

import axios from 'axios';

import { fetchFromIPFSOrArweave } from './fetchFromIPFSOrArweave';

const mockRuntime = { mode: 'qsdm-native' };

jest.mock('axios', () => ({
  get: jest.fn(),
}));

jest.mock('config/qsdm', () => ({
  get QSDM_TASK_RUNTIME_MODE() {
    return mockRuntime.mode;
  },
  buildQsdmTaskReadUrls: (path: string) => [
    `http://localhost:8080/api/v1/${path.replace(/^\/+/, '')}`,
  ],
}));

jest.mock('./fetchFromIPFSOrArweave', () => ({
  __esModule: true,
  fetchFromIPFSOrArweave: jest.fn(),
}));

const mockedAxiosGet = axios.get as jest.Mock;

describe('getTaskSource qsdm-native', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRuntime.mode = 'qsdm-native';
    (fetchFromIPFSOrArweave as jest.Mock).mockResolvedValue(
      'require("child_process").exec("downloaded code")'
    );
  });

  it('generates a native task runner for a task registered in QSDM Core', async () => {
    mockedAxiosGet.mockResolvedValue({
      data: {
        tasks: [
          {
            task_id: 'qsdm-hive-local-task',
            task_audit_program: 'qsdm-hive-local-task-source',
          },
        ],
      },
    });

    const { getTaskSource } = await import('./getTaskSource');
    const result = await getTaskSource({} as Event, {
      taskAuditProgram: 'qsdm-hive-local-task-source',
    });

    expect(mockedAxiosGet).toHaveBeenCalledWith(
      'http://localhost:8080/api/v1/tasks',
      { timeout: 4000 }
    );
    expect(fetchFromIPFSOrArweave).not.toHaveBeenCalled();
    expect(result).toContain("const http = require('http');");
    expect(result).toContain('qsdm-hive-local-task');
    expect(result).toContain('/namespace-wrapper');
    expect(result).toContain('checkSubmissionAndUpdateRound');
  });

  it('refuses a task the catalog does not list and downloads nothing', async () => {
    mockedAxiosGet.mockResolvedValue({
      data: {
        tasks: [
          {
            task_id: 'qsdm-hive-local-task',
            task_audit_program: 'qsdm-hive-local-task-source',
          },
        ],
      },
    });

    const { getTaskSource } = await import('./getTaskSource');
    await expect(
      getTaskSource({} as Event, {
        taskAuditProgram:
          'bafybeiabhpqrknrzz5fka2otptaw7lubz7awh5f7n2kruk52akq4jr5dh4',
      })
    ).rejects.toThrow('This task is not in the QSDM catalog.');
    expect(fetchFromIPFSOrArweave).not.toHaveBeenCalled();
  });

  it('never downloads task code outside the qsdm-native runtime', async () => {
    mockRuntime.mode = 'k2-compat';

    const { getTaskSource } = await import('./getTaskSource');
    await expect(
      getTaskSource({} as Event, {
        taskAuditProgram:
          'bafybeiabhpqrknrzz5fka2otptaw7lubz7awh5f7n2kruk52akq4jr5dh4',
      })
    ).rejects.toThrow('it does not download task code');
    expect(mockedAxiosGet).not.toHaveBeenCalled();
    expect(fetchFromIPFSOrArweave).not.toHaveBeenCalled();
  });

  // Last: the failed reads open the read circuit for this URL.
  it('stops when the catalog read fails and downloads nothing', async () => {
    mockedAxiosGet.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const { getTaskSource } = await import('./getTaskSource');
    await expect(
      getTaskSource({} as Event, {
        taskAuditProgram:
          'bafybeiabhpqrknrzz5fka2otptaw7lubz7awh5f7n2kruk52akq4jr5dh4',
      })
    ).rejects.toThrow('The QSDM task catalog is unavailable; try again.');
    expect(fetchFromIPFSOrArweave).not.toHaveBeenCalled();
  });
});
