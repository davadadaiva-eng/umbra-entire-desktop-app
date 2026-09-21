import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_FILE_SIZE = 1024 * 1024;

export class WorkspaceFiles {
  private root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  getRoot(): string {
    return this.root;
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
}
