import { EmbedBuilder } from 'discord.js';

import { logger } from './logger.js';
import { trackedMessagePublisher } from './trackedMessage.js';

const ENDPOINT = 'https://backend.saweria.co/widgets/leaderboard/all';
const EMBED_TITLE = '💙 Saweria Leaderboard (All Time)';

/**
 * Nama saja, tanpa nominal -- ini permintaan eksplisit: member tidak boleh
 * bisa membandingkan selisih donasi satu sama lain, cuma tahu urutannya.
 */
export async function fetchDonatorNames(streamKey) {
  const url = `${ENDPOINT}?stream_key=${encodeURIComponent(streamKey)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

  if (response.status === 429) {
    // Endpoint publik Saweria membatasi jumlah request -- ini bukan bug, dan
    // siklus polling berikutnya (setelah SAWERIA_UPDATE_MINUTES) otomatis
    // coba lagi, jadi tidak perlu retry manual di sini.
    throw new Error('Saweria merespons 429 (rate limit) -- akan dicoba lagi di siklus berikutnya');
  }

  if (!response.ok) {
    throw new Error(`Saweria merespons ${response.status}`);
  }

  const body = await response.json();
  const entries = Array.isArray(body?.data) ? body.data : [];
  return entries.map((entry) => entry.donator || 'Anonim');
}

function buildEmbed(names) {
  const MEDALS = ['🥇', '🥈', '🥉'];
  const list =
    names.length > 0
      ? names
          .map((name, index) => {
            const rank = MEDALS[index] ?? `\`${String(index + 1).padStart(2, ' ')}.\``;
            return `${rank} **${name}**`;
          })
          .join('\n')
      : '_Belum ada data._';

  return new EmbedBuilder()
    .setTitle(EMBED_TITLE)
    .setColor(0x4a90d9)
    .setDescription(list)
    .setFooter({ text: 'Nominal donasi disembunyikan -- hanya urutan yang ditampilkan.' })
    .setTimestamp(new Date());
}

export class SaweriaLeaderboardPublisher {
  #client;
  #store;
  #streamKey;
  #channelId;
  #topCount;
  #tracker;

  constructor({ client, store, streamKey, channelId, topCount }) {
    this.#client = client;
    this.#store = store;
    this.#streamKey = streamKey;
    this.#channelId = channelId;
    this.#topCount = topCount;
    this.#tracker = trackedMessagePublisher({
      store,
      metaKey: 'saweriaLeaderboardMessageId',
      embedTitle: EMBED_TITLE,
    });
  }

  publish() {
    // fetchDonatorNames dipanggil DI DALAM antrean tracker -- kalau ada
    // publish() lain yang masih menunggu giliran, data yang diambil tetap
    // yang paling baru saat gilirannya tiba, bukan snapshot basi.
    return this.#tracker.publishOrEdit(this.#client, this.#channelId, async () => {
      const names = await fetchDonatorNames(this.#streamKey);
      return { embeds: [buildEmbed(names.slice(0, this.#topCount))] };
    });
  }

  start(intervalMinutes) {
    const run = () =>
      this.publish().catch((error) =>
        logger.error(`Gagal memperbarui Saweria leaderboard: ${error.message}`),
      );
    run();
    const timer = setInterval(run, intervalMinutes * 60_000);
    timer.unref?.();
    return timer;
  }
}
