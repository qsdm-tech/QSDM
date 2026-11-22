/**
 * @jest-environment node
 */
import axios, {
  AxiosError,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';

import {
  getQsdmRetryAfterMs,
  installQsdmRateLimitRetry,
  planQsdmRateLimitWait,
  QSDM_RATE_LIMIT_WAIT_BUDGET_MS,
} from './qsdmHttpRetry';

const API = 'https://api.example.test/api/v1';

const rateLimited = (retryAfter?: string) =>
  Object.assign(new Error('Request failed with status code 429'), {
    isAxiosError: true,
    response: {
      status: 429,
      headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
    },
  });

type Answer = { status: number; retryAfter?: string; data?: unknown };

type Seen = Array<{ method?: string; url?: string; data?: unknown }>;

// An axios "server" that answers from a script.
const scriptedAdapter =
  (answers: Answer[], seen: Seen) =>
  async (config: InternalAxiosRequestConfig) => {
    seen.push({ method: config.method, url: config.url, data: config.data });
    const answer = answers.shift() || { status: 200, data: 'ok' };
    const response = {
      data: answer.data ?? null,
      status: answer.status,
      statusText: String(answer.status),
      headers:
        answer.retryAfter === undefined
          ? {}
          : { 'retry-after': answer.retryAfter },
      config,
    } as AxiosResponse;
    if (answer.status >= 400) {
      throw new AxiosError(
        `Request failed with status code ${answer.status}`,
        AxiosError.ERR_BAD_REQUEST,
        config,
        null,
        response
      );
    }
    return response;
  };

const flush = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

// A scripted instance and a clock that only moves when the retry sleeps.
const setup = (answers: Answer[]) => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const seen: Seen = [];
  const instance = axios.create({ adapter: scriptedAdapter(answers, seen) });
  installQsdmRateLimitRetry(instance, {
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0,
    now: () => clock,
  });
  return { instance, sleeps, seen };
};

describe('shared HTTP 429 retry', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads Retry-After seconds and HTTP dates of 429 and 503 answers only', () => {
    const now = new Date('2026-11-22T00:00:00.000Z');
    expect(getQsdmRetryAfterMs(rateLimited('60'), now)).toBe(60_000);
    expect(
      getQsdmRetryAfterMs(rateLimited('Sun, 22 Nov 2026 00:00:30 GMT'), now)
    ).toBe(30_000);
    expect(getQsdmRetryAfterMs(rateLimited('soon'), now)).toBeUndefined();
    expect(getQsdmRetryAfterMs(rateLimited(), now)).toBeUndefined();
    expect(
      getQsdmRetryAfterMs(
        { ...rateLimited('60'), response: { status: 500, headers: {} } },
        now
      )
    ).toBeUndefined();
  });

  it('waits at least the doubling wait and the Retry-After, within one window', () => {
    expect(planQsdmRateLimitWait({ retries: 0, waitedMs: 0 })).toBe(1_000);
    expect(planQsdmRateLimitWait({ retries: 3, waitedMs: 7_000 })).toBe(8_000);
    expect(
      planQsdmRateLimitWait({ retries: 0, waitedMs: 0, retryAfterMs: 60_000 })
    ).toBe(60_000);
    // Retry-After 0 still backs off.
    expect(
      planQsdmRateLimitWait({ retries: 2, waitedMs: 3_000, retryAfterMs: 0 })
    ).toBe(4_000);
    expect(
      planQsdmRateLimitWait({ retries: 0, waitedMs: 0, retryAfterMs: 61_000 })
    ).toBeUndefined();
    expect(
      planQsdmRateLimitWait({ retries: 0, waitedMs: 0, retryAfterMs: Infinity })
    ).toBeUndefined();
    expect(
      planQsdmRateLimitWait({ retries: 5, waitedMs: 31_000 })
    ).toBeUndefined();
  });

  it('honors Retry-After and sends the same POST again', async () => {
    const { instance, sleeps, seen } = setup([
      { status: 429, retryAfter: '60' },
      { status: 200, data: { status: 'accepted' } },
    ]);
    const body = { id: 'hive_wallet_1', nonce: 7, signature: 'sig' };

    const response = await instance.post(`${API}/wallet/submit-signed`, body);

    expect(response.data).toEqual({ status: 'accepted' });
    expect(sleeps).toEqual([60_000]);
    expect(seen).toHaveLength(2);
    expect(seen[1].data).toBe(seen[0].data);
    expect(JSON.parse(String(seen[1].data))).toEqual(body);
  });

  it('backs off 1, 2, 4, 8, 16 s without Retry-After and then gives up', async () => {
    const { instance, sleeps } = setup(
      Array.from({ length: 10 }, () => ({ status: 429 }))
    );

    await expect(instance.get(`${API}/status`)).rejects.toMatchObject({
      response: { status: 429 },
    });
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
      QSDM_RATE_LIMIT_WAIT_BUDGET_MS
    );
  });

  it('does not wait for a Retry-After beyond the budget', async () => {
    const { instance, sleeps, seen } = setup([
      { status: 429, retryAfter: '3600' },
    ]);

    await expect(instance.get(`${API}/status`)).rejects.toMatchObject({
      response: { status: 429 },
    });
    expect(sleeps).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('holds other requests to the same API until the pause ends', async () => {
    let clock = 1_000_000;
    const seen: Seen = [];
    const waits: Array<{ ms: number; done: () => void }> = [];
    const instance = axios.create({
      adapter: scriptedAdapter(
        [
          { status: 429, retryAfter: '30' },
          { status: 200, data: 'ok' },
          { status: 200, data: 'ok' },
        ],
        seen
      ),
    });
    installQsdmRateLimitRetry(instance, {
      sleep: (ms) =>
        new Promise((resolve) => {
          waits.push({
            ms,
            done: () => {
              clock += ms;
              resolve();
            },
          });
        }),
      random: () => 0,
      now: () => clock,
    });

    const first = instance.get(`${API}/status`);
    await flush();
    expect(waits.map((wait) => wait.ms)).toEqual([30_000]);
    // Sent while the API asked Hive to wait: held, not sent.
    const second = instance.get(`${API}/wallet/nonce`);
    await flush();
    expect(waits.map((wait) => wait.ms)).toEqual([30_000, 30_000]);
    expect(seen.map((request) => request.url)).toEqual([`${API}/status`]);

    waits.forEach((wait) => wait.done());
    await expect(first).resolves.toMatchObject({ data: 'ok' });
    await expect(second).resolves.toMatchObject({ data: 'ok' });
    expect(seen.map((request) => request.url).sort()).toEqual([
      `${API}/status`,
      `${API}/status`,
      `${API}/wallet/nonce`,
    ]);
  });

  it('does not hold requests for a pause beyond their budget', async () => {
    const { instance, sleeps } = setup([
      { status: 429, retryAfter: '3600' },
      { status: 200, data: 'answered' },
    ]);
    await expect(instance.get(`${API}/status`)).rejects.toBeDefined();

    // An hour's pause does not fit in one window: the request goes at once.
    await expect(instance.get(`${API}/tasks`)).resolves.toMatchObject({
      data: 'answered',
    });
    expect(sleeps).toEqual([]);
  });

  it('leaves other errors alone', async () => {
    const { instance, sleeps } = setup([{ status: 503, retryAfter: '1' }]);

    await expect(instance.get(`${API}/status`)).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(sleeps).toEqual([]);
  });
});
