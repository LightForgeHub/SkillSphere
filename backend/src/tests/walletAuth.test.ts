import { walletAuthMiddleware } from "../middleware/walletAuth";
import { Keypair } from "@stellar/stellar-sdk";
import { Request, Response } from "express";

const mockVerify = Keypair.fromPublicKey as jest.Mock;

function makeMockReq(overrides: {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}): Request {
  return {
    body: overrides.body ?? {},
    headers: overrides.headers ?? {},
  } as Request;
}

function makeMockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe("walletAuthMiddleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls next() for a properly signed request with valid nonce", () => {
    const keypairInstance = {
      publicKey: jest.fn().mockReturnValue("GTESTKEY"),
      verify: jest.fn().mockReturnValue(true),
    };
    mockVerify.mockReturnValue(keypairInstance);

    const body = { action: "updateProfile", name: "Alice" };
    const nonce = Date.now().toString();

    const req = makeMockReq({
      body,
      headers: {
        "x-stellar-public-key": "GTESTKEY",
        "x-signature": "abcdef123456",
        "x-auth-nonce": nonce,
      },
    });
    const res = makeMockRes();
    const next = jest.fn();

    walletAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(keypairInstance.verify).toHaveBeenCalled();
  });

  it("rejects request missing X-Stellar-Public-Key with 401", () => {
    const res = makeMockRes();
    const next = jest.fn();
    const req = makeMockReq({
      headers: {
        "x-signature": "sig",
        "x-auth-nonce": Date.now().toString(),
      },
    });

    walletAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing required authentication headers",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects request missing X-Signature with 401", () => {
    const res = makeMockRes();
    const next = jest.fn();
    const req = makeMockReq({
      headers: {
        "x-stellar-public-key": "GTESTKEY",
        "x-auth-nonce": Date.now().toString(),
      },
    });

    walletAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing required authentication headers",
    });
  });

  it("rejects request missing X-Auth-Nonce with 401", () => {
    const res = makeMockRes();
    const next = jest.fn();
    const req = makeMockReq({
      headers: {
        "x-stellar-public-key": "GTESTKEY",
        "x-signature": "sig",
      },
    });

    walletAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing required authentication headers",
    });
  });

  it("rejects request with expired nonce (older than 5 minutes) with 401", () => {
    const keypairInstance = {
      publicKey: jest.fn(),
      verify: jest.fn(),
    };
    mockVerify.mockReturnValue(keypairInstance);

    const oldNonce = Date.now() - 6 * 60 * 1000;

    const req = makeMockReq({
      body: { action: "withdraw" },
      headers: {
        "x-stellar-public-key": "GTESTKEY",
        "x-signature": "abcdef123456",
        "x-auth-nonce": oldNonce.toString(),
      },
    });
    const res = makeMockRes();
    const next = jest.fn();

    walletAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Request expired" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects request with future nonce (more than 5 minutes ahead) with 401", () => {
    const keypairInstance = {
      publicKey: jest.fn(),
      verify: jest.fn(),
    };
    mockVerify.mockReturnValue(keypairInstance);

    const futureNonce = Date.now() + 6 * 60 * 1000;

    const req = makeMockReq({
      body: { action: "refund" },
      headers: {
        "x-stellar-public-key": "GTESTKEY",
        "x-signature": "abcdef123456",
        "x-auth-nonce": futureNonce.toString(),
      },
    });
    const res = makeMockRes();
    const next = jest.fn();

    walletAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Request expired" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects request with invalid signature with 401", () => {
    const keypairInstance = {
      publicKey: jest.fn(),
      verify: jest.fn().mockReturnValue(false),
    };
    mockVerify.mockReturnValue(keypairInstance);

    const body = { action: "updateProfile", name: "Alice" };
    const nonce = Date.now().toString();

    const req = makeMockReq({
      body,
      headers: {
        "x-stellar-public-key": "GTESTKEY",
        "x-signature": "abcdef123456",
        "x-auth-nonce": nonce,
      },
    });
    const res = makeMockRes();
    const next = jest.fn();

    walletAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid signature" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects request with tampered payload with 401", () => {
    const keypairInstance = {
      publicKey: jest.fn(),
      verify: jest.fn().mockReturnValue(false),
    };
    mockVerify.mockReturnValue(keypairInstance);

    const body = { action: "withdraw", amount: 100 };
    const nonce = Date.now().toString();

    const req = makeMockReq({
      body,
      headers: {
        "x-stellar-public-key": "GTESTKEY",
        "x-signature": "abcdef123456",
        "x-auth-nonce": nonce,
      },
    });
    const res = makeMockRes();
    const next = jest.fn();

    walletAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid signature" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects request with invalid public key with 401", () => {
    mockVerify.mockImplementation(() => {
      throw new Error("Invalid public key format");
    });

    const res = makeMockRes();
    const next = jest.fn();
    const req = makeMockReq({
      body: { action: "refund" },
      headers: {
        "x-stellar-public-key": "GINVALIDKEY123456789012345678901234567890123456789012",
        "x-signature": "a".repeat(128),
        "x-auth-nonce": Date.now().toString(),
      },
    });

    walletAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Invalid public key or signature",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects request with invalid nonce format with 401", () => {
    const keypairInstance = {
      publicKey: jest.fn(),
      verify: jest.fn(),
    };
    mockVerify.mockReturnValue(keypairInstance);

    const req = makeMockReq({
      body: { action: "refund" },
      headers: {
        "x-stellar-public-key": "GTESTKEY",
        "x-signature": "abcdef123456",
        "x-auth-nonce": "not-a-timestamp",
      },
    });
    const res = makeMockRes();
    const next = jest.fn();

    walletAuthMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid nonce format" });
  });
});