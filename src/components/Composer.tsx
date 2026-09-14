"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  File as FileGlyph,
  Loader2,
  Mic,
  Paperclip,
  Send,
  Square,
  X,
} from "lucide-react";
import { arNum, formatBytes } from "@/lib/format";
import type { Item } from "@/lib/types";
import type { PushToast } from "./Toasts";

type Pending = {
  localId: string;
  file: File;
  preview: string | null;
};

type Props = {
  onSent: (item: Item) => void;
  onUnauthorized: () => void;
  push: PushToast;
};

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 20;

export default function Composer({ onSent, onUnauthorized, push }: Props) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragDepth = useRef(0);
  const seq = useRef(0);
  const filesRef = useRef<Pending[]>([]);
  filesRef.current = files;

  /* auto-grow textarea */
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const addFiles = useCallback(
    (incoming: Iterable<File>) => {
      const next: Pending[] = [];
      for (const f of incoming) {
        if (f.size === 0) continue;
        if (f.size > MAX_BYTES) {
          push(`"${f.name}" أكبر من ٢٠٠ ميجابايت`, "error");
          continue;
        }
        next.push({
          localId: `p${seq.current++}`,
          file: f,
          preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
        });
      }
      if (!next.length) return;
      setFiles((prev) => {
        const merged = [...prev, ...next];
        if (merged.length > MAX_FILES) {
          push(`الحد الأقصى ${arNum(MAX_FILES)} ملفًا في المرة الواحدة`, "error");
          return merged.slice(0, MAX_FILES);
        }
        return merged;
      });
    },
    [push],
  );

  const removeFile = useCallback((localId: string) => {
    setFiles((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return prev.filter((p) => p.localId !== localId);
    });
  }, []);

  /* drag & drop + paste anywhere */
  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(e.dataTransfer.files);
    };
    const onPaste = (e: ClipboardEvent) => {
      const pasted = e.clipboardData?.files;
      if (pasted && pasted.length > 0) {
        e.preventDefault();
        addFiles(pasted);
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [addFiles]);

  /* voice notes */
  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const rec = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (recording) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      push("التسجيل غير مدعوم في هذا المتصفح", "error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : undefined;
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || "audio/webm",
        });
        if (blob.size > 0) {
          const ext = blob.type.includes("mp4")
            ? "m4a"
            : blob.type.includes("ogg")
              ? "ogg"
              : "webm";
          const stamp = new Date()
            .toLocaleString("sv-SE")
            .replace(/[: ]/g, "-");
          addFiles([
            new File([blob], `رسالة صوتية ${stamp}.${ext}`, {
              type: blob.type,
            }),
          ]);
          push("أُرفقت الرسالة الصوتية");
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch {
      push("تعذّر الوصول إلى الميكروفون", "error");
    }
  }, [addFiles, push, recording]);

  /* cleanup on unmount */
  useEffect(() => {
    return () => {
      stopRecording();
      filesRef.current.forEach((p) => {
        if (p.preview) URL.revokeObjectURL(p.preview);
      });
    };
  }, [stopRecording]);

  const canSend = text.trim().length > 0 || files.length > 0;

  const send = useCallback(() => {
    if (!canSend || busy) return;
    setBusy(true);
    setProgress(0);

    const fd = new FormData();
    if (text.trim()) fd.set("text", text.trim());
    files.forEach((p) => fd.append("files", p.file, p.file.name));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      setBusy(false);
      if (xhr.status === 401) {
        onUnauthorized();
        return;
      }
      if (xhr.status === 201) {
        try {
          const data = JSON.parse(xhr.responseText) as {
            item: Item;
            failures?: string[];
          };
          onSent(data.item);
          setText("");
          setFiles((prev) => {
            prev.forEach((p) => {
              if (p.preview) URL.revokeObjectURL(p.preview);
            });
            return [];
          });
          push("وصل إلى صندوقك");
          if (data.failures?.length) {
            push(`تعذّر رفع: ${data.failures.join("، ")}`, "error");
          }
        } catch {
          push("استجابة غير متوقعة", "error");
        }
      } else {
        try {
          const data = JSON.parse(xhr.responseText) as { error?: string };
          push(data.error ?? "تعذّر الإرسال", "error");
        } catch {
          push("تعذّر الإرسال", "error");
        }
      }
    };
    xhr.onerror = () => {
      setBusy(false);
      push("انقطع الاتصال أثناء الرفع", "error");
    };
    xhr.send(fd);
  }, [busy, canSend, files, onSent, onUnauthorized, push, text]);

  const seconds = elapsed % 60;
  const minutes = Math.floor(elapsed / 60);

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="card overflow-hidden rounded-3xl p-3 sm:p-4"
      >
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
          rows={1}
          placeholder="اكتب شيئًا لنفسك…"
          aria-label="نص الرسالة"
          className="max-h-[200px] w-full resize-none bg-transparent px-3 py-2.5 text-[15px] leading-7 text-paper-100 placeholder:text-mist-500 focus:outline-none"
        />

        {/* attachments */}
        <AnimatePresence initial={false}>
          {files.length > 0 && (
            <motion.ul
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex flex-wrap gap-2 px-1 pb-1"
            >
              {files.map((p) => (
                <motion.li
                  key={p.localId}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  className="flex items-center gap-2 rounded-xl border border-white/10 bg-ink-800/90 py-1.5 pl-1.5 pr-2"
                >
                  {p.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.preview}
                      alt=""
                      className="size-8 rounded-lg object-cover"
                    />
                  ) : (
                    <FileGlyph className="size-4 shrink-0 text-mist-400" />
                  )}
                  <span className="max-w-36 truncate text-xs font-medium text-paper-200">
                    {p.file.name}
                  </span>
                  <span className="text-[10px] text-mist-500">
                    {formatBytes(p.file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(p.localId)}
                    aria-label="إزالة الملف"
                    className="rounded-full p-1 text-mist-500 transition hover:bg-white/10 hover:text-ember-400"
                  >
                    <X className="size-3.5" />
                  </button>
                </motion.li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>

        {/* toolbar */}
        <div className="mt-1 flex items-center gap-1.5 border-t border-white/5 px-1 pt-2.5">
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            title="إرفاق ملفات"
            aria-label="إرفاق ملفات"
            className="grid size-10 place-items-center rounded-xl text-mist-400 transition hover:bg-white/5 hover:text-gold-300"
          >
            <Paperclip className="size-[18px]" />
          </button>

          {recording ? (
            <button
              type="button"
              onClick={stopRecording}
              title="إيقاف التسجيل"
              className="flex items-center gap-2 rounded-xl bg-ember-500/15 px-3 py-2 text-sm font-bold text-ember-300 transition hover:bg-ember-500/25"
            >
              <span className="pulse-dot inline-block size-2 rounded-full bg-ember-400" />
              <Square className="size-3.5" />
              <span className="tabular-nums">
                {arNum(minutes)}:{arNum(seconds, { minimumIntegerDigits: 2 })}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startRecording()}
              title="تسجيل رسالة صوتية"
              aria-label="تسجيل رسالة صوتية"
              className="grid size-10 place-items-center rounded-xl text-mist-400 transition hover:bg-white/5 hover:text-ember-400"
            >
              <Mic className="size-[18px]" />
            </button>
          )}

          <div className="flex-1" />

          <button
            type="button"
            onClick={send}
            disabled={!canSend || busy}
            className="group flex items-center gap-2 rounded-2xl bg-gradient-to-l from-gold-300 to-gold-500 py-2.5 pl-5 pr-4 text-sm font-bold text-ink-900 shadow-[0_8px_30px_-8px] shadow-gold-500/60 transition hover:brightness-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4 -scale-x-100 transition-transform group-hover:-translate-x-0.5 group-hover:-translate-y-0.5" />
            )}
            إرسال
          </button>
        </div>

        {/* upload progress */}
        {busy && progress > 0 && (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-gradient-to-l from-gold-300 to-ember-400 transition-[width] duration-150"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        )}
      </motion.div>

      {/* full-screen drop overlay */}
      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-ink-950/70 backdrop-blur-md"
          >
            <motion.div
              initial={{ scale: 0.92 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="grid place-items-center gap-3 rounded-[2rem] border-2 border-dashed border-gold-400/60 px-16 py-14 text-center"
            >
              <Paperclip className="size-8 text-gold-300" />
              <p className="text-lg font-bold text-paper-50">أفلت الملفات هنا</p>
              <p className="text-sm text-mist-400">سيتم إرفاقها برسالتك فورًا</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
