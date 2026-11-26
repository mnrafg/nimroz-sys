import "server-only";
import { type SetupEvent } from "./adms-setup-contract";

// ============================================================
// NDJSON streaming helpers for the ADMS setup/install endpoint.
//
// Each event is ONE JSON object per line ("\n"-terminated) and is
// enqueued immediately after emission — the per-line enqueue acts as
// the flush so progress appears live in the browser.
//
// Unicode safety: JSON.stringify never emits a raw newline INSIDE a
// string (control characters are escaped), so line boundaries cannot
// be corrupted by Dari text; TextEncoder produces UTF-8 bytes.
//
// Interruption safety: once the client disconnects (request signal
// aborts or the stream is cancelled) the emitter flags itself closed,
// silently drops further events and never throws into the install
// logic — the install keeps or stops its work based on the returned
// `closed` flag, not on write failures.
// ============================================================

export interface NdjsonEmitter {
  /** Encode + enqueue one event as one NDJSON line (no-op when closed). */
  send(event: SetupEvent): void;
  /** true once the client stream is gone — further sends are dropped. */
  readonly closed: boolean;
  /** End the stream (idempotent). */
  close(): void;
}

interface NdjsonOptions {
  /** Request abort signal — marks the emitter closed on client disconnect. */
  signal?: AbortSignal | null;
  /** The install routine; receives the emitter. Errors become error events. */
  run: (emit: NdjsonEmitter) => Promise<void>;
}

export function createNdjsonResponse(options: NdjsonOptions): Response {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const closeController = () => {
    if (controllerRef) {
      try {
        controllerRef.close();
      } catch {
        // already closed/cancelled
      }
      controllerRef = null;
    }
  };

  const emit: NdjsonEmitter = {
    get closed() {
      return closed;
    },
    send(event: SetupEvent) {
      if (closed || !controllerRef) return;
      try {
        const line = JSON.stringify(event) + "\n";
        controllerRef.enqueue(encoder.encode(line));
      } catch {
        // stream died between abort detection and enqueue
        closed = true;
        closeController();
      }
    },
    close() {
      closed = true;
      closeController();
    },
  };

  if (options.signal) {
    options.signal.addEventListener(
      "abort",
      () => {
        closed = true;
        closeController();
      },
      { once: true }
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // Fire-and-forget: the routine streams events through the emitter.
      void options
        .run(emit)
        .then(() => {
          emit.close();
        })
        .catch((e: unknown) => {
          // Unknown mid-way outcome → the consumer must be told honestly.
          const uncertain = e instanceof Error && e.name === "AdmsConnectionLostError";
          emit.send({
            type: "error",
            message: uncertain
              ? "اتصال SSH در میانه عملیات قطع شد؛ وضعیت نهایی نصب نامعلوم است."
              : "عملیات نصب با خطا ناتمام ماند.",
            ...(uncertain ? { uncertain: true } : {}),
          });
          emit.close();
        });
    },
    cancel() {
      closed = true;
      closeController();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no", // disable proxy buffering for live progress
    },
  });
}
