import config from 'config';
import {
  QsdmWalletHistoryRequest,
  QsdmWalletHistoryResponse,
} from 'models/api/qsdm';
import sendMessage from 'preload/sendMessage';

export default (
  payload: QsdmWalletHistoryRequest
): Promise<QsdmWalletHistoryResponse> =>
  sendMessage(config.endpoints.GET_QSDM_WALLET_HISTORY, payload);
