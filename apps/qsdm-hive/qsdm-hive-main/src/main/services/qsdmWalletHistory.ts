/**
 * Recent transactions of a wallet, from two sources:
 * - Hive's own log of every send it makes, one file per sending wallet: hive-signer/wallet-sends/<address>.json, next
 *   to the wallet store. It holds the transaction id, recipient, amount, fee, time and status: no keys, no passphrases.
 *   The status comes from GET /receipts/<tx_id>: Pending until a receipt exists, then Confirmed (status 1) or Failed.
 * - The network's history, GET /wallet/history (transfers or mining rewards, paged with `before`). Until it answers
 *   (it is not live yet), Recent transactions shows Hive's own sends only.
 * The renderer merges both by transaction id (qsdmWalletHistoryView).
 */
import fs from 'fs';
import path from 'path';

import { buildQsdmCoreApiUrl } from 'config/qsdm';
import {
  QsdmWalletHistoryItem,
  QsdmWalletHistoryKind,
  QsdmWalletHistoryResponse,
  QsdmWalletHistoryStatus,
} from 'models/api/qsdm';

import { qsdmGetJson } from './qsdmHttpRead';
import { getQsdmDefaultLocalSignerPaths } from './qsdmTaskActionSigner';

export const QSDM_WALLET_HISTORY_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const READ_TIMEOUT_MS = 8000;
const SENDS_DIR = 'wallet-sends';
const ADDRESS = /^[0-9a-f]{64}$/;
const TX_ID = /^[0-9A-Za-z_.:-]{1,256}$/;

export interface QsdmWalletSendRecord {
  txId: string;
  to: string;
  amount: number;
  fee: number;
  time: string;
  status: QsdmWalletHistoryStatus;
}

type RawChainItem = {
  tx_id?: unknown;
  height?: unknown;
  time?: unknown;
  kind?: unknown;
  from?: unknown;
  to?: unknown;
  amount?: unknown;
  fee?: unknown;
  status?: unknown;
  index?: unknown;
};

type RawChainHistory = {
  items?: unknown;
  next_before?: unknown;
};

const normalizeAddress = (value?: string | null) =>
  (value || '').trim().toLowerCase();

const timeOf = (time: string) => {
  const parsed = Date.parse(time);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const newestFirst = (a: { time: string }, b: { time: string }) =>
  timeOf(b.time) - timeOf(a.time);

const isStatus = (value: unknown): value is QsdmWalletHistoryStatus =>
  value === 'pending' || value === 'confirmed' || value === 'failed';

const sendsPath = (address: string) =>
  path.join(
    getQsdmDefaultLocalSignerPaths().signerDir,
    SENDS_DIR,
    `${address}.json`
  );

export const readQsdmWalletSends = (wallet: string): QsdmWalletSendRecord[] => {
  const address = normalizeAddress(wallet);
  if (!ADDRESS.test(address)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(sendsPath(address), 'utf-8')) as {
      sends?: unknown;
    };
    if (!Array.isArray(raw?.sends)) return [];
    return (raw.sends as Array<Partial<QsdmWalletSendRecord>>)
      .filter(
        (send) =>
          !!send &&
          typeof send.txId === 'string' &&
          TX_ID.test(send.txId) &&
          typeof send.to === 'string' &&
          Number.isFinite(send.amount) &&
          typeof send.time === 'string'
      )
      .map((send) => ({
        txId: send.txId as string,
        to: send.to as string,
        amount: Number(send.amount),
        fee: Number(send.fee) || 0,
        time: send.time as string,
        status: isStatus(send.status) ? send.status : 'pending',
      }))
      .sort(newestFirst);
  } catch {
    return [];
  }
};

