import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { WorkspaceFiles } from './WorkspaceFiles';

describe('WorkspaceFiles', () => {
  let root: string;
  let ws: WorkspaceFiles;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'umbra-ws-'));
    ws = new WorkspaceFiles(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes and reads back a file', async () => {
    const result = await ws.write('notes/todo.txt', 'hello umbra');
    expect(result).toEqual({ path: 'notes/todo.txt', bytes: 11 });
    expect(await ws.read('notes/todo.txt')).toBe('hello umbra');
  });

  it('creates nested directories automatically', async () => {
    await ws.write('a/b/c/deep.txt', 'x');
    expect(await ws.read('a/b/c/deep.txt')).toBe('x');
  });

  it('lists workspace contents', async () => {
    await ws.write('a.txt', '1');
    await ws.write('sub/b.txt', '2');
    const list = await ws.list();
    expect(list).toContain('a.txt');
    expect(list).toContain('sub/');
    expect(await ws.list('sub')).toEqual(['b.txt']);
  });

  it('blocks path traversal', async () => {
    expect(() => ws.resolve('..\\outside.txt')).toThrow(/escapes workspace/);
    expect(() => ws.resolve('../../etc/passwd')).toThrow(/escapes workspace/);
    await expect(ws.read('..\\outside.txt')).rejects.toThrow(/escapes workspace/);
    await expect(ws.write('..\\outside.txt', 'x')).rejects.toThrow(/escapes workspace/);
  });

  it('throws when reading a missing file', async () => {
    await expect(ws.read('missing.txt')).rejects.toThrow(/ENOENT/);
  });
});
