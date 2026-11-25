import { useEffect } from 'react';
import { useQueryClient } from 'react-query';

import { resetQsdmWalletQueries } from 'renderer/services/qsdmWalletQueries';

/** Hive tells every window after a wallet switch; nothing of the previous wallet stays on screen or in use. */
export const useQsdmWalletChangeListener = () => {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      window.main.onQsdmWalletChanged(() => {
        resetQsdmWalletQueries(queryClient);
      }),
    [queryClient]
  );
};
