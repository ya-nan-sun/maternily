// The device queue: encrypted at rest, ordered, and loss-free when the
// connection drops in the middle of an upload.

import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../shared/messages.ts";
import { Outbox } from "../web/src/device/outbox.ts";
import { Vault, deriveKey, memoryBackend } from "../web/src/device/vault.ts";

const msg = (id: string, text: string): InboundMessage => ({ id, midwifeId: "sf-001", kind: "text", text, capturedAt: new Date().toISOString() });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("offline outbox", () => {
  it("stores messages encrypted and never in plaintext", async () => {
    const backend = memoryBackend();
    const vault = new Vault(await deriveKey("1234", "sf-001"), backend);
    const outbox = new Outbox(vault, async () => {});
    await outbox.add(msg("m1", "fiche 2026-823-001 TA 11/7"), "text");
    const bytes = [...backend.raw.values()].map((v) => new TextDecoder("latin1").decode(v.data)).join("");
    expect(bytes).not.toContain("2026-823-001");
    expect(outbox.list()[0].state).toBe("PENDING_AI");

    // Wrong PIN cannot read it back.
    const wrong = new Vault(await deriveKey("0000", "sf-001"), backend);
    await expect(wrong.get("outbox:m1")).rejects.toThrow();
  });

  it("keeps everything queued offline, survives a drop mid-upload, and delivers in order", async () => {
    const vault = new Vault(await deriveKey("1234", "sf-001"), memoryBackend());
    const received: string[] = [];
    let hang = true;
    const transport = (m: InboundMessage, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (m.id === "m2" && hang) {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          return; // never completes while the network is "slow"
        }
        received.push(m.id);
        resolve();
      });
    const outbox = new Outbox(vault, transport, 10);

    for (const id of ["m1", "m2", "m3"]) await outbox.add(msg(id, id), id);
    expect(outbox.list().map((i) => i.state)).toEqual(["PENDING_AI", "PENDING_AI", "PENDING_AI"]);

    outbox.setOnline(true);
    await tick(20);
    expect(received).toEqual(["m1"]);
    expect(outbox.uploadingId).toBe("m2");

    outbox.setOnline(false); // connection drops during m2's upload
    await tick(20);
    expect(outbox.list().map((i) => i.state)).toEqual(["DELIVERED", "SYNC_FAILED", "PENDING_AI"]);

    hang = false;
    outbox.setOnline(true);
    await tick(50);
    expect(received).toEqual(["m1", "m2", "m3"]);
    expect(outbox.list().every((i) => i.state === "DELIVERED")).toBe(true);
    expect(outbox.list()[1].log.map((l) => l.to)).toEqual(["CAPTURED", "PENDING_AI", "SYNC_FAILED", "PENDING_AI", "DELIVERED"]);

    // A reload (app restart) restores the queue from encrypted storage.
    const reloaded = new Outbox(vault, transport);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(3);
  });

  it("drops the local photo once the server registered the record", async () => {
    const vault = new Vault(await deriveKey("1234", "sf-001"), memoryBackend());
    const outbox = new Outbox(vault, async () => {});
    outbox.setOnline(true);
    await outbox.add({ ...msg("p1", ""), kind: "image", image: { data: "AAAA", mime: "image/png" } }, "photo");
    await tick();
    await outbox.markSynced(["p1"]);
    const item = await vault.get<{ state: string; message: InboundMessage }>("outbox:p1");
    expect(item?.state).toBe("SYNCED");
    expect(item?.message.image).toBeUndefined();
  });
});
