import * as fs from 'fs/promises';
import * as path from 'path';
import type { SignedUrl } from '../../mobile/SignedUrl';

const MAX_FILE_SIZE = 1024 * 1024;

export class WorkspaceFiles {
  private root: string;
  /** Optional 15m signed-URL guard for file reads/writes (OpenMuse auth.ts port). */
  private signer: SignedUrl | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  getRoot(): string {
    return this.root;
  }

  /** Require signed URLs for the *_signed helpers below. Null = open (legacy). */
  setSigner(signer: SignedUrl | null): void {
    this.signer = signer;
  }

  /** Verify a signed file URL string and return its owner. Throws when invalid. */
  verifyFileUrl(signedUrl: string): string {
    if (!this.signer) return 'local';
    return this.signer.verify(new URL(signedUrl, 'http://localhost'));
  }

  resolve(relPath: string): string {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new Error('Path must be a non-empty string');
    }
    const abs = path.resolve(this.root, relPath);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`Path escapes workspace: ${relPath}`);
    }
    return abs;
  }

  async read(relPath: string): Promise<string> {
    const abs = this.resolve(relPath);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`);
    if (stat.size > MAX_FILE_SIZE) throw new Error(`File too large to read (${stat.size} bytes): ${relPath}`);
    return fs.readFile(abs, 'utf8');
  }

  async write(relPath: string, content: string): Promise<{ path: string; bytes: number }> {
    const abs = this.resolve(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { path: relPath, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async list(relPath: string = '.'): Promise<string[]> {
    const abs = this.resolve(relPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  }

  /** Signed read: verify the 15m HMAC URL before touching disk. */
  async readSigned(relPath: string, signedUrl: string): Promise<string> {
    this.verifyFileUrl(signedUrl);
    return this.read(relPath);
  }

  /** Signed write: verify the 15m HMAC URL before touching disk. */
  async writeSigned(relPath: string, content: string, signedUrl: string): Promise<{ path: string; bytes: number }> {
    this.verifyFileUrl(signedUrl);
    return this.write(relPath, content);
  }
}
