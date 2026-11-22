import config from 'config';
import sendMessage from 'preload/sendMessage';

export default (): Promise<{ restarting: boolean }> =>
  sendMessage(config.endpoints.RESTART_TO_UPDATE, undefined);
