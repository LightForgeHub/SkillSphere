import { verifyWalletSignature, extractAuthFromHeaders } from "../auth";
import { generateTestWallet, signMessage } from "./helpers/wallet";

describe("verifyWalletSignature", () => {
  it("returns invalid when fields are missing", () => {
    expect(
      verifyWalletSignature({ walletAddress: "", message: "msg", signature: "sig" })
    ).toMatchObject({ valid: false, error: "Missing required fields" });

    expect(
      verifyWalletSignature({ walletAddress: "GADDR", message: "", signature: "sig" })
    ).toMatchObject({ valid: false, error: "Missing required fields" });

    expect(
      verifyWalletSignature({ walletAddress: "GADDR", message: "msg", signature: "" })
    ).toMatchObject({ valid: false, error: "Missing required fields" });
  });

  it("returns invalid for a malformed (too short) Stellar address", () => {
    const result = verifyWalletSignature({
      walletAddress: "GSHORT",
      message: "test",
      signature: "a".repeat(128),
    });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns invalid when signature is not 64 bytes", () => {
    const wallet = generateTestWallet();
    const result = verifyWalletSignature({
      walletAddress: wallet.address,
      message: "test",
      signature: "abcd1234", // way too short
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/64 bytes/i);
  });

  it("returns invalid when signature does not match message", () => {
    const wallet = generateTestWallet();
    const sig = signMessage(wallet, "correct message");

    const result = verifyWalletSignature({
      walletAddress: wallet.address,
      message: "wrong message",
      signature: sig,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid signature/i);
  });

  it("returns valid for a correct signature", () => {
    const wallet = generateTestWallet();
    const message = "SkillSphere Auth";
    const sig = signMessage(wallet, message);

    const result = verifyWalletSignature({
      walletAddress: wallet.address,
      message,
      signature: sig,
    });
    expect(result.valid).toBe(true);
    expect(result.walletAddress).toBe(wallet.address);
  });
});

describe("extractAuthFromHeaders", () => {
  it("returns null when headers are missing", () => {
    expect(extractAuthFromHeaders({})).toBeNull();
    expect(extractAuthFromHeaders({ "x-wallet-address": "GADDR" })).toBeNull();
  });

  it("extracts auth payload from headers", () => {
    const result = extractAuthFromHeaders({
      "x-wallet-address": "GADDR",
      "x-auth-message": "msg",
      "x-auth-signature": "sig",
    });
    expect(result).toEqual({
      walletAddress: "GADDR",
      message: "msg",
      signature: "sig",
    });
  });

  it("handles array header values by taking the first", () => {
    const result = extractAuthFromHeaders({
      "x-wallet-address": ["GADDR1", "GADDR2"],
      "x-auth-message": ["msg1", "msg2"],
      "x-auth-signature": ["sig1", "sig2"],
    });
    expect(result?.walletAddress).toBe("GADDR1");
    expect(result?.message).toBe("msg1");
    expect(result?.signature).toBe("sig1");
  });
});
