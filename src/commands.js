import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

import { buildLeaderboardEmbed } from './leaderboard.js';
import { logger } from './logger.js';
import { MILESTONES } from './roles.js';
import { buildPanel, INFO_CHANNEL_ID } from './tickets.js';

const SAWERIA_URL = 'https://saweria.co/salmennn';

const formatCoins = (value) => new Intl.NumberFormat('id-ID').format(value);

export function notVerifiedEmbed() {
  return new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle('Belum terverifikasi')
    .setDescription(
      `Akun TikTok kamu belum ditautkan. Klik tombol verifikasi di <#${INFO_CHANNEL_ID}> untuk mulai klaim role.`,
    );
}

/** Tingkat yang sudah tercapai (tertinggi) berdasarkan total all-time. */
export function currentMilestone(allTime) {
  const reached = MILESTONES.filter((m) => allTime >= m.coins);
  return reached.at(-1) ?? null;
}

export function statsEmbed(user, link, totals) {
  if (!link) return notVerifiedEmbed();

  const current = currentMilestone(totals.allTime);
  const next = MILESTONES.find((m) => totals.allTime < m.coins);

  return new EmbedBuilder()
    .setColor(current?.color ?? 0x5865f2)
    .setTitle(`📊 Stats ${user.username}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
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
      {
        name: 'Level Fan Club',
        value: link.fanClubLevel != null ? `Lv.${link.fanClubLevel}` : 'Belum diklaim',
        inline: false,
      },
    );
}

export function rankEmbed(user, link, totals, rankInfo) {
  if (!link) return notVerifiedEmbed();

  const current = currentMilestone(totals.allTime);

  return new EmbedBuilder()
    .setColor(current?.color ?? 0x5865f2)
    .setTitle(`🏆 Rank ${user.username}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      {
        name: '🥇 Rank Coin (All Time)',
        value: rankInfo
          ? `#${rankInfo.position} dari ${rankInfo.outOf} member`
          : 'Belum masuk papan',
        inline: true,
      },
      {
        name: '🎖️ Role Milestone',
        value: current ? current.name : 'Belum ada',
        inline: true,
      },
      {
        name: '💜 Level Fan Club',
        value: link.fanClubLevel != null ? `Lv.${link.fanClubLevel}` : 'Belum diklaim',
        inline: true,
      },
    );
}

export function progressBar(ratio, segments = 10) {
  const clamped = Math.min(1, Math.max(0, ratio));
  const filled = Math.round(clamped * segments);
  return '🟩'.repeat(filled) + '⬜'.repeat(segments - filled);
}

export function milestoneProgressEmbed(user, link, totals) {
  if (!link) return notVerifiedEmbed();

  const total = totals.allTime;
  const reachedIndex = MILESTONES.reduce((acc, m, i) => (total >= m.coins ? i : acc), -1);
  const current = reachedIndex >= 0 ? MILESTONES[reachedIndex] : null;
  const next = MILESTONES[reachedIndex + 1] ?? null;

  const embed = new EmbedBuilder()
    .setColor(current?.color ?? 0x5865f2)
    .setTitle(`📈 Progress Milestone ${user.username}`)
    .setThumbnail(user.displayAvatarURL({ size: 256 }));

  if (!next) {
    embed.setDescription(
      [
        `Tingkat saat ini: **${current.name}**`,
        '',
        `${progressBar(1)} 100%`,
        '',
        '🎉 Sudah di tingkat tertinggi!',
      ].join('\n'),
    );
    return embed;
  }

  const rangeMin = current?.coins ?? 0;
  const ratio = (total - rangeMin) / (next.coins - rangeMin);
  const remaining = next.coins - total;

  embed.setDescription(
    [
      `Tingkat saat ini: **${current ? current.name : 'Belum ada'}**`,
      `Menuju: **${next.name}** (${formatCoins(next.coins)} coin)`,
      '',
      `${progressBar(ratio)} ${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`,
      '',
      `Kurang **${formatCoins(remaining)} coin** lagi.`,
    ].join('\n'),
  );
  return embed;
}

export function saweriaEmbed() {
  return new EmbedBuilder()
    .setColor(0x4a90d9)
    .setTitle('💙 Dukung Lewat Saweria')
    .setDescription(
      [
        'Donasi/support lewat Saweria lebih membantu @desalmen dibanding gift coin di TikTok, karena potongannya lebih kecil sehingga dukunganmu sampai lebih banyak ke creator.',
        '',
        `👉 ${SAWERIA_URL}`,
      ].join('\n'),
    );
}

