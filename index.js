import { resolve } from 'node:path';

import { Client, GatewayIntentBits, Options } from 'discord.js';

import { createCommandHandler } from './src/commands.js';
import { loadConfig } from './src/config.js';
import { FanClubLeaderboardPublisher } from './src/fanClubLeaderboard.js';
import { GiftListener } from './src/giftListener.js';
import { GiftStore, SAWERIA_RUPIAH_PER_COIN } from './src/giftStore.js';
import { LeaderboardPublisher } from './src/leaderboard.js';
import { logger } from './src/logger.js';
import { applyPresence } from './src/presence.js';
import { RoleManager } from './src/roles.js';
import { SaweriaLeaderboardPublisher } from './src/saweriaLeaderboard.js';
import { parseSaweriaWebhookMessage } from './src/saweriaWebhook.js';
import {
  buildGeneralPanel,
  buildSaweriaPanel,
  buildTiktokPanel,
  GENERAL_PANEL_TITLE,
  SAWERIA_PANEL_TITLE,
  TicketManager,
  TIKTOK_PANEL_TITLE,
} from './src/tickets.js';
import { trackedMessagePublisher } from './src/trackedMessage.js';

const config = loadConfig();

if (config.errors.length > 0) {
  for (const error of config.errors) logger.error(error);
  process.exit(1);
}

const dataDir = resolve(process.cwd(), 'data');
const store = new GiftStore(resolve(dataDir, 'gifts.json'), config.timeZone);
await store.load();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // Bot ini hidup 24/7 di VPS 384MB -- cache pesan/presence dimatikan supaya
  // pemakaian RAM tidak merangkak naik seiring waktu.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
    PresenceManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 300, lifetime: 600 },
  },
});

let listener = null;
let roles = null;
let tickets = null;
let publisher = null;
let fanClubPublisher = null;

const handleCommand = createCommandHandler({
  store,
  config,
  listener: {
    get isLive() {
      return listener?.isLive ?? false;
    },
  },
  roles: {
    get instance() {
      return roles;
    },
  },
  publisher: {
    get instance() {
      return publisher;
    },
  },
  fanClubPublisher: {
    get instance() {
      return fanClubPublisher;
    },
  },
});

