import "server-only";
import { Zip, ZipDeflate } from "fflate";
import {
  exportPlan,
  manifestText,
  tableAsCsv,
  type ExportTable,
} from "@/server/company/data-export";

/**
 * The export, as a zip the browser can download while it is still being made.
 *
 * Zip rather than tar.gz because of who opens it. This is a product for shops
 * in India, most of them on Windows, where a zip opens by double-clicking and a
 * tarball needs software nobody is going to install in order to send their
 * accountant a year's books.
 *
 * Streamed rather than assembled. Each table is read a page at a time, deflated
 * as it arrives and handed to the response — so what is held at any moment is
 * one page of one table plus whatever the consumer has not yet taken. An export
 * a large business cannot run is an export that fails exactly the person who
 * most needs one.
 *
 * **Back-pressure is real, not decorative.** The compressor produces bytes
 * faster than a shop's connection takes them, and without a brake the whole
 * archive would queue in memory — which is the thing streaming was supposed to
 * avoid. So the writer stops reading pages once more than `HIGH_WATER` chunks
 * are waiting, and resumes when the consumer has drained them.
 */

/** Excel reads a CSV as UTF-8 only if it starts with this. Without it, ₹ is mojibake. */
const BOM = "﻿";

/** Chunks allowed to sit unread before the writer pauses. */
const HIGH_WATER = 32;

export type ArchiveParams = {
  companyId: string;
  businessName: string;
  generatedAt?: Date;
  /** Injected by the tests; production uses the whole plan. */
  tables?: readonly ExportTable[];
};

export function exportArchiveStream(
  params: ArchiveParams,
): ReadableStream<Uint8Array> {
  const tables = params.tables ?? exportPlan();
  const generatedAt = params.generatedAt ?? new Date();
  const encoder = new TextEncoder();

  const pending: Uint8Array[] = [];
  let finished = false;
  let failure: Error | null = null;

  // Two rendezvous points, so neither side ever spins: the reader waits here
  // for bytes to exist, the writer waits here for the queue to empty.
  let wakeReader: (() => void) | null = null;
  let wakeWriter: (() => void) | null = null;

  const readerWaits = () =>
    new Promise<void>((resolve) => {
      wakeReader = resolve;
    });
  const writerWaits = () =>
    new Promise<void>((resolve) => {
      wakeWriter = resolve;
    });

  const produced = () => {
    const wake = wakeReader;
    wakeReader = null;
    wake?.();
  };
  const consumed = () => {
    const wake = wakeWriter;
    wakeWriter = null;
    wake?.();
  };

  const zip = new Zip((error, data, final) => {
    if (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      produced();
      return;
    }
    if (data.length > 0) pending.push(data);
    if (final) finished = true;
    produced();
  });

  /** Hold here while the consumer is behind. */
  async function breathe(): Promise<void> {
    while (pending.length >= HIGH_WATER && !failure) {
      await writerWaits();
    }
  }

  async function writeEverything(): Promise<void> {
    const manifest = new ZipDeflate("MANIFEST.txt", { level: 6 });
    zip.add(manifest);
    manifest.push(
      encoder.encode(
        manifestText({
          businessName: params.businessName,
          generatedAt,
          tables,
        }),
      ),
      true,
    );

    for (const table of tables) {
      const file = new ZipDeflate(table.file, { level: 6 });
      zip.add(file);
      // The byte-order mark leads every file, for the same reason the report
      // export writes one: without it a rupee sign arrives as mojibake on the
      // Windows machines these are opened on.
      file.push(encoder.encode(BOM), false);

      for await (const chunk of tableAsCsv(
        table.model,
        table.fields,
        params.companyId,
      )) {
        if (failure) return;
        file.push(encoder.encode(chunk), false);
        await breathe();
      }
      file.push(new Uint8Array(0), true);
    }

    zip.end();
  }

  return new ReadableStream<Uint8Array>({
    start() {
      void writeEverything().catch((error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error));
        produced();
      });
    },
    async pull(controller) {
      for (;;) {
        if (failure) {
          controller.error(failure);
          return;
        }
        const next = pending.shift();
        if (next) {
          // Room again, if the writer was holding.
          if (pending.length < HIGH_WATER) consumed();
          controller.enqueue(next);
          return;
        }
        if (finished) {
          controller.close();
          return;
        }
        await readerWaits();
      }
    },
    cancel() {
      // The download was abandoned. Let the writer fall out of its loop rather
      // than read the rest of somebody's ledger into a queue nobody will take.
      failure = new Error("The export was cancelled.");
      consumed();
    },
  });
}

/** `sharma-provision-store-2026-08-15.zip` */
export function archiveFilename(businessName: string, on: Date): string {
  const slug =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "business";
  return `${slug}-${on.toISOString().slice(0, 10)}.zip`;
}