export function infoEmbed() {
  return new EmbedBuilder()
    .setColor(0x4a90d9)
    .setTitle('📌 Info Komunitas')
    .setDescription(
      `Semua info lengkap (cara klaim role, channel penting, dll) ada di <#${INFO_CHANNEL_ID}>.`,
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

export function createCommandHandler({
  store,
  config,
  listener,
  roles,
  publisher,
  fanClubPublisher,
}) {
  const prefix = config.commandPrefix;

  return async function handleCommand(message) {
    if (!message.content.startsWith(prefix)) return false;

    const [name] = message.content.slice(prefix.length).trim().split(/\s+/);
    const command = name?.toLowerCase();

    if (command === 'stats') {
      const query = message.content.slice(prefix.length).trim().split(/\s+/).slice(1).join(' ');
      const mentioned = message.mentions.users.first();

      let target = message.author;
      if (mentioned) {
        target = mentioned;
      } else if (query) {
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

      const link = store.linkForDiscordId(target.id);
      const totals = store.totalsForLink(link);
      await message.reply({ embeds: [statsEmbed(target, link, totals)] });
      return true;
    }

    if (command === 'rank') {
      const link = store.linkForDiscordId(message.author.id);
      const totals = store.totalsForLink(link);
      const rankInfo = store.rankPositionForDiscordId(message.author.id, 'allTime');
      await message.reply({ embeds: [rankEmbed(message.author, link, totals, rankInfo)] });
      return true;
    }

    if (command === 'milestones') {
      const link = store.linkForDiscordId(message.author.id);
      const totals = store.totalsForLink(link);
      await message.reply({ embeds: [milestoneProgressEmbed(message.author, link, totals)] });
      return true;
    }

    if (command === 'saweria') {
      await message.reply({ embeds: [saweriaEmbed()] });
      return true;
    }

    if (command === 'info') {
      await message.reply({ embeds: [infoEmbed()] });
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

      const hadFanClubLevel = link.fanClubLevel != null;

      await roles?.instance?.revokeAllRoles(target.id);
      store.removeLink(target.id);

      await message.reply(
        `Verifikasi **${target.username}** (<@${target.id}>, akun TikTok @${link.displayId}) sudah dicabut, beserta semua role milestone yang menempel. Datanya perlu klaim ulang dari awal kalau mau diverifikasi lagi.`,
      );

      if (hadFanClubLevel) {
        await fanClubPublisher?.instance
          ?.publish()
          .catch((error) =>
            logger.error(
              `Gagal memperbarui leaderboard fan club setelah unverify: ${error.message}`,
            ),
          );
      }
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
      const syncResult = (await roles?.instance?.syncMilestones(target.id, newTotal)) ?? {
        granted: [],
        failed: [],
        memberNotFound: false,
      };
      const { granted, failed, memberNotFound } = syncResult;

      let reply = `+${formatCoins(amount)} coin histori ditambahkan untuk **${target.username}** (<@${target.id}>, akun TikTok @${link.displayId}). Total all-time sekarang: ${formatCoins(newTotal)}.`;
      if (granted.length > 0) {
        reply += `\nRole baru: ${granted.map((m) => `**${m.name}**`).join(', ')}`;
      }
      if (memberNotFound) {
        reply +=
          '\n⚠️ Member tidak ditemukan di server saat pemberian role dicoba -- role belum diberikan, coba lagi nanti (mis. lewat `>addcoin` dengan jumlah 0 tidak bisa, tunggu member aktif dulu atau hubungi developer).';
      }
      if (failed.length > 0) {
        const list = failed.map((f) => `**${f.name}** (${f.reason})`).join(', ');
        reply += `\n⚠️ Gagal memberi role: ${list}. Kemungkinan role bot ada DI BAWAH role tersebut di pengaturan server -- role bot harus di atas semua role milestone.`;
      }
      await message.reply(reply);

      // Leaderboard tidak menunggu siklus LIVE berikutnya -- kredit manual
      // langsung terlihat di papan saat itu juga.
      await publisher?.instance
        ?.publish(listener?.isLive ?? false)
        .catch((error) =>
          logger.error(`Gagal memperbarui leaderboard setelah addcoin: ${error.message}`),
        );

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

    if (command === 'reducecoin') {
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
          `Format: \`${prefix}reducecoin <username_discord|@member> <jumlah_coin>\``,
        );
        return true;
      }

      const reducecoinQuery = args.slice(0, -1).join(' ');
      const resolved = await resolveTarget({
        guild: message.guild,
        mentions: message.mentions,
        query: reducecoinQuery,
        prefix,
        commandName: 'reducecoin',
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

      const newTotal = store.reduceManualCoins(target.id, amount);
      if (newTotal === null) {
        await message.reply(
          `**${target.username}** (<@${target.id}>) belum punya coin tercatat sama sekali, tidak ada yang bisa dikurangi.`,
        );
        return true;
      }

      // Role harus ikut disinkronkan -- role sekarang selalu merepresentasikan
      // tingkat TERTINGGI SAAT INI, jadi kalau total turun di bawah tingkat
      // yang sedang dipegang, role-nya harus ikut turun (bukan permanen lagi).
      const syncResult = (await roles?.instance?.syncMilestones(target.id, newTotal)) ?? {
        granted: [],
        failed: [],
        memberNotFound: false,
      };

      let reply = `-${formatCoins(amount)} coin dikurangi dari **${target.username}** (<@${target.id}>, akun TikTok @${link.displayId}). Total all-time sekarang: ${formatCoins(newTotal)}.`;
      if (syncResult.granted.length > 0) {
        reply += `\nRole disesuaikan jadi: **${syncResult.granted[0].name}**`;
      }
      if (syncResult.failed.length > 0) {
        reply += `\n⚠️ Gagal menyesuaikan role: ${syncResult.failed.map((f) => f.reason).join(', ')}`;
      }
      await message.reply(reply);

      // Leaderboard tidak menunggu siklus LIVE berikutnya -- koreksi manual
      // langsung terlihat di papan saat itu juga.
      await publisher?.instance
        ?.publish(listener?.isLive ?? false)
        .catch((error) =>
          logger.error(`Gagal memperbarui leaderboard setelah reducecoin: ${error.message}`),
        );
      return true;
    }

    if (command === 'setfanclublevel') {
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
      const levelArg = args.at(-1);
      const level = Number.parseInt(levelArg, 10);
      if (!levelArg || !Number.isFinite(level) || level <= 0) {
        await message.reply(
          `Format: \`${prefix}setfanclublevel <username_discord|@member> <level>\``,
        );
        return true;
      }

      const setfanclublevelQuery = args.slice(0, -1).join(' ');
      const resolved = await resolveTarget({
        guild: message.guild,
        mentions: message.mentions,
        query: setfanclublevelQuery,
        prefix,
        commandName: 'setfanclublevel',
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

      store.setFanClubLevel(target.id, level);
      const syncResult = (await roles?.instance?.syncFanClubLevel(target.id, level)) ?? {
        granted: null,
        failed: null,
        memberNotFound: false,
      };

      let reply = `Level Fan Club **${target.username}** (<@${target.id}>, akun TikTok @${link.displayId}) diset ke **${level}**.`;
      if (syncResult.granted) {
        reply += `\nRole disesuaikan jadi: **${syncResult.granted.name}**`;
      } else if (level < 5) {
        reply += `\n(Belum ada role -- role Fan Club baru mulai dari Lv.5.)`;
      }
      if (syncResult.memberNotFound) {
        reply += `\n⚠️ Member tidak ditemukan di server saat pemberian role dicoba.`;
      }
      if (syncResult.failed) {
        reply += `\n⚠️ Gagal memberi role: ${syncResult.failed}`;
      }
      await message.reply(reply);

      if (syncResult.granted && config.levelUpChannelId) {
        const channel = await message.guild.channels
          .fetch(config.levelUpChannelId)
          .catch(() => null);
        if (channel?.isTextBased()) {
          await channel
            .send(
              `🎉 <@${target.id}> naik tingkat Fan Club! Role baru: **${syncResult.granted.name}**`,
            )
            .catch(() => {});
        }
      }

      // Leaderboard fan club tidak punya interval berkala -- perubahan level
      // langsung terlihat di papan saat itu juga.
      await fanClubPublisher?.instance
        ?.publish()
        .catch((error) => logger.error(`Gagal memperbarui leaderboard fan club: ${error.message}`));
      return true;
    }

    if (command === 'help') {
      const lines = [
        `\`${prefix}stats [username|@member]\`: lihat total coin dan tingkat role (kosongkan buat cek diri sendiri)`,
        `\`${prefix}rank\`: lihat rank coin, role, dan level fan club kamu`,
        `\`${prefix}milestones\`: lihat progress menuju tingkat berikutnya`,
        `\`${prefix}leaderboard\`: tampilkan papan peringkat gift`,
        `\`${prefix}saweria\`: link donasi Saweria`,
        `\`${prefix}info\`: link channel info komunitas`,
      ];
      if (message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
        lines.push(`\`${prefix}setup-verify\`: (admin) pasang panel verifikasi di channel ini`);
      }
      if (isModerator(message, config)) {
        lines.push(
          `\`${prefix}unverify <username|@member>\`: (moderator) cabut verifikasi dan semua role member`,
          `\`${prefix}addcoin <username|@member> <jumlah>\`: (moderator) tambah coin histori member`,
          `\`${prefix}reducecoin <username|@member> <jumlah>\`: (moderator) kurangi coin member (role tidak ikut dicabut)`,
          `\`${prefix}setfanclublevel <username|@member> <level>\`: (moderator) set Level Fan Club member`,
        );
      }
      await message.reply(lines.join('\n'));
      return true;
    }

    return false;
  };
}