client.once('clientReady', async () => {
  logger.info(`Online sebagai ${client.user.tag}`);
  applyPresence(client, config.presence);

  if (!config.guildId) {
    logger.warn('DISCORD_GUILD_ID belum diisi -- hanya mode presence yang aktif.');
    return;
  }

  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    logger.error(`Guild ${config.guildId} tidak ditemukan / bot belum diundang.`);
    return;
  }

  roles = new RoleManager(guild, store);

  if (config.leaderboardEnabled) {
    await roles.ensureRoles().catch((error) => {
      logger.error(`Gagal menyiapkan role (cek permission Manage Roles): ${error.message}`);
    });

    publisher = new LeaderboardPublisher({
      client,
      store,
      channelId: config.leaderboard.channelId,
      topCount: config.leaderboard.topCount,
      username: config.tiktok.username,
    });

    let lastFanClubLogAt = 0;
    listener = new GiftListener({
      username: config.tiktok.username,
      pollSeconds: config.tiktok.livePollSeconds,
      onGift: (gift) => {
        const total = store.recordGift(gift);
        logger.info(
          `Gift dari @${gift.displayId ?? gift.userId}: ${gift.coins} coin (${gift.giftName ?? '-'}), total ${total}`,
        );
      },
      onFanClub: (fanClub) => {
        // DIAGNOSTIK SEMENTARA: belum sempat diverifikasi ke data LIVE
        // sungguhan saat fitur ini ditulis (field user.fansClub ADA di skema
        // proto, tapi belum dilihat langsung terisi data nyata). Dibatasi
        // 1x/menit supaya tidak membanjiri log kalau banyak member fan club
        // aktif chat. Hapus setelah dikonfirmasi di sesi LIVE berikutnya.
        if (Date.now() - lastFanClubLogAt > 60_000) {
          lastFanClubLogAt = Date.now();
          logger.info(
            `[diagnostik fan club] @${fanClub.displayId ?? fanClub.userId}: Lv.${fanClub.level}`,
          );
        }
        store.recordFanClubLevel(fanClub);
      },
      onLiveChange: (isLive) => {
        publisher
          ?.publish(isLive)
          .catch((error) => logger.error(`Gagal memperbarui leaderboard: ${error.message}`));
        if (!isLive) {
          syncAllRoles().catch(() => {});
          fanClubPublisher
            ?.publish()
            .catch((error) =>
              logger.error(`Gagal memperbarui leaderboard fan club: ${error.message}`),
            );
        }
      },
    });
    listener.start();

    const intervalMs = config.leaderboard.updateMinutes * 60_000;
    setInterval(() => {
      if (!listener?.isLive) return;
      publisher
        ?.publish(true)
        .catch((error) => logger.error(`Gagal memperbarui leaderboard: ${error.message}`));
      syncAllRoles().catch((error) => logger.error(`Gagal sinkron role: ${error.message}`));
      fanClubPublisher
        ?.publish()
        .catch((error) => logger.error(`Gagal memperbarui leaderboard fan club: ${error.message}`));
    }, intervalMs).unref?.();

    await publisher
      .publish(false)
      .catch((error) => logger.error(`Gagal memasang leaderboard awal: ${error.message}`));
    logger.info(`Gift leaderboard aktif untuk @${config.tiktok.username}.`);
  }

  if (config.ticketsEnabled) {
    tickets = new TicketManager({
      client,
      store,
      roles,
      config,
      filePath: resolve(dataDir, 'tickets.json'),
    });
    await tickets.load();
    setInterval(
      () => tickets.sweep().catch((error) => logger.error(`Sweep tiket gagal: ${error.message}`)),
      600_000,
    ).unref?.();
    logger.info('Sistem tiket verifikasi aktif.');

    // Pasang/segarkan ketiga panel otomatis tiap start -- aman dipanggil
    // berkali-kali (trackedMessagePublisher cuma edit kalau pesannya sudah
    // ada, tidak pernah bikin duplikat). Channel yang ID-nya belum diisi di
    // .env dilewati diam-diam, bukan error.
    const panelJobs = [
      [config.tickets.tiktokPanelChannelId, 'tiktokPanelMessageId', TIKTOK_PANEL_TITLE, buildTiktokPanel],
      [config.tickets.saweriaPanelChannelId, 'saweriaPanelMessageId', SAWERIA_PANEL_TITLE, buildSaweriaPanel],
      [config.tickets.generalPanelChannelId, 'generalPanelMessageId', GENERAL_PANEL_TITLE, buildGeneralPanel],
    ];
    for (const [channelId, metaKey, embedTitle, build] of panelJobs) {
      if (!channelId) continue;
      await trackedMessagePublisher({ store, metaKey, embedTitle })
        .publishOrEdit(client, channelId, () => build())
        .catch((error) => logger.error(`Gagal memasang panel (${metaKey}): ${error.message}`));
    }
  }

  if (config.saweriaEnabled) {
    new SaweriaLeaderboardPublisher({
      client,
      store,
      streamKey: config.saweria.streamKey,
      channelId: config.saweria.channelId,
      topCount: config.saweria.topCount,
    }).start(config.saweria.updateMinutes);
    logger.info(`Saweria leaderboard aktif, refresh tiap ${config.saweria.updateMinutes} menit.`);
  }

  if (config.fanClubEnabled) {
    fanClubPublisher = new FanClubLeaderboardPublisher({
      client,
      store,
      channelId: config.fanClub.channelId,
      topCount: config.fanClub.topCount,
    });
    // Levelnya cuma berubah lewat command moderator (>setfanclublevel/>unverify),
    // bukan diamati terus-menerus -- jadi cukup publish sekali di awal, sisanya
    // diperbarui instan tiap ada perubahan (lihat commands.js), tanpa interval.
    await fanClubPublisher
      .publish()
      .catch((error) => logger.error(`Gagal memasang leaderboard fan club awal: ${error.message}`));
    logger.info('Fan club leaderboard aktif.');
  }
});

async function announceLevelUp(discordId, text) {
  if (!config.levelUpChannelId) return;
  const channel = await client.channels.fetch(config.levelUpChannelId).catch(() => null);
  if (channel?.isTextBased()) {
    await channel.send(`🎉 <@${discordId}> ${text}`).catch(() => {});
  }
}

/** Memberi milestone gift coin & role Fan Club yang baru tercapai ke semua member terverifikasi. */
async function syncAllRoles() {
  if (!roles) return;

  for (const [discordId, link] of store.allLinks()) {
    const totals = store.totalsForLink(link);
    if (totals.allTime > 0) {
      const { granted, failed, memberNotFound } = await roles.syncMilestones(
        discordId,
        totals.allTime,
      );
      if (memberNotFound) {
        logger.warn(`Member ${discordId} tidak ditemukan saat sinkronisasi role berkala.`);
      }
      if (failed.length > 0) {
        logger.error(
          `Gagal memberi role ke ${discordId}: ${failed.map((f) => `${f.name} (${f.reason})`).join(', ')}`,
        );
      }
      if (granted.length > 0) {
        const names = granted.map((m) => `**${m.name}**`).join(', ');
        await announceLevelUp(discordId, `naik tingkat! Role baru: ${names}`);
      }
    }

    // Level Fan Club "efektif" -- hasil observasi otomatis kalau sudah ada,
    // fallback ke klaim manual kalau member itu belum pernah teramati.
    const effectiveLevel = store.effectiveFanClubLevel(link);
    if (effectiveLevel != null) {
      const fanClubResult = await roles.syncFanClubLevel(discordId, effectiveLevel);
      if (fanClubResult.memberNotFound) {
        logger.warn(`Member ${discordId} tidak ditemukan saat sinkronisasi role Fan Club berkala.`);
      }
      if (fanClubResult.failed) {
        logger.error(`Gagal memberi role Fan Club ke ${discordId}: ${fanClubResult.failed}`);
      }
      if (fanClubResult.granted) {
        await announceLevelUp(
          discordId,
          `naik tingkat Fan Club! Role baru: **${fanClubResult.granted.name}**`,
        );
      }
    }
  }
}

