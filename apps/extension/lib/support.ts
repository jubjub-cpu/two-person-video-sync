export type SupportAssetId = "bitcoin" | "ethereum";

export interface SupportAsset {
  readonly id: SupportAssetId;
  readonly name: string;
  readonly symbol: string;
  readonly address: string;
  readonly paymentUri: string;
  readonly scanLabel: string;
  readonly networkNotice: string;
}

export const SUPPORT_ASSETS: Readonly<Record<SupportAssetId, SupportAsset>> = {
  bitcoin: {
    id: "bitcoin",
    name: "Bitcoin",
    symbol: "BTC",
    address: "3Ej3XVxtvkZqgrzeFt7AXfe5xtj67QnW87",
    paymentUri: "bitcoin:3Ej3XVxtvkZqgrzeFt7AXfe5xtj67QnW87",
    scanLabel: "Scan with a Bitcoin wallet",
    networkNotice: "Bitcoin network only.",
  },
  ethereum: {
    id: "ethereum",
    name: "Ethereum",
    symbol: "ETH",
    address: "0x9B1110fAf0469474a681dba98826a0aeEc7A48B2",
    paymentUri: "ethereum:0x9B1110fAf0469474a681dba98826a0aeEc7A48B2@1",
    scanLabel: "Scan with an Ethereum wallet",
    networkNotice: "Ethereum Mainnet only.",
  },
};

export const SUPPORT_ASSET_IDS = ["bitcoin", "ethereum"] as const;

export function isSupportAssetId(value: string): value is SupportAssetId {
  return SUPPORT_ASSET_IDS.some((assetId) => assetId === value);
}
