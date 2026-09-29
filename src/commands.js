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

/**
 * Cari target lewat mention (kalau ada) atau cari-by-username lewat REST API
 * Discord (tidak butuh intent GuildMembers). Balikan `{ target }` kalau
 * ketemu tepat satu, atau `{ replyText }` kalau perlu dibalas ke user
 * (tidak ketemu / ambigu / query kosong).
 *
 * Menerima `guild`/`mentions`/`query` secara eksplisit (bukan objek Message
 * utuh) supaya pemanggil bebas mengubah `query` (mis. addcoin membuang
 * argumen jumlah dulu) tanpa perlu menyalin objek Message -- properti seperti
 * `guild` itu getter di kelas Message discord.js, jadi tidak ikut ter-copy
 * kalau di-spread (`{ ...message }`), dan itu akan crash saat dipakai.
 */
async function resolveTarget({ guild, mentions, query, prefix, commandName }) {
  const mentioned = mentions.users.first();
  if (mentioned) return { target: mentioned };

  if (!query) {
    return {
      replyText: `Format: \`${prefix}${commandName} <username_discord>\` atau \`${prefix}${commandName} @member\``,
    };
  }

  const matches = await guild.members.search({ query, limit: 5 }).catch(() => null);
  if (!matches || matches.size === 0) {
    return { replyText: `Tidak ada member dengan username mengandung "${query}".` };
  }
  if (matches.size > 1) {
    const list = matches.map((m) => `\`${m.user.username}\` (<@${m.id}>)`).join('\n');
    return { replyText: `Ditemukan lebih dari satu member, sebutkan lebih spesifik:\n${list}` };
  }
  return { target: matches.first().user };
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

      const unverifyQuery = message.content
        .slice(prefix.length)
        .trim()
        .split(/\s+/)
        .slice(1)
        .join(' ');
      const resolved = await resolveTarget({
        guild: message.guild,
        mentions: message.mentions,
        query: unverifyQuery,
        prefix,
        commandName: 'unverify',
      });
      if (!resolved.target) {
        await message.reply(resolved.replyText);
        return true;
      }
      const { target } = resolved;

      const link = store.linkForDiscordId(target.id);
      if (!link) {
        await message.reply(`**${target.username}** (<@${target.id}>) belum terverifikasi.`);
        return true;
      }

      await roles?.instance?.revokeAllRoles(target.id);
      store.removeLink(target.id);

      await message.reply(
        `Verifikasi **${target.username}** (<@${target.id}>, akun TikTok @${link.displayId}) sudah dicabut, beserta semua role milestone yang menempel. Datanya perlu klaim ulang dari awal kalau mau diverifikasi lagi.`,
      );
      return true;
    }

    if (command === 'addcoin') {
      if (!isModerator(message, config)) {
        await message.reply('Perintah ini hanya untuk moderator.');
        return true;
      }

      if (
        config.tickets.modNotifyChannelId &&
        message.channelId !== config.tickets.modNotifyChannelId
      ) {
        await message.reply(
          `Perintah ini cuma bisa dipakai di <#${config.tickets.modNotifyChannelId}>.`,
        );
        return true;
      }

      const args = message.content.slice(prefix.length).trim().split(/\s+/).slice(1);
      const amountArg = args.at(-1);
      const amount = Number.parseInt(amountArg, 10);
      if (!amountArg || !Number.isFinite(amount) || amount <= 0) {
        await message.reply(
          `Format: \`${prefix}addcoin <username_discord|@member> <jumlah_coin>\``,
        );
        return true;
      }

      // args = [<username_atau_mention>, ..., <jumlah>] -- buang elemen
      // terakhir (jumlah) supaya sisanya jadi query pencarian username.
      const addcoinQuery = args.slice(0, -1).join(' ');
      const resolved = await resolveTarget({
        guild: message.guild,
        mentions: message.mentions,
        query: addcoinQuery,
        prefix,
        commandName: 'addcoin',
      });
      if (!resolved.target) {
        await message.reply(resolved.replyText);
        return true;
      }
      const { target } = resolved;

      const link = store.linkForDiscordId(target.id);
      if (!link) {
        await message.reply(
          `**${target.username}** (<@${target.id}>) belum terverifikasi. Verifikasi akun dulu sebelum menambah coin histori.`,
        );
        return true;
      }

      const newTotal = store.addManualCoins(target.id, amount);
      const granted = (await roles?.instance?.syncMilestones(target.id, newTotal)) ?? [];

      let reply = `+${formatCoins(amount)} coin histori ditambahkan untuk **${target.username}** (<@${target.id}>, akun TikTok @${link.displayId}). Total all-time sekarang: ${formatCoins(newTotal)}.`;
      if (granted.length > 0) {
        reply += `\nRole baru: ${granted.map((m) => `**${m.name}**`).join(', ')}`;
      }
      await message.reply(reply);

      if (granted.length > 0 && config.levelUpChannelId) {
        const channel = await message.guild.channels
          .fetch(config.levelUpChannelId)
          .catch(() => null);
        if (channel?.isTextBased()) {
          const names = granted.map((m) => `**${m.name}**`).join(', ');
          await channel
            .send(`🎉 <@${target.id}> naik tingkat! Role baru: ${names}`)
            .catch(() => {});
        }
      }
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
          `\`${prefix}addcoin <username|@member> <jumlah>\`: (moderator) tambah coin histori member`,
        );
      }
      await message.reply(lines.join('\n'));
      return true;
    }

    return false;
  };
}