client.on('messageCreate', async (message) => {
  // Pesan webhook Discord dari Saweria -- ditangani terpisah dari jalur
  // command/tiket biasa, dan harus lolos SEBELUM filter `message.author.bot`
  // di bawah karena pesan webhook juga dianggap "bot" oleh Discord.
  if (config.saweria.webhookChannelId && message.channelId === config.saweria.webhookChannelId) {
    if (!message.webhookId) {
      logger.warn(
        `Pesan masuk di channel webhook Saweria TAPI bukan dari webhook (author=${message.author?.id}, bot=${message.author?.bot}) -- diabaikan. Kalau ini seharusnya pesan asli dari Saweria, kemungkinan integrasinya tidak lagi memakai Discord webhook.`,
      );
      return;
    }

    const parsed = parseSaweriaWebhookMessage(message.content);
    if (!parsed) {
      logger.warn(
        `Pesan webhook Saweria TIDAK cocok format parser, diabaikan. Isi pesan mentah: ${JSON.stringify(message.content)}`,
      );
      return;
    }

    const result = store.recordSaweriaDonation(parsed);
    if (!result.credited) {
      logger.info(
        result.linked
          ? `Donasi Saweria: Rp${parsed.rupiah} dari "${parsed.donorName}" tercatat, tapi belum cukup buat 1 coin lagi (perlu kelipatan Rp${SAWERIA_RUPIAH_PER_COIN}) -- bakal kekredit begitu totalnya cukup.`
          : `Donasi Saweria: Rp${parsed.rupiah} dari "${parsed.donorName}" (belum ditautkan ke member mana pun, nunggu klaim lewat >verify s / tiket Saweria).`,
      );
      return;
    }

    logger.info(
      `Donasi Saweria: Rp${parsed.rupiah} dari "${parsed.donorName}" -> ${result.deltaCoins > 0 ? '+' : ''}${result.deltaCoins} coin untuk ${result.discordId}.`,
    );

    if (result.deltaCoins > 0 && roles) {
      const { granted } = await roles
        .syncMilestones(result.discordId, result.newTotal)
        .catch(() => ({ granted: [] }));
      if (granted.length > 0) {
        const names = granted.map((m) => `**${m.name}**`).join(', ');
        await announceLevelUp(result.discordId, `naik tingkat! Role baru: ${names}`);
      }
    }

    await publisher
      ?.publish(listener?.isLive ?? false)
      .catch((error) =>
        logger.error(`Gagal memperbarui leaderboard setelah donasi Saweria: ${error.message}`),
      );
    return;
  }

  if (message.author.bot || !message.guild) return;

  try {
    if (await handleCommand(message)) return;
    await tickets?.handleMessage(message);
  } catch (error) {
    logger.error(`Gagal memproses pesan: ${error.message}`);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    await tickets?.handleInteraction(interaction);
  } catch (error) {
    logger.error(`Gagal memproses interaksi: ${error.message}`);
  }
});

client.on('shardDisconnect', (event, shardId) => {
  logger.warn(
    `Shard ${shardId} terputus (code ${event.code}). discord.js akan reconnect otomatis.`,
  );
});

client.on('shardReconnecting', (shardId) => {
  logger.info(`Shard ${shardId} mencoba reconnect...`);
});

client.on('error', (error) => {
  logger.error(`Gateway error: ${error.message}`);
});

async function shutdown(signal) {
  logger.info(`${signal} diterima, menyimpan state sebelum keluar...`);
  try {
    await listener?.stop();
    await store.flush();
    await tickets?.flush();
  } catch (error) {
    logger.error(`Gagal menyimpan saat shutdown: ${error.message}`);
  }
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason?.message ?? reason}`);
});

client.login(config.botToken).catch((error) => {
  logger.error(`Gagal login: ${error.message}`);
  if (/disallowed intents/i.test(error.message)) {
    logger.error(
      'Intent "Message Content" belum diaktifkan. Buka https://discord.com/developers/applications -> pilih aplikasi bot -> Bot -> Privileged Gateway Intents -> nyalakan MESSAGE CONTENT INTENT, lalu jalankan ulang.',
    );
  }
  process.exit(1);
});
