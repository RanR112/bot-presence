import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

import { buildLeaderboardEmbed } from './leaderboard.js';
import { MILESTONES } from './roles.js';
import { buildPanel } from './tickets.js';

const formatCoins = (value) => new Intl.NumberFormat('id-ID').format(value);

function levelEmbed(user, link, totals) {
  if (!link) {
    return new EmbedBuilder()
      .setColor(0xfaa61a)
      .setTitle('Belum terverifikasi')
      .setDescription(
        'Akun TikTok kamu belum ditautkan. Klik tombol verifikasi di channel info untuk mulai klaim role.',
      );
  }

  const reached = MILESTONES.filter((m) => totals.allTime >= m.coins);
  const next = MILESTONES.find((m) => totals.allTime < m.coins);
  const current = reached.at(-1);

  return new EmbedBuilder()
    .setColor(current?.color ?? 0x5865f2)
    .setTitle(`Level ${user.username}`)
    .setDescription(`Akun TikTok tertaut: **@${link.displayId}**`)
    .addFields(
      {
        name: 'Tingkat saat ini',
        value: current ? current.name : 'Belum ada',
        inline: true,
      },
      {
        name: 'Total coin (all time)',
        value: formatCoins(totals.allTime),
        inline: true,
      },
      { name: 'Hari ini', value: formatCoins(totals.day), inline: true },
      { name: 'Bulan ini', value: formatCoins(totals.month), inline: true },
      { name: 'Tahun ini', value: formatCoins(totals.year), inline: true },
      {
        name: 'Tingkat berikutnya',
        value: next
          ? `${next.name} — kurang ${formatCoins(next.coins - totals.allTime)} coin`
          : 'Sudah di tingkat tertinggi 🎉',
        inline: false,
      },
    );
}

export function createCommandHandler({ store, config, listener }) {
  const prefix = config.commandPrefix;

  return async function handleCommand(message) {
    if (!message.content.startsWith(prefix)) return false;

    const [name] = message.content.slice(prefix.length).trim().split(/\s+/);
    const command = name?.toLowerCase();

    if (command === 'level') {
      const target = message.mentions.users.first() ?? message.author;
      const link = store.linkForDiscordId(target.id);
      const totals = store.totalsForLink(link);
      await message.reply({ embeds: [levelEmbed(target, link, totals)] });
      return true;
    }

    if (command === 'leaderboard' || command === 'lb') {
      const embed = buildLeaderboardEmbed(store, {
        topCount: config.leaderboard.topCount,
        username: config.tiktok.username,
        isLive: listener?.isLive ?? false,
      });
      await message.reply({ embeds: [embed] });
      return true;
    }

    if (command === 'setup-verify') {
      if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await message.reply('Perintah ini hanya untuk admin.');
        return true;
      }
      await message.channel.send(buildPanel());
      await message.delete().catch(() => {});
      return true;
    }

    if (command === 'help') {
      await message.reply(
        [
          `\`${prefix}level [@member]\` — lihat total coin dan tingkat role`,
          `\`${prefix}leaderboard\` — tampilkan papan peringkat gift`,
          `\`${prefix}setup-verify\` — (admin) pasang panel verifikasi di channel ini`,
        ].join('\n'),
      );
      return true;
    }

    return false;
  };
}
