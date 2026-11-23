import { promises as fsPromises } from 'fs';

import axios from 'axios';
import { getAppDataPath } from 'main/node/helpers/getAppDataPath';

const { writeFile, mkdir } = fsPromises;

const THUMBNAILS_CACHE_DIR = `${getAppDataPath()}/thumbnails`;

// A task icon is a small image, and its URL comes from the task catalog, where
// anyone can register a task. The cap keeps a broken or hostile icon host from
// streaming an endless body into Hive's main process.
export const MAX_TASK_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const TASK_THUMBNAIL_TIMEOUT_MS = 15_000;

export const sanitizeUrl = (url: string): string => {
  return url.replace(/[^a-z0-9]/gi, '_').toLowerCase();
};

const isHttpsUrl = (url: unknown): url is string =>
  typeof url === 'string' && url.startsWith('https://');

export const saveTaskThumbnail = async (
  _: Event,
  { url }: { url: string }
): Promise<void> => {
  // Thumbnails are fetched only over HTTPS, with certificate checks on.
  if (!isHttpsUrl(url)) {
    return;
  }
  const sanitizedUrl = sanitizeUrl(url);
  const cacheFilePath = `${THUMBNAILS_CACHE_DIR}/${sanitizedUrl}`;

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: TASK_THUMBNAIL_TIMEOUT_MS,
    maxContentLength: MAX_TASK_THUMBNAIL_BYTES,
    maxRedirects: 3,
    beforeRedirect: (options: Record<string, any>) => {
      if (options.protocol !== 'https:') {
        throw new Error('Task thumbnails are fetched over HTTPS only.');
      }
    },
  });
  const buffer = Buffer.from(response.data, 'binary');

  try {
    await mkdir(THUMBNAILS_CACHE_DIR, { recursive: true });
    await writeFile(cacheFilePath, buffer);
  } catch (error) {
    console.error('Error saving image', error);
  }
};
