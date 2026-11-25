import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';

// One shared retry for HTTP 429 around the API calls Hive's main process
// makes with axios (installQsdmRateLimitRetry runs once at startup).
//
// The public QSDM API allows about 100 requests a minute per IP, and the
// computers behind one home IP share it. Its two rate limiters
// (QSDM/source/pkg/api/security.go RateLimiter and ratelimit_roles.go
// RoleRateLimiter) are middleware: they answer 429 with Retry-After and
// return before the handler runs. A request answered 429 was never
// processed, so sending it again is safe, a signed transfer included. A
// signed transfer is also guarded by its wallet nonce: SubmitSignedTransaction
// (pkg/api/handlers.go) answers 409 "nonce replay" for a nonce at or below
// the last applied one, and the mempool answers 409 "duplicate" for a nonce
// already pending, so sending it twice can never spend twice.
//
// When one request is answered 429, every request to that API waits for the
// same Retry-After instead of spending more of the shared budget, and the
// waiting requests go out spread over QSDM_RATE_LIMIT_SPREAD_MS.

// The limiter counts requests in fixed one-minute windows, and its
// Retry-After is that window (60 s). After one full window the budget is
// certainly refilled, so one window bounds each request's total wait:
// waiting longer only meets the next window's traffic. A Retry-After that
// does not fit in what is left (a maintenance answer, say) ends the retries
// at once and the caller gets the 429.
export const QSDM_RATE_LIMIT_WAIT_BUDGET_MS = 60_000;

// Without Retry-After, the waits double from one second (1, 2, 4, 8, 16 s),
// which the budget ends after five retries. The same second spreads the
// requests that a pause released, so they do not return as one burst.
export const QSDM_RATE_LIMIT_SPREAD_MS = 1_000;

type QsdmRateLimitState = { retries: number; waitedMs: number };

type QsdmRateLimitConfig = AxiosRequestConfig & {
  qsdmRateLimit?: QsdmRateLimitState;
};

const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fullWeekdays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// Retry-After of an HTTP 429 or 503 answer in milliseconds, or undefined.
// Accepts delta-seconds and the three HTTP-date forms (RFC 9110), without
// Date.parse's permissive numeric parsing or local-time interpretation of the
// obsolete asctime form. A syntactically valid, enormous wait is returned as
// is (Infinity included) so that callers stop instead of waiting.
export const getQsdmRetryAfterMs = (
  error: unknown,
  now = new Date()
): number | undefined => {
  if (
    !axios.isAxiosError(error) ||
    ![429, 503].includes(error.response?.status || 0)
  ) {
    return undefined;
  }
  const headers = error.response?.headers as
    | Record<string, unknown>
    | undefined;
  const key =
    headers &&
    Object.keys(headers).find((name) => name.toLowerCase() === 'retry-after');
  const raw = key ? headers?.[key] : undefined;
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const standard =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value
    );
  const obsolete =
    /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
      value
    );
  const asctime =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
      value
    );
  const fields =
    standard ||
    obsolete ||
    (asctime && [
      asctime[0],
      asctime[1],
      asctime[3],
      asctime[2],
      asctime[7],
      asctime[4],
      asctime[5],
      asctime[6],
    ]);
  if (!fields) return undefined;
  const month = months.indexOf(fields[3]);
  const day = Number(fields[2]);
  const hour = Number(fields[5]);
  const minute = Number(fields[6]);
  const second = Number(fields[7]);
  if (
    month < 0 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  )
    return undefined;
  let year = Number(fields[4]);
  if (obsolete) year += Math.floor(now.getUTCFullYear() / 100) * 100;
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  // Validate the stated calendar day before carrying a permitted leap second
  // into the following minute or day.
  const leapSecondMs = second === 60 ? 1000 : 0;
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  if (obsolete) {
    const futureLimit = new Date(now);
    futureLimit.setUTCFullYear(now.getUTCFullYear() + 50);
    if (date.getTime() + leapSecondMs > futureLimit.getTime()) {
      year -= 100;
      date.setUTCFullYear(year);
    }
  }
  const weekday = (obsolete ? fullWeekdays : weekdays).indexOf(fields[1]);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCDay() !== weekday
  )
    return undefined;
  return Math.max(0, date.getTime() + leapSecondMs - now.getTime());
};

