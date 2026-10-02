import { EmbedBuilder } from 'discord.js';

import { trackedMessagePublisher } from './trackedMessage.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const EMBED_TITLE = '💜 Fan Club Leaderboard';

function renderColumn(entries) {
  if (entries.length === 0) return '_Belum ada data._';

  return entries
    .map((entry, index) => {
      const rank = MEDALS[index] ?? `\`${String(index + 1).padStart(2, ' ')}.\``;
      const name = entry.realName || entry.displayId || 'Tanpa nama';
      return `${rank} **${name}** (@${entry.displayId}): Lv.${entry.level}`;
    })
    .join('\n');
}

export function buildFanClubLeaderboardEmbed(store, { topCount }) {
  return new EmbedBuilder()
    .setTitle(EMBED_TITLE)
    .setColor(0x9b59b6)
    .setDescription(renderColumn(store.fanClubRanking(topCount)))
    .setFooter({ text: 'Level diamati otomatis dari chat/gift/join saat LIVE.' })
    .setTimestamp(new Date());
}

export class FanClubLeaderboardPublisher {
  #client;
  #store;
  #channelId;
  #topCount;
  #tracker;

  constructor({ client, store, channelId, topCount }) {
    this.#client = client;
    this.#store = store;
    this.#channelId = channelId;
    this.#topCount = topCount;
    this.#tracker = trackedMessagePublisher({
      store,
      metaKey: 'fanClubLeaderboardMessageId',
      embedTitle: EMBED_TITLE,
    });
  }

  publish() {
    return this.#tracker.publishOrEdit(this.#client, this.#channelId, () => ({
      embeds: [buildFanClubLeaderboardEmbed(this.#store, { topCount: this.#topCount })],
    }));
  }
}
