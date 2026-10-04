import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { get, put, del, list, BlobPreconditionFailedError, BlobNotFoundError } from '@vercel/blob';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Stored = { body: Uint8Array; etag: string };
export interface Storage {
  read(path: string): Promise<Stored | null>;
  write(
    path: string,
    body: Uint8Array,
    expected: string | 'create',
    contentType?: string,
  ): Promise<string>;
  remove(path: string, expected?: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  stream(path: string): Promise<ReadableStream<Uint8Array> | null>;
}
const digest = (bytes: Uint8Array) => '"' + createHash('sha256').update(bytes).digest('hex') + '"';
export class FileStorage implements Storage {
  constructor(private root: string) {}
  private path(path: string) {
    if (path.includes('..') || !/^[a-z0-9/._-]+$/.test(path))
      throw new ApiError(400, 'Invalid storage path');
    return resolve(this.root, path);
  }
  async read(path: string): Promise<Stored | null> {
    try {
      const body = await readFile(this.path(path));
      return { body, etag: digest(body) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  private async lock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const file = this.path(path);
    await mkdir(dirname(file), { recursive: true });
    const lock = file + '.lock';
    for (let i = 0; ; i++) {
      try {
        await mkdir(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (i >= 40) throw new ApiError(409, 'Storage busy; retry');
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  async write(path: string, body: Uint8Array, expected: string | 'create'): Promise<string> {
    return this.lock(path, async () => {
      const current = await this.read(path);
      if (expected === 'create' ? current !== null : current?.etag !== expected)
        throw new ApiError(412, 'The document changed. Pull again before editing.');
      const temporary = this.path(path) + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.path(path));
      return digest(body);
    });
  }
  async remove(path: string, expected?: string) {
    await this.lock(path, async () => {
      const current = await this.read(path);
      if (expected && current?.etag !== expected) throw new ApiError(412, 'The document changed');
      await rm(this.path(path), { force: true });
    });
  }
  async list(prefix: string): Promise<string[]> {
    const walk = async (dir: string): Promise<string[]> => {
      let names: string[];
      try {
        names = await readdir(this.path(dir));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      const paths = await Promise.all(
        names
          .filter((n) => !n.endsWith('.lock') && !n.endsWith('.tmp'))
          .map(async (name) => {
            const path = `${dir}/${name}`;
            return (await stat(this.path(path))).isDirectory() ? walk(path) : [path];
          }),
      );
      return paths.flat();
    };
    const base = prefix.endsWith('/')
      ? prefix.slice(0, -1)
      : prefix.slice(0, prefix.lastIndexOf('/'));
    return (await walk(base)).filter((p) => p.startsWith(prefix)).sort();
  }
  async stream(path: string) {
    const item = await this.read(path);
    return item
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(item.body);
            controller.close();
          },
        })
      : null;
  }
}
export class BlobStorage implements Storage {
  async read(path: string): Promise<Stored | null> {
    try {
      const result = await get(path, { access: 'private', useCache: false });
      if (!result || !result.stream) return null;
      return {
        body: new Uint8Array(await new Response(result.stream).arrayBuffer()),
        etag: result.blob.etag,
      };
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    }
  }
  async write(
    path: string,
    body: Uint8Array,
    expected: string | 'create',
    contentType = 'application/json',
  ): Promise<string> {
    try {
      const result = await put(path, new Blob([Uint8Array.from(body).buffer]), {
        access: 'private',
        addRandomSuffix: false,
        contentType,
        allowOverwrite: expected !== 'create',
        ...(expected !== 'create' ? { ifMatch: expected } : {}),
      });
      return result.etag;
    } catch (e) {
      if (
        e instanceof BlobPreconditionFailedError ||
        (expected === 'create' && /already exists/i.test(String(e)))
      )
        throw new ApiError(412, 'The document changed. Pull again before editing.');
      throw e;
    }
  }
  async remove(path: string, expected?: string) {
    try {
      await del(path, expected ? { ifMatch: expected } : {});
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) throw new ApiError(412, 'The document changed');
      throw e;
    }
  }
  async list(prefix: string) {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await list({ prefix, cursor, limit: 1000 });
      paths.push(...result.blobs.map((b) => b.pathname));
      cursor = result.hasMore ? result.cursor : undefined;
    } while (cursor);
    return paths.sort();
  }
  async stream(path: string) {
    try {
      return (await get(path, { access: 'private', useCache: false }))?.stream ?? null;
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    }
  }
}
export function storage(): Storage {
  if (process.env.STORAGE_DRIVER === 'blob') return new BlobStorage();
  if (process.env.VERCEL) throw new ApiError(503, 'Production requires private Blob storage');
  return new FileStorage(process.env.DATA_DIR ?? 'local-data/store');
}
