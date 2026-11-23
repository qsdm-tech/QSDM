/**
 * @jest-environment node
 */

import { promises as fsPromises } from 'fs';

import axios from 'axios';

import {
  MAX_TASK_THUMBNAIL_BYTES,
  saveTaskThumbnail,
  sanitizeUrl,
} from './saveTaskThumbnail';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(),
    writeFile: jest.fn(),
  },
}));

jest.mock('main/node/helpers/getAppDataPath', () => ({
  getAppDataPath: () => '/hive-data',
}));

const mockedAxiosGet = axios.get as jest.Mock;
const ICON_URL = 'https://tasks.example.com/icon.png';

describe('saveTaskThumbnail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxiosGet.mockResolvedValue({ data: Buffer.from('png bytes') });
  });

  it('downloads with certificate checks on, a timeout and a size cap', async () => {
    await saveTaskThumbnail({} as Event, { url: ICON_URL });

    expect(mockedAxiosGet).toHaveBeenCalledTimes(1);
    const [url, config] = mockedAxiosGet.mock.calls[0];
    expect(url).toBe(ICON_URL);
    expect(config).toEqual(
      expect.objectContaining({
        responseType: 'arraybuffer',
        timeout: 15000,
        maxContentLength: MAX_TASK_THUMBNAIL_BYTES,
        maxRedirects: 3,
      })
    );
    expect(MAX_TASK_THUMBNAIL_BYTES).toBe(5 * 1024 * 1024);
    // no custom agent, so Node's certificate verification applies
    expect(config.httpsAgent).toBeUndefined();
    expect(fsPromises.writeFile).toHaveBeenCalledWith(
      `/hive-data/thumbnails/${sanitizeUrl(ICON_URL)}`,
      Buffer.from('png bytes')
    );
  });

  it('refuses a redirect that leaves HTTPS', async () => {
    await saveTaskThumbnail({} as Event, { url: ICON_URL });

    const { beforeRedirect } = mockedAxiosGet.mock.calls[0][1];
    expect(() => beforeRedirect({ protocol: 'http:' }, {})).toThrow(
      'Task thumbnails are fetched over HTTPS only.'
    );
    expect(() => beforeRedirect({ protocol: 'https:' }, {})).not.toThrow();
  });

  it.each([
    'http://tasks.example.com/icon.png',
    'file:///etc/passwd',
    'ftp://tasks.example.com/icon.png',
    '',
    undefined,
  ])('downloads nothing for %p', async (url) => {
    await saveTaskThumbnail({} as Event, { url: url as string });

    expect(mockedAxiosGet).not.toHaveBeenCalled();
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('writes nothing when the download fails (for example over the size cap)', async () => {
    mockedAxiosGet.mockRejectedValue(
      new Error('maxContentLength size of 5242880 exceeded')
    );

    await expect(
      saveTaskThumbnail({} as Event, { url: ICON_URL })
    ).rejects.toThrow('maxContentLength');
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });
});
