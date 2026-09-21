import * as crypto from 'crypto';

export interface EncryptedMessage {
  iv: string;
  tag: string;
  data: string;
  v: number;
}

const PROTOCOL_VERSION = 1;

/**
 * EncryptedChannel — AEAD transport codec (AES-256-GCM) used for every
 * payload exchanged between the phone and the PC after QR pairing.
 * Zero central routing: keys are derived locally via ECDH during pairing,
 * never stored or relayed through a third party.
 */
export class EncryptedChannel {
  private key: Buffer;

  constructor(sharedSecret: Buffer) {
    this.key = crypto.createHash('sha256').update(sharedSecret).digest();
  }

  static deriveSharedSecret(ownPrivateKey: crypto.KeyObject, peerPublicKeyPem: string): Buffer {
    const peer = crypto.createPublicKey(peerPublicKeyPem);
    return crypto.diffieHellman({ privateKey: ownPrivateKey, publicKey: peer });
  }

  encrypt(payload: Record<string, unknown> | string): EncryptedMessage {
    const plain = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: enc.toString('base64'),
      v: PROTOCOL_VERSION,
    };
  }

  decrypt(msg: EncryptedMessage): string {
    if (msg.v !== PROTOCOL_VERSION) throw new Error(`Unsupported protocol version: ${msg.v}`);
    const iv = Buffer.from(msg.iv, 'base64');
    const tag = Buffer.from(msg.tag, 'base64');
    const data = Buffer.from(msg.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  decryptJson<T>(msg: EncryptedMessage): T {
    return JSON.parse(this.decrypt(msg)) as T;
  }

  static generateKeyPair(): { privateKey: crypto.KeyObject; publicKeyPem: string } {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    return { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  }

  /** Serialize a message for the wire (JSON string). */
  static toWire(msg: EncryptedMessage): string {
    return JSON.stringify(msg);
  }

  static fromWire(raw: string | Buffer): EncryptedMessage {
    const parsed = JSON.parse(raw.toString());
    if (!parsed || typeof parsed.iv !== 'string' || typeof parsed.tag !== 'string' || typeof parsed.data !== 'string') {
      throw new Error('Malformed encrypted message');
    }
    return parsed;
  }
}
