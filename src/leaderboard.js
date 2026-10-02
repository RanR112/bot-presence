import { EmbedBuilder } from 'discord.js';

import { trackedMessagePublisher } from './trackedMessage.js';

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
  #tracker;

  constructor({ client, store, channelId, topCount, username }) {
    this.#client = client;
    this.#store = store;
    this.#channelId = channelId;
    this.#topCount = topCount;
    this.#username = username;
    this.#tracker = trackedMessagePublisher({
      store,
      metaKey: 'leaderboardMessageId',
      embedTitle: `🎁 Gift Leaderboard @${username}`,
    });
  }

  publish(isLive) {
    // buildPayload dipanggil DI DALAM antrean tracker, bukan di sini -- jadi
    // kalau ada publish() lain yang masih menunggu giliran, embed ini tetap
    // dibangun dari state store TERBARU saat gilirannya tiba, bukan snapshot
    // basi dari saat publish() ini dipanggil.
    return this.#tracker.publishOrEdit(this.#client, this.#channelId, () => ({
      embeds: [
        buildLeaderboardEmbed(this.#store, {
          topCount: this.#topCount,
          username: this.#username,
          isLive,
        }),
      ],
    }));
  }
}
