import { logger } from './logger.js';

const UNKNOWN_MESSAGE = 10008;

/**
 * Helper buat pola "satu pesan yang terus di-edit ulang" (leaderboard gift
 * coin, Saweria, fan club) -- sempat mengalami bug yang sama berulang kali:
 * bot bikin pesan BARU (kadang kosong) padahal pesan lama masih ada, karena
 * tiga sebab yang saling menumpuk:
 *
 * 1. `.catch(() => null)` polos pada fetch pesan lama menelan SEMUA jenis
 *    error, bukan cuma "pesan benar-benar dihapus" (kode 10008 / Unknown
 *    Message). Error sementara (rate limit, hiccup jaringan) ikut dianggap
 *    "pesan hilang" -> salah kirim pesan baru. [DIPERBAIKI]
 * 2. Tidak ada penguncian antar panggilan `publish()` yang tumpang tindih
 *    DALAM SATU PROSES (mis. interval berkala barengan dengan `onLiveChange`
 *    atau command moderator). [DIPERBAIKI lewat antrean `enqueue` di bawah]
 * 3. Penguncian #2 TIDAK melindungi dari race LINTAS PROSES -- kalau ada dua
 *    instance proses Node yang kebetulan jalan bersamaan (mis. restart PM2
 *    yang gagal mematikan proses lama sebelum yang baru jalan), masing-masing
 *    proses punya antrean sendiri-sendiri di memori, jadi tetap bisa saling
 *    salip. [DIPERBAIKI lewat `findAdoptableMessage` di bawah: sebelum benar2
 *    kirim pesan baru, scan dulu histori channel -- kalau bot SUDAH PERNAH
 *    kirim pesan dengan judul embed yang sama di situ, "adopsi" pesan itu
 *    (edit + simpan ID-nya) alih-alih kirim duplikat. Ini berbasis STATE
 *    DISCORD YANG SEBENARNYA, bukan memori/file lokal, jadi tetap benar
 *    walau ada banyak proses yang kebetulan jalan bersamaan.]
 */
export function trackedMessagePublisher({ store, metaKey, embedTitle }) {
  let queue = Promise.resolve();

  function enqueue(task) {
    const next = queue.catch(() => {}).then(task);
    queue = next;
    return next;
  }

  async function findAdoptableMessage(channel, client) {
    if (!embedTitle) return null;
    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      return (
        recent.find((m) => m.author.id === client.user.id && m.embeds[0]?.title === embedTitle) ??
        null
      );
    } catch (error) {
      logger.warn(`Gagal scan histori channel buat cari pesan lama: ${error.message}`);
      return null;
    }
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

      // Sebelum benar-benar kirim pesan baru, cek dulu apakah bot SUDAH
      // PERNAH kirim pesan serupa di channel ini (mis. karena proses lain
      // yang jalan bersamaan sudah membuatnya, atau messageId tersimpan
      // hilang/basi) -- adopsi itu alih-alih bikin duplikat.
      const adopted = await findAdoptableMessage(channel, client);
      if (adopted) {
        await adopted.edit(payload);
        store.setMeta(metaKey, adopted.id);
        return;
      }

      const sent = await channel.send(payload);
      store.setMeta(metaKey, sent.id);
    });
  }

  return { publishOrEdit };
}
