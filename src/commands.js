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
          ? `${next.name} (kurang ${formatCoins(next.coins - totals.allTime)} coin)`
          : 'Sudah di tingkat tertinggi 🎉',
        inline: false,
      },
    );
}

function isModerator(message, config) {
  if (message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(
    config.tickets.modRoleId && message.member?.roles.cache.has(config.tickets.modRoleId),
  );
}

export function createCommandHandler({ store, config, listener, roles }) {
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

    if (command === 'unverify') {
      if (!isModerator(message, config)) {
        await message.reply('Perintah ini hanya untuk moderator.');
        return true;
      }

      // Dibatasi ke channel moderator supaya hasil cari-member dan info akun
      // TikTok yang tertaut tidak nyasar ke channel publik.
      if (
        config.tickets.modNotifyChannelId &&
        message.channelId !== config.tickets.modNotifyChannelId
      ) {
        await message.reply(
          `Perintah ini cuma bisa dipakai di <#${config.tickets.modNotifyChannelId}>.`,
        );
        return true;
      }

      const query = message.content.slice(prefix.length).trim().split(/\s+/).slice(1).join(' ');
      const mentioned = message.mentions.users.first();

      let target = mentioned ?? null;
      if (!target && query) {
        const matches = await message.guild.members.search({ query, limit: 5 }).catch(() => null);

        if (!matches || matches.size === 0) {
          await message.reply(`Tidak ada member dengan username mengandung "${query}".`);
          return true;
        }
        if (matches.size > 1) {
          const list = matches.map((m) => `\`${m.user.username}\` (<@${m.id}>)`).join('\n');
          await message.reply(
            `Ditemukan lebih dari satu member, sebutkan lebih spesifik:\n${list}`,
          );
          return true;
        }
        target = matches.first().user;
      }

      if (!target) {
        await message.reply(
          `Format: \`${prefix}unverify <username_discord>\` atau \`${prefix}unverify @member\``,
        );
        return true;
      }

      const link = store.linkForDiscordId(target.id);
      if (!link) {
        await message.reply(`**${target.username}** (<@${target.id}>) belum terverifikasi.`);
        return true;
      }

      await roles?.instance?.revokeAllRoles(target.id);
      store.removeLink(target.id);

      await message.reply(
        `Verifikasi **${target.username}** (<@${target.id}>, akun TikTok @${link.displayId}) sudah dicabut, beserta semua role milestone/top gifter yang menempel. Datanya perlu klaim ulang dari awal kalau mau diverifikasi lagi.`,
      );
      return true;
    }

    if (command === 'help') {
      const lines = [
        `\`${prefix}level [@member]\`: lihat total coin dan tingkat role`,
        `\`${prefix}leaderboard\`: tampilkan papan peringkat gift`,
      ];
      if (message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        lines.push(`\`${prefix}setup-verify\`: (admin) pasang panel verifikasi di channel ini`);
      }
      if (isModerator(message, config)) {
        lines.push(
          `\`${prefix}unverify <username|@member>\`: (moderator) cabut verifikasi dan semua role member`,
        );
      }
      await message.reply(lines.join('\n'));
      return true;
    }

    return false;
  };
}
