import { EmbedBuilder } from 'discord.js';

import { logger } from './logger.js';

const MEDALS = ['🥇', '🥈', '🥉'];

const formatCoins = (value) => new Intl.NumberFormat('id-ID').format(value);

function renderColumn(entries) {
  if (entries.length === 0) return '_Belum ada data._';

  return entries
    .map((entry, index) => {
      const rank = MEDALS[index] ?? `\`${String(index + 1).padStart(2, ' ')}.\``;
      const name = entry.nickname || entry.displayId || 'Tanpa nama';
      const handle = entry.displayId ? ` (@${entry.displayId})` : '';
      return `${rank} **${name}**${handle}: ${formatCoins(entry.total)}`;
    })
    .join('\n');
}

export function buildLeaderboardEmbed(store, { topCount, username, isLive }) {
  const periods = [
    { key: 'day', label: '📅 Hari Ini' },
    { key: 'month', label: '🗓️ Bulan Ini' },
    { key: 'year', label: '📆 Tahun Ini' },
    { key: 'allTime', label: '🏆 All Time' },
  ];

  const embed = new EmbedBuilder()
    .setTitle(`🎁 Gift Leaderboard @${username}`)
    .setColor(isLive ? 0x4a90d9 : 0x2b2d31)
    .setFooter({
      text: isLive ? 'Sedang LIVE, data diperbarui berkala' : 'Menunggu LIVE berikutnya',
    })
    .setTimestamp(new Date());

  for (const period of periods) {
    embed.addFields({
      name: period.label,
      value: renderColumn(store.ranking(period.key, topCount)),
      inline: false,
    });
  }

  return embed;
}

export class LeaderboardPublisher {
  #client;
  #store;
  #channelId;
  #topCount;
  #username;

  constructor({ client, store, channelId, topCount, username }) {
    this.#client = client;
    this.#store = store;
    this.#channelId = channelId;
    this.#topCount = topCount;
    this.#username = username;
  }

  async publish(isLive) {
    const channel = await this.#client.channels.fetch(this.#channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      logger.warn(`Channel leaderboard ${this.#channelId} tidak ditemukan / bukan text channel.`);
      return;
    }

    const embed = buildLeaderboardEmbed(this.#store, {
      topCount: this.#topCount,
      username: this.#username,
      isLive,
    });

    const messageId = this.#store.getMeta('leaderboardMessageId');
    if (messageId) {
      const existing = await channel.messages.fetch(messageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
      // Pesan lama sudah tidak ada (dihapus manual) -- kirim ulang, jangan diam.
    }

    const sent = await channel.send({ embeds: [embed] });
    this.#store.setMeta('leaderboardMessageId', sent.id);
  }
}
