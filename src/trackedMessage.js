import { logger } from './logger.js';

const UNKNOWN_MESSAGE = 10008;

/**
 * Helper buat pola "satu pesan yang terus di-edit ulang" (leaderboard gift
 * coin & Saweria) -- keduanya sempat mengalami bug yang sama: bot bikin
 * pesan BARU (kadang kosong) padahal pesan lama masih ada, karena dua sebab:
 *
 * 1. `.catch(() => null)` polos pada fetch pesan lama menelan SEMUA jenis
 *    error, bukan cuma "pesan benar-benar dihapus" (kode 10008 / Unknown
 *    Message). Error sementara (rate limit, hiccup jaringan) ikut dianggap
 *    "pesan hilang" -> salah kirim pesan baru.
 * 2. Tidak ada penguncian antar panggilan `publish()` yang tumpang tindih
 *    (mis. interval berkala barengan dengan `onLiveChange` atau command
 *    moderator) -- dua panggilan bisa saling salip baca-lalu-tulis
 *    `messageId`, dan salah satunya bisa membangun payload dari state yang
 *    belum lengkap (makanya "All Time" bisa kelihatan kosong).
 *
 * Diperbaiki dengan: (a) publish diantre berurutan per instance (tidak
 * pernah overlap), (b) cuma kode 10008 asli yang boleh memicu kirim pesan
 * baru -- error lain dicatat dan siklus itu dibatalkan (dicoba lagi nanti),
 * bukan diam-diam bikin duplikat.
 */
export function trackedMessagePublisher({ store, metaKey }) {
  let queue = Promise.resolve();

  function enqueue(task) {
    const next = queue.catch(() => {}).then(task);
    queue = next;
    return next;
  }

  /**
   * @param {import('discord.js').Client} client
   * @param {string} channelId
   * @param {() => Promise<object|null>|object|null} buildPayload Dipanggil DI DALAM antrean (bukan sebelum) supaya payload selalu dibangun dari state terbaru, bukan state saat publish() dipanggil. Balikan `null`/falsy membatalkan publish siklus ini.
   */
  function publishOrEdit(client, channelId, buildPayload) {
    return enqueue(async () => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) {
        logger.warn(`Channel ${channelId} tidak ditemukan / bukan text channel.`);
        return;
      }

      const payload = await buildPayload();
      if (!payload) return;

      const messageId = store.getMeta(metaKey);
      if (messageId) {
        try {
          const existing = await channel.messages.fetch(messageId);
          await existing.edit(payload);
          return;
        } catch (error) {
          if (error?.code !== UNKNOWN_MESSAGE) {
            logger.error(
              `Gagal ambil pesan lama (${metaKey}=${messageId}): ${error.message}. Publish dibatalkan, dicoba lagi siklus berikutnya (bukan bikin pesan baru).`,
            );
            return;
          }
          // 10008 = pesan lama benar-benar sudah tidak ada (dihapus manual) -- lanjut kirim baru.
        }
      }

      const sent = await channel.send(payload);
      store.setMeta(metaKey, sent.id);
    });
  }

  return { publishOrEdit };
}
