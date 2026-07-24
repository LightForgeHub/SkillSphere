import nacl from "tweetnacl";
import { Buffer } from "buffer";

/**
 * A test wallet with a real Ed25519 keypair.
 */
export interface TestWallet {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** Stellar-style G... address (base32 encoded strkey) */
  address: string;
}

/**
 * Encode a raw 32-byte Ed25519 public key as a Stellar strkey (G... address).
 * Format: version_byte (0x30) + public_key (32 bytes) + checksum (2 bytes), base32-encoded.
 */
function publicKeyToStellarAddress(publicKey: Uint8Array): string {
  const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function crc16(data: Uint8Array): number {
    let crc = 0x0000;
    for (const byte of data) {
      for (let i = 0; i < 8; i++) {
        const mix = (crc ^ (byte << (8 - i - 1))) & 0x8000;
        crc <<= 1;
        if (mix) crc ^= 0x1021;
      }
    }
    return crc & 0xffff;
  }

  function base32Encode(data: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let output = "";
    for (const byte of data) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) {
      output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
  }

  // Build payload: version + key
  const payload = new Uint8Array(33);
  payload[0] = 0x30; // Ed25519 public key version byte
  payload.set(publicKey, 1);

  // Calculate checksum (CRC-16/XMODEM of payload, little-endian)
  const checksum = crc16(payload);
  const checksumBytes = new Uint8Array(2);
  checksumBytes[0] = checksum & 0xff;
  checksumBytes[1] = (checksum >> 8) & 0xff;

  // Combine payload + checksum
  const full = new Uint8Array(35);
  full.set(payload);
  full.set(checksumBytes, 33);

  return base32Encode(full);
}

/**
 * Generate a fresh Ed25519 keypair as a TestWallet.
 */
export function generateTestWallet(): TestWallet {
  const keyPair = nacl.sign.keyPair();
  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    address: publicKeyToStellarAddress(keyPair.publicKey),
  };
}

/**
 * Sign a message with a test wallet's secret key.
 * Returns hex-encoded signature.
 */
export function signMessage(wallet: TestWallet, message: string): string {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, wallet.secretKey);
  return Buffer.from(signature).toString("hex");
}

/**
 * Build the auth headers needed to pass wallet authentication.
 */
export function buildAuthHeaders(
  wallet: TestWallet,
  message: string = "SkillSphere Auth"
): Record<string, string> {
  return {
    "x-wallet-address": wallet.address,
    "x-auth-message": message,
    "x-auth-signature": signMessage(wallet, message),
  };
}
