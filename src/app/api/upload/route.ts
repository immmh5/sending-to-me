import crypto from "node:crypto";
import { Readable } from "node:stream";
import { isAuthed } from "@/lib/auth";
import { getDriver, thumbKey } from "@/lib/storage";
import { createItem } from "@/lib/store";
import { makeThumbBuffer } from "@/lib/thumbs";
import type { StoredFile } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_TEXT = 20_000;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB per file
const MAX_THUMB_SOURCE_BYTES = 64 * 1024 * 1024; // thumbnails only for images ≤ 64 MB

function cleanName(name: string | undefined | null): string {
  const base = (name ?? "")
    // strip control chars + path separators — display name only, dot is kept
    .replace(/[\u0000-\u001F\u007F/\\]+/g, " ")
    .trim()
    .slice(0, 180);
  return base || "ملف";
}

async function persist(file: File): Promise<StoredFile> {
  const driver = getDriver();
  const id = crypto.randomUUID();
  const mime = (file.type || "application/octet-stream").split(";")[0].toLowerCase();
  const isImage = mime.startsWith("image/");

  if (isImage && file.size <= MAX_THUMB_SOURCE_BYTES) {
    // images worth thumbnailing go through memory once, then stream to storage
    const buf = Buffer.from(await file.arrayBuffer());
    await driver.put(id, buf, mime, buf.length);
    const thumb = await makeThumbBuffer(buf);
    if (thumb) await driver.put(thumbKey(id), thumb, "image/webp", thumb.length);
  } else {
    // everything else streams straight to storage with flat memory usage
    const webStream = file.stream() as unknown as Parameters<
      typeof Readable.fromWeb
    >[0];
    await driver.put(id, Readable.fromWeb(webStream), mime, file.size);
  }

  return { id, name: cleanName(file.name), mime, size: file.size };
}

export async function POST(req: Request) {
  if (!(await isAuthed(req))) {
    return Response.json({ error: "غير مصرّح" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";

  /* ---- text-only JSON send ---- */
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "طلب غير صالح" }, { status: 400 });
    }
    const text =
      typeof body === "object" && body !== null
        ? (body as { text?: unknown }).text
        : null;
    if (typeof text !== "string" || text.trim().length === 0) {
      return Response.json({ error: "النص فارغ" }, { status: 400 });
    }
    const item = await createItem(text.slice(0, MAX_TEXT), []);
    return Response.json({ item }, { status: 201 });
  }

  /* ---- multipart send (text + files) ---- */
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "تعذّرت قراءة البيانات" }, { status: 400 });
  }

  const rawText = form.get("text");
  const text =
    typeof rawText === "string" ? rawText.slice(0, MAX_TEXT).trim() : "";
  const uploads = form
    .getAll("files")
    .filter((v): v is File => v instanceof File && v.size > 0);

  if (uploads.length > MAX_FILES) {
    return Response.json(
      { error: `الحد الأقصى ${MAX_FILES} ملفًا في المرة الواحدة` },
      { status: 400 },
    );
  }
  if (uploads.length === 0 && text.length === 0) {
    return Response.json({ error: "لا يوجد شيء للإرسال" }, { status: 400 });
  }

  const stored: StoredFile[] = [];
  const failures: string[] = [];
  for (const f of uploads) {
    if (f.size > MAX_FILE_BYTES) {
      failures.push(cleanName(f.name));
      continue;
    }
    try {
      stored.push(await persist(f));
    } catch {
      failures.push(cleanName(f.name));
    }
  }

  if (stored.length === 0 && text.length === 0) {
    return Response.json(
      { error: "تعذّر حفظ الملفات (ربما تجاوز أحدها ٢٠٠ ميجابايت)", failures },
      { status: 413 },
    );
  }

  const item = await createItem(text, stored);
  return Response.json({ item, failures }, { status: 201 });
}
