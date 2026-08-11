import { describe, expect, it } from "vitest";

import { isSupportAssetId, SUPPORT_ASSETS, SUPPORT_ASSET_IDS } from "../lib/support";

describe("developer support destinations", () => {
  it("keeps the supplied wallet addresses exact", () => {
    expect(SUPPORT_ASSETS.bitcoin.address).toBe("3Ej3XVxtvkZqgrzeFt7AXfe5xtj67QnW87");
    expect(SUPPORT_ASSETS.ethereum.address).toBe("0x9B1110fAf0469474a681dba98826a0aeEc7A48B2");
  });

  it("uses network-aware payment URIs in QR codes without prescribing an amount", () => {
    expect(SUPPORT_ASSETS.bitcoin.paymentUri).toBe(`bitcoin:${SUPPORT_ASSETS.bitcoin.address}`);
    expect(SUPPORT_ASSETS.ethereum.paymentUri).toBe(
      `ethereum:${SUPPORT_ASSETS.ethereum.address}@1`,
    );
    expect(SUPPORT_ASSETS.bitcoin.paymentUri).not.toContain("amount=");
    expect(SUPPORT_ASSETS.ethereum.paymentUri).not.toContain("value=");
  });

  it("accepts only supported asset identifiers", () => {
    expect(SUPPORT_ASSET_IDS).toEqual(["bitcoin", "ethereum"]);
    expect(isSupportAssetId("bitcoin")).toBe(true);
    expect(isSupportAssetId("ethereum")).toBe(true);
    expect(isSupportAssetId("usdc")).toBe(false);
  });
});