const writeQsdmWalletSends = (
  address: string,
  sends: QsdmWalletSendRecord[]
) => {
  const file = sendsPath(address);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ version: 1, address, sends }, null, 2)}\n`,
    { mode: 0o600 }
  );
  fs.renameSync(tmp, file);
};

/** After the network accepted a send: it shows in Recent transactions right away, as Pending. */
export const recordQsdmWalletSend = (
  sender: string,
  send: Omit<QsdmWalletSendRecord, 'status'>
) => {
  const address = normalizeAddress(sender);
  if (!ADDRESS.test(address) || !TX_ID.test(send.txId)) return;
  const sends = readQsdmWalletSends(address);
  if (sends.some((existing) => existing.txId === send.txId)) return;
  writeQsdmWalletSends(
    address,
    [{ ...send, status: 'pending' as const }, ...sends].sort(newestFirst)
  );
};

// No receipt yet (404) means Pending; a receipt with status 1 is Confirmed, any other status Failed. Anything else
// (unreachable, rate limited, an unknown answer) leaves the status as it was.
const readReceiptStatus = async (
  txId: string
): Promise<QsdmWalletHistoryStatus | undefined> => {
  try {
    const data = await qsdmGetJson<unknown>(
      buildQsdmCoreApiUrl(`/receipts/${encodeURIComponent(txId)}`),
      { timeout: READ_TIMEOUT_MS }
    );
    const receipt = (
      data && typeof data === 'object' && 'receipt' in data
        ? (data as { receipt?: unknown }).receipt
        : data
    ) as { status?: unknown } | undefined;
    if (typeof receipt?.status !== 'number') return undefined;
    return receipt.status === 1 ? 'confirmed' : 'failed';
  } catch (error) {
    return (error as { response?: { status?: number } })?.response?.status ===
      404
      ? 'pending'
      : undefined;
  }
};

/**
 * Resolves the Pending sends of a wallet: from the network history when it lists them, otherwise from their receipts.
 * Confirmed and Failed are final and are not asked again.
 */
export const refreshQsdmWalletSendStatuses = async (
  wallet: string,
  knownStatuses: Map<string, QsdmWalletHistoryStatus> = new Map()
) => {
  const address = normalizeAddress(wallet);
  const pending = readQsdmWalletSends(address).filter(
    (send) => send.status === 'pending'
  );
  const updates = new Map<string, QsdmWalletHistoryStatus>();
  await Promise.all(
    pending.map(async (send) => {
      const status =
        knownStatuses.get(send.txId) ?? (await readReceiptStatus(send.txId));
      if (status && status !== 'pending') updates.set(send.txId, status);
    })
  );
  // Read again before writing: a send recorded meanwhile must not be lost.
  const latest = readQsdmWalletSends(address).map((send) =>
    send.status === 'pending' && updates.has(send.txId)
      ? { ...send, status: updates.get(send.txId) as QsdmWalletHistoryStatus }
      : send
  );
  if (updates.size > 0) writeQsdmWalletSends(address, latest);
  return latest;
};

const sendToItem = (send: QsdmWalletSendRecord): QsdmWalletHistoryItem => ({
  txId: send.txId,
  time: send.time,
  type: 'sent',
  counterparty: send.to,
  amount: send.amount,
  outgoing: true,
  fee: send.fee,
  status: send.status,
  source: 'local',
});

const TYPES: Record<string, QsdmWalletHistoryItem['type']> = {
  send: 'sent',
  receive: 'received',
  reward: 'reward',
  other: 'other',
};

const toChainItem = (
  raw: RawChainItem,
  address: string
): QsdmWalletHistoryItem | undefined => {
  if (!raw || typeof raw.tx_id !== 'string' || !raw.tx_id) return undefined;
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount)) return undefined;
  const type = TYPES[String(raw.kind)] || 'other';
  const from = typeof raw.from === 'string' ? raw.from.toLowerCase() : '';
  const to = typeof raw.to === 'string' ? raw.to.toLowerCase() : '';
  const outgoing =
    type === 'sent' || (type === 'other' && !!from && from === address);
  const fee = Number(raw.fee);
  return {
    txId: raw.tx_id,
    index: Number.isInteger(raw.index) ? (raw.index as number) : undefined,
    time: typeof raw.time === 'string' ? raw.time : '',
    type,
    counterparty: (outgoing ? to : from) || undefined,
    amount: Math.abs(amount),
    outgoing,
    fee: Number.isFinite(fee) ? fee : undefined,
    // 1 = applied. An entry without a status is in a block, so it counts as applied.
    status:
      typeof raw.status === 'number' && raw.status !== 1
        ? 'failed'
        : 'confirmed',
    height: Number.isInteger(raw.height) ? (raw.height as number) : undefined,
    source: 'chain',
  };
};

/** One page of the network history, or undefined when the endpoint does not answer (404 until it is live). */
export const fetchQsdmWalletChainHistory = async ({
  address,
  kind,
  before,
  limit,
}: {
  address: string;
  kind: QsdmWalletHistoryKind;
  before?: string;
  limit: number;
}) => {
  const url = new URL(buildQsdmCoreApiUrl('/wallet/history'));
  url.searchParams.set('address', address);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('kind', kind);
  if (before) url.searchParams.set('before', before);
  try {
    const data = await qsdmGetJson<RawChainHistory>(url.toString(), {
      timeout: READ_TIMEOUT_MS,
    });
    if (!data || !Array.isArray(data.items)) return undefined;
    return {
      items: (data.items as RawChainItem[])
        .map((raw) => toChainItem(raw, address))
        .filter((item): item is QsdmWalletHistoryItem => !!item),
      nextBefore:
        typeof data.next_before === 'string' && data.next_before
          ? data.next_before
          : null,
    };
  } catch {
    return undefined;
  }
};

export const getQsdmWalletHistoryPage = async ({
  address: wallet,
  kind: requestedKind,
  before,
  limit: requestedLimit,
}: {
  address: string;
  kind?: QsdmWalletHistoryKind;
  before?: string;
  limit?: number;
}): Promise<QsdmWalletHistoryResponse> => {
  const address = normalizeAddress(wallet);
  const kind: QsdmWalletHistoryKind =
    requestedKind === 'rewards' ? 'rewards' : 'transfers';
  if (!ADDRESS.test(address)) {
    return { address, kind, available: false, items: [], nextBefore: null };
  }
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Math.floor(Number(requestedLimit) || QSDM_WALLET_HISTORY_PAGE_SIZE)
    )
  );
  const chain = await fetchQsdmWalletChainHistory({
    address,
    kind,
    before,
    limit,
  });
  const response: QsdmWalletHistoryResponse = {
    address,
    kind,
    available: !!chain,
    items: chain?.items ?? [],
    nextBefore: chain?.nextBefore ?? null,
  };
  // Hive's own sends are transfers; they come with the newest page.
  if (kind === 'transfers' && !before) {
    const sends = await refreshQsdmWalletSendStatuses(
      address,
      new Map(response.items.map((item) => [item.txId, item.status]))
    );
    response.localSends = sends.map(sendToItem);
  }
  return response;
};
