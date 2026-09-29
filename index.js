import { resolve } from 'node:path';

import { Client, GatewayIntentBits, Options } from 'discord.js';

import { createCommandHandler } from './src/commands.js';
import { loadConfig } from './src/config.js';
import { GiftListener } from './src/giftListener.js';
import { GiftStore } from './src/giftStore.js';
import { LeaderboardPublisher } from './src/leaderboard.js';
import { logger } from './src/logger.js';
import { applyPresence } from './src/presence.js';
import { RoleManager } from './src/roles.js';
import { SaweriaLeaderboardPublisher } from './src/saweriaLeaderboard.js';
import { TicketManager } from './src/tickets.js';

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

    listener = new GiftListener({
      username: config.tiktok.username,
      pollSeconds: config.tiktok.livePollSeconds,
      onGift: (gift) => {
        const total = store.recordGift(gift);
        logger.info(
          `Gift dari @${gift.displayId ?? gift.userId}: ${gift.coins} coin (${gift.giftName ?? '-'}), total ${total}`,
        );
      },
      onLiveChange: (isLive) => {
        publisher
          ?.publish(isLive)
          .catch((error) => logger.error(`Gagal memperbarui leaderboard: ${error.message}`));
        if (!isLive) syncAllRoles().catch(() => {});
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
});

/** Memberi milestone yang baru tercapai ke semua member terverifikasi, lalu menyegarkan Top 1/2/3. */
async function syncAllRoles() {
  if (!roles) return;

  for (const [discordId, link] of store.allLinks()) {
    const totals = store.totalsForLink(link);
    if (totals.allTime <= 0) continue;

    const granted = await roles.syncMilestones(discordId, totals.allTime);
    if (granted.length > 0 && config.levelUpChannelId) {
      const channel = await client.channels.fetch(config.levelUpChannelId).catch(() => null);
      if (channel?.isTextBased()) {
        const names = granted.map((m) => `**${m.name}**`).join(', ');
        await channel.send(`🎉 <@${discordId}> naik tingkat! Role baru: ${names}`).catch(() => {});
      }
    }
  }

  await roles.syncTopRoles();
}

client.on('messageCreate', async (message) => {
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