export const isQsdmRateLimited = (error: unknown) =>
  axios.isAxiosError(error) && error.response?.status === 429;

// How long to wait before retry number `retries + 1`, or undefined when the
// wait does not fit in the budget. At least the doubling backoff, at least
// the server's Retry-After.
export const planQsdmRateLimitWait = ({
  retries,
  waitedMs,
  retryAfterMs,
}: {
  retries: number;
  waitedMs: number;
  retryAfterMs?: number;
}): number | undefined => {
  const backoffMs = QSDM_RATE_LIMIT_SPREAD_MS * 2 ** retries;
  const waitMs = Math.max(backoffMs, retryAfterMs ?? 0);
  return Number.isFinite(waitMs) &&
    waitMs <= QSDM_RATE_LIMIT_WAIT_BUDGET_MS - waitedMs
    ? waitMs
    : undefined;
};

const originOf = (config: AxiosRequestConfig) => {
  try {
    return new URL(config.url || '', config.baseURL || undefined).origin;
  } catch {
    return '';
  }
};

type InstallOptions = {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

const installed = new WeakSet<AxiosInstance>();

export const installQsdmRateLimitRetry = (
  instance: AxiosInstance = axios,
  {
    sleep = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    random = Math.random,
    now = Date.now,
  }: InstallOptions = {}
) => {
  if (installed.has(instance)) return;
  installed.add(instance);
  // The time until which each API origin asked Hive to wait.
  const pausedUntil = new Map<string, number>();

  instance.interceptors.request.use(async (config) => {
    const state = (config as QsdmRateLimitConfig).qsdmRateLimit;
    const until = pausedUntil.get(originOf(config)) || 0;
    const pauseMs = until - now();
    const remainingMs = QSDM_RATE_LIMIT_WAIT_BUDGET_MS - (state?.waitedMs || 0);
    // A pause longer than this request's budget (a maintenance answer, say)
    // is not waited for: the request goes now and the answer decides.
    if (pauseMs <= 0 || pauseMs > remainingMs) return config;
    const waitMs = Math.min(
      pauseMs + random() * QSDM_RATE_LIMIT_SPREAD_MS,
      remainingMs
    );
    await sleep(waitMs);
    (config as QsdmRateLimitConfig).qsdmRateLimit = {
      retries: state?.retries || 0,
      waitedMs: (state?.waitedMs || 0) + waitMs,
    };
    return config;
  });

  instance.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error?.config as QsdmRateLimitConfig | undefined;
    if (!config || !isQsdmRateLimited(error)) throw error;
    const state = config.qsdmRateLimit || { retries: 0, waitedMs: 0 };
    const retryAfterMs = getQsdmRetryAfterMs(error);
    const waitMs = planQsdmRateLimitWait({
      retries: state.retries,
      waitedMs: state.waitedMs,
      retryAfterMs,
    });
    const origin = originOf(config);
    if (origin && Number.isFinite(retryAfterMs ?? 0)) {
      pausedUntil.set(
        origin,
        Math.max(pausedUntil.get(origin) || 0, now() + (retryAfterMs || 0))
      );
    }
    if (waitMs === undefined) throw error;
    const spreadMs = Math.min(
      random() * QSDM_RATE_LIMIT_SPREAD_MS,
      QSDM_RATE_LIMIT_WAIT_BUDGET_MS - state.waitedMs - waitMs
    );
    console.warn(
      `HTTP 429 from ${origin || 'the API'}; retrying in ${Math.ceil(
        (waitMs + spreadMs) / 1000
      )} s.`
    );
    await sleep(waitMs + spreadMs);
    // The pause this request waited for is over; the request interceptor
    // must not wait for it again.
    return instance.request({
      ...config,
      qsdmRateLimit: {
        retries: state.retries + 1,
        waitedMs: state.waitedMs + waitMs + spreadMs,
      },
    } as QsdmRateLimitConfig);
  });
};
