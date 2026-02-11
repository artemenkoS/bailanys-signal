import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

type EncryptedPayload = {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  ct: string;
  tag: string;
};

let cachedKey: Buffer | null = null;

const decodeKey = (raw: string): Buffer => {
  if (raw.startsWith('base64:')) {
    return Buffer.from(raw.slice(7), 'base64');
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return Buffer.from(raw, 'base64');
};

const getKey = (): Buffer => {
  if (cachedKey) return cachedKey;
  const raw = process.env.CHAT_ENCRYPTION_KEY ?? '';
  if (!raw) {
    throw new Error('CHAT_ENCRYPTION_KEY is not set');
  }
  const key = decodeKey(raw.trim());
  if (key.length !== 32) {
    throw new Error('CHAT_ENCRYPTION_KEY must be 32 bytes (hex or base64)');
  }
  cachedKey = key;
  return key;
};

export const isEncryptedPayload = (value: string): boolean => {
  if (!value || value[0] !== '{') return false;
  try {
    const parsed = JSON.parse(value) as Partial<EncryptedPayload>;
    return (
      parsed.v === 1 &&
      parsed.alg === 'A256GCM' &&
      typeof parsed.iv === 'string' &&
      typeof parsed.ct === 'string' &&
      typeof parsed.tag === 'string'
    );
  } catch {
    return false;
  }
};

export const encryptChatBody = (plaintext: string): string => {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload: EncryptedPayload = {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    ct: ciphertext.toString('base64'),
    tag: tag.toString('base64'),
  };
  return JSON.stringify(payload);
};

export const decryptChatBody = (value: string): string => {
  if (!isEncryptedPayload(value)) return value;
  const key = getKey();
  const parsed = JSON.parse(value) as EncryptedPayload;
  const iv = Buffer.from(parsed.iv, 'base64');
  const ciphertext = Buffer.from(parsed.ct, 'base64');
  const tag = Buffer.from(parsed.tag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
};
