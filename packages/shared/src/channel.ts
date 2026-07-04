import { z } from "zod";

/**
 * Params event `channel.deliver` yang dikirim hostd -> cc-stub lewat pipe
 * (NDJSON, RpcEvent tanpa id). BUKAN skema payload yang tersimpan di
 * bus_queue (itu hanya `content`+`meta`, lihat hostd/bus/delivery.ts) —
 * `envelope_id` ditambahkan di titik push supaya cc-stub bisa membalas
 * `channel.confirm` yang merujuk envelope yang sama (protokol confirm,
 * bukan lagi ack-on-write).
 */
export const ChannelDeliverEvent = z
  .object({
    envelope_id: z.string().min(1),
    /**
     * Token unik per-attempt (uuid, `crypto.randomUUID()`) yang dibuat ulang
     * setiap kali envelope ini di-push (lihat `markInFlight` di
     * hostd/bus/delivery.ts). Dikirim balik lewat `channel.confirm` supaya
     * hostd bisa membedakan confirm utk attempt INI dari confirm telat yang
     * merujuk attempt SEBELUMNYA pada `envelope_id` yang sama (stale confirm
     * lintas attempt — lihat docstring `confirmDelivery`).
     */
    attempt_token: z.string(),
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  })
  .strict();

export type ChannelDeliverEventT = z.infer<typeof ChannelDeliverEvent>;

/**
 * Params request `channel.confirm {envelope_id, attempt_token}` yang dikirim
 * cc-stub -> hostd setelah notifikasi channel berhasil diteruskan ke Claude
 * Code. hostd hanya meng-ack envelope di bus_queue saat request ini diterima
 * (bukan saat push socket berhasil) — lihat DeliveryDeps/confirmDelivery di
 * hostd/bus/delivery.ts. `attempt_token` HARUS cocok dengan token attempt
 * in-flight yang aktif saat ini; kalau tidak (mis. confirm telat dari attempt
 * yang sudah di-retry), request diperlakukan sbg stale dan diabaikan (return
 * `false`, bukan meng-ack attempt lain yang belum dikonfirmasi).
 */
export const ChannelConfirmParams = z
  .object({
    envelope_id: z.string().min(1),
    attempt_token: z.string(),
  })
  .strict();

export type ChannelConfirmParamsT = z.infer<typeof ChannelConfirmParams>;
