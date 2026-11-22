export interface TransferCellParam {
  accountName: string;
  amount: number;
  toWalletAddress: string;
  /** The QSDM address the screen showed as the sender; Hive refuses the send if another wallet is active now. */
  fromAddress?: string;
}
