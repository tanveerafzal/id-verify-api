import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Get encryption key from config (must be 32 bytes for AES-256)
 */
function getEncryptionKey(): Buffer {
  const key = config.security.encryptionKey;
  // Hash the key to ensure it's exactly 32 bytes
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypt a string (e.g., verification ID)
 * Returns a URL-safe base64 encoded string
 */
export function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Combine IV + authTag + encrypted data
  const combined = Buffer.concat([
    iv,
    authTag,
    Buffer.from(encrypted, 'hex')
  ]);

  // Return URL-safe base64
  return combined.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decrypt a string that was encrypted with encrypt()
 * Accepts URL-safe base64 encoded string
 */
export function decrypt(encryptedText: string): string {
  try {
    const key = getEncryptionKey();

    // Convert from URL-safe base64
    let base64 = encryptedText
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    // Add padding if needed
    while (base64.length % 4) {
      base64 += '=';
    }

    const combined = Buffer.from(base64, 'base64');

    // Extract IV, authTag, and encrypted data
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted.toString('hex'), 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    console.error('[Crypto] Decryption failed:', error);
    throw new Error('Invalid or corrupted verification request');
  }
}

/**
 * Generate encrypted verification link
 */
export function generateVerificationLink(verificationId: string, frontendUrl: string): string {
  const encryptedId = encrypt(verificationId);
  return `${frontendUrl}/verify?verification-request=${encryptedId}`;
}

/**
 * Decrypt verification request parameter
 */
export function decryptVerificationRequest(encryptedRequest: string): string {
  return decrypt(encryptedRequest);
}
