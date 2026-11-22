import { Event } from 'electron';

import { getQsdmWalletHistoryPage } from 'main/services/qsdmWalletHistory';
import {
  QsdmWalletHistoryRequest,
  QsdmWalletHistoryResponse,
} from 'models/api/qsdm';

export const getQsdmWalletHistory = async (
  _: Event,
  payload: QsdmWalletHistoryRequest
): Promise<QsdmWalletHistoryResponse> => getQsdmWalletHistoryPage(payload);
