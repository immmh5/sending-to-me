import type { Readable, Writable } from "node:stream";
import { Storage as MegaStorageClass } from "megajs";
import type { MutableFile, Storage as MegaStorage } from "megajs";
import type { ObjectData, StorageDriver } from "./index";

/**
 * MEGA.nz driver — uses a regular MEGA account (free 20 GB) via megajs.
 *
 * Env:
 *   MEGA_EMAIL      account email (required)
 *   MEGA_PASSWORD   account password (required)
 *   MEGA_FOLDER     folder name inside the account (default "send-to-self")
 *
 * Files are stored by their generated id as the MEGA file name inside one
 * dedicated folder, so the rest of the app stays storage-agnostic. The login
 * session is cached for the process lifetime and re-created automatically on
 * session expiry (-9 ESID / -11 EACCESS style errors).
 */
export function isMegaConfigured(): boolean {
  return Boolean(process.env.MEGA_EMAIL && process.env.MEGA_PASSWORD);
}

const FOLDER_NAME = process.env.MEGA_FOLDER || "send-to-self";
const ID_PATTERN = /^[0-9a-fA-F-]{6,80}(\.thumb\.webp)?$/;

type UploadHandle = Writable & { complete: Promise<MutableFile> };

type MegaGlobal = typeof globalThis & {
  __stsMegaStorage?: Promise<MegaStorage> | null;
  __stsMegaFolder?: Promise<MutableFile> | null;
};
const g = globalThis as MegaGlobal;

function login(): Promise<MegaStorage> {
  if (g.__stsMegaStorage) return g.__stsMegaStorage;
  const email = process.env.MEGA_EMAIL as string;
  const password = process.env.MEGA_PASSWORD as string;
  const storage = new MegaStorageClass({
    email,
    password,
    keepalive: true,
    userAgent: "send-to-self/1.0 (+mega.nz)",
  });
  g.__stsMegaStorage = storage.ready
    .then((ready) => {
      console.info(`[storage] MEGA login ok (${ready.email ?? email})`);
      return ready;
    })
    .catch((err) => {
      g.__stsMegaStorage = null;
      void storage.close().catch(() => undefined);
      throw err instanceof Error ? err : new Error(String(err));
    });
  return g.__stsMegaStorage;
}

function relogin(): Promise<MegaStorage> {
  g.__stsMegaStorage = null;
  g.__stsMegaFolder = null;
  return login();
}

function findFolder(storage: MegaStorage): Promise<MutableFile> {
  if (g.__stsMegaFolder) return g.__stsMegaFolder;
  g.__stsMegaFolder = (async (): Promise<MutableFile> => {
    const existing = storage.root.children?.find(
      (c) => c.directory && c.name === FOLDER_NAME,
    );
    if (existing) return existing;
    console.info(`[storage] creating MEGA folder "${FOLDER_NAME}"`);
    return storage.mkdir(FOLDER_NAME);
  })().catch((err: unknown) => {
    g.__stsMegaFolder = null;
    throw err instanceof Error ? err : new Error(String(err));
  });
  return g.__stsMegaFolder;
}

function isSessionError(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return /(-9\b|-11\b|ESID|EACCESS|sessionid|session expired)/i.test(text);
}

function findNode(folder: MutableFile, id: string): MutableFile | undefined {
  return folder.children?.find((f) => !f.directory && f.name === id);
}

export class MegaStorageDriver implements StorageDriver {
  readonly kind = "mega" as const;

  /** Runs an operation against MEGA, retrying once with a fresh login on session expiry. */
  private async withFolder<T>(
    fn: (folder: MutableFile, storage: MegaStorage) => Promise<T>,
  ): Promise<T> {
    const storage = await login();
    try {
      return await fn(await findFolder(storage), storage);
    } catch (err) {
      if (!isSessionError(err)) throw err;
      const fresh = await relogin();
      return fn(await findFolder(fresh), fresh);
    }
  }

  async put(
    id: string,
    source: Buffer | Readable,
    _contentType: string,
    size?: number,
  ): Promise<void> {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid storage id: ${id}`);
    await this.withFolder(async (folder) => {
      const opts: { name: string; size?: number } = { name: id };
      if (typeof size === "number" && size >= 0) opts.size = size;
      const handle = folder.upload(
        opts,
        Buffer.isBuffer(source) ? source : undefined,
      ) as unknown as UploadHandle;
      if (!Buffer.isBuffer(source)) source.pipe(handle);
      await handle.complete;
    });
  }

  async get(
    id: string,
    range?: { start: number; end: number },
  ): Promise<ObjectData | null> {
    if (!ID_PATTERN.test(id)) return null;
    return this.withFolder(async (folder) => {
      const node = findNode(folder, id);
      if (!node) return null;
      let size = node.size;
      if (typeof size !== "number") {
        await node.loadAttributes();
        size = node.size;
      }
      // megajs uses inclusive [start, end], exactly like HTTP Range
      const body = node.download(range ? { start: range.start, end: range.end } : {});
      return { size: typeof size === "number" ? size : 0, body };
    });
  }

  async delete(id: string): Promise<void> {
    if (!ID_PATTERN.test(id)) return;
    try {
      await this.withFolder(async (folder) => {
        const node = findNode(folder, id);
        if (node) await node.delete(true);
      });
    } catch {
      /* already gone — fine */
    }
  }
}
