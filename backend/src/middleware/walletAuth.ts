import { Request, Response, NextFunction } from "express";
import { Keypair } from "@stellar/stellar-sdk";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function walletAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const publicKey = req.headers["x-stellar-public-key"];
  const signature = req.headers["x-signature"];
  const nonce = req.headers["x-auth-nonce"];

  if (!publicKey || !signature || !nonce) {
    res.status(401).json({ error: "Missing required authentication headers" });
    return;
  }

  const nonceTimestamp = Number(nonce);
  if (Number.isNaN(nonceTimestamp)) {
    res.status(401).json({ error: "Invalid nonce format" });
    return;
  }

  const now = Date.now();
  if (Math.abs(now - nonceTimestamp) > FIVE_MINUTES_MS) {
    res.status(401).json({ error: "Request expired" });
    return;
  }

  try {
    const keypair = Keypair.fromPublicKey(publicKey as string);

    const body = req.body ?? {};
    const dataString = JSON.stringify(sortObjectKeys(body));
    const dataBytes = Buffer.from(dataString, "utf-8");
    const signatureBytes = Buffer.from(signature as string, "hex");

    const isValid = keypair.verify(dataBytes, signatureBytes);

    if (!isValid) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    next();
  } catch {
    res.status(401).json({ error: "Invalid public key or signature" });
  }
}