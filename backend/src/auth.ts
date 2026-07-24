import nacl from "tweetnacl";
import { Buffer } from "buffer";

/**
 * Stellar wallets sign arbitrary messages using Ed25519.
 * The wallet address is the base32-encoded public key (Stellar strkey).
 * We verify by decoding the public key and checking the signature against
 * the UTF-8 message bytes.
 */

export interface AuthPayload {
  walletAddress: string;
  message: string;
  signature: string; // hex-encoded Ed25519 signature
}

export interface AuthResult {
  valid: boolean;
  walletAddress?: string;
  error?: string;
}

/**
 * Decode a Stellar strkey (G... address) into its raw 32-byte Ed25519 public key.
 * Stellar strkey: version byte (0x06 << 3 = 0x30) + 32-byte key + 2-byte checksum, base32-encoded.
 */
function stellarAddressToPublicKey(address: string): Uint8Array {
  // Base32 alphabet used by Stellar
  const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function base32Decode(input: string): Uint8Array {
    const str = input.toUpperCase().replace(/=+$/, "");
    let bits = 0;
    let value = 0;
    let index = 0;
    const output = new Uint8Array(Math.floor((str.length * 5) / 8));

    for (let i = 0; i < str.length; i++) {
      const idx = BASE32_ALPHABET.indexOf(str[i]);
      if (idx === -1) throw new Error(`Invalid base32 character: ${str[i]}`);
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        output[index++] = (value >>> (bits - 8)) & 255;
        bits -= 8;
      }
    }
    return output.slice(0, index);
  }

  const decoded = base32Decode(address);
  // decoded[0] = version byte (0x30 for Ed25519 public key)
  // decoded[1..32] = 32-byte public key
  // decoded[33..34] = 2-byte checksum
  if (decoded.length !== 35) {
    throw new Error("Invalid Stellar address length");
  }
  if (decoded[0] !== 0x30) {
    throw new Error("Not an Ed25519 public key address");
  }
  return decoded.slice(1, 33);
}

/**
 * Verify a wallet signature.
 * @param payload - { walletAddress, message, signature }
 * @returns AuthResult
 */
export function verifyWalletSignature(payload: AuthPayload): AuthResult {
  const { walletAddress, message, signature } = payload;

  if (!walletAddress || !message || !signature) {
    return { valid: false, error: "Missing required fields" };
  }

  try {
    const publicKey = stellarAddressToPublicKey(walletAddress);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = Buffer.from(signature, "hex");

    if (signatureBytes.length !== 64) {
      return { valid: false, error: "Signature must be 64 bytes (128 hex chars)" };
    }

    const isValid = nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKey
    );

    if (!isValid) {
      return { valid: false, error: "Invalid signature" };
    }

    return { valid: true, walletAddress };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signature verification failed";
    return { valid: false, error: message };
  }
}

/**
 * Extract auth payload from GraphQL context headers.
 */
export function extractAuthFromHeaders(headers: Record<string, string | string[] | undefined>): AuthPayload | null {
  const walletAddress = headers["x-wallet-address"];
  const message = headers["x-auth-message"];
  const signature = headers["x-auth-signature"];

  if (!walletAddress || !message || !signature) return null;

  return {
    walletAddress: Array.isArray(walletAddress) ? walletAddress[0] : walletAddress,
    message: Array.isArray(message) ? message[0] : message,
    signature: Array.isArray(signature) ? signature[0] : signature,
  };
}
