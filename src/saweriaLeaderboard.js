import { EmbedBuilder } from 'discord.js';

import { logger } from './logger.js';

const ENDPOINT = 'https://backend.saweria.co/widgets/leaderboard/all';

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
    .setTitle('💙 Saweria Leaderboard (All Time)')
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

  constructor({ client, store, streamKey, channelId, topCount }) {
    this.#client = client;
    this.#store = store;
    this.#streamKey = streamKey;
    this.#channelId = channelId;
    this.#topCount = topCount;
  }

  async publish() {
    const channel = await this.#client.channels.fetch(this.#channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      logger.warn(
        `Channel Saweria leaderboard ${this.#channelId} tidak ditemukan / bukan text channel.`,
      );
      return;
    }

    const names = await fetchDonatorNames(this.#streamKey);
    const embed = buildEmbed(names.slice(0, this.#topCount));

    const messageId = this.#store.getMeta('saweriaLeaderboardMessageId');
    if (messageId) {
      const existing = await channel.messages.fetch(messageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
      // Pesan lama sudah tidak ada (dihapus manual) -- kirim ulang, jangan diam.
    }

    const sent = await channel.send({ embeds: [embed] });
    this.#store.setMeta('saweriaLeaderboardMessageId', sent.id);
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
