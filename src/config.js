import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const str = (key) => process.env[key]?.trim() || null;

const int = (key, fallback) => {
  const raw = str(key);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const snowflake = (key, errors) => {
  const raw = str(key);
  if (raw === null) return null;
  if (!/^\d{17,20}$/.test(raw)) {
    errors.push(`${key} harus berupa ID Discord (17-20 digit angka), dapat: "${raw}"`);
    return null;
  }
  return raw;
};

export function loadConfig() {
  const errors = [];

  const botToken = str('DISCORD_BOT_TOKEN');
  if (!botToken) errors.push('DISCORD_BOT_TOKEN wajib diisi.');

  const guildId = snowflake('DISCORD_GUILD_ID', errors);
  const tiktokUsername = str('TIKTOK_USERNAME')?.replace(/^@/, '') ?? null;

  const config = {
    botToken,
    guildId,
    presence: {
      text: str('PRESENCE_TEXT'),
      emoji: str('PRESENCE_EMOJI'),
    },
    commandPrefix: str('COMMAND_PREFIX') ?? '>',
    timeZone: str('TIMEZONE') ?? 'Asia/Jakarta',
    tiktok: {
      username: tiktokUsername,
      // Jeda antar percobaan connect saat streamer belum LIVE. Ini murni HTTP
      // check ringan (fetchIsLive), bukan WebSocket, jadi aman di interval pendek.
      livePollSeconds: int('TIKTOK_LIVE_POLL_SECONDS', 60),
    },
    leaderboard: {
      channelId: snowflake('GIFT_LEADERBOARD_CHANNEL_ID', errors),
      updateMinutes: int('LEADERBOARD_UPDATE_MINUTES', 5),
      topCount: int('LEADERBOARD_TOP_COUNT', 10),
    },
    saweria: {
      // Channel terpisah dari gift coin TikTok -- papan sendiri, tanpa role/milestone.
      channelId: snowflake('SAWERIA_LEADERBOARD_CHANNEL_ID', errors),
      streamKey: str('SAWERIA_STREAM_KEY'),
      // Donasi Saweria tidak terikat sesi LIVE, jadi diperbarui terus-menerus --
      // beda dari papan gift coin yang cuma jalan selama LIVE. Interval dibuat
      // terpisah (default lebih jarang) karena ini hit endpoint eksternal asli
      // tiap kali, bukan snapshot data yang sudah ada di memori seperti gift coin.
      // Default dinaikkan dari 15 ke 30 menit (2026-09-30) -- 15 menit terlalu
      // sering memicu 429 dari Cloudflare di endpoint Saweria.
      updateMinutes: int('SAWERIA_UPDATE_MINUTES', 30),
      topCount: int('SAWERIA_TOP_COUNT', 10),
      // Channel terkunci (member biasa tidak boleh kirim pesan) tempat
      // webhook Discord Saweria memposting tiap donasi masuk -- dipakai
      // buat konversi real-time ke coin, terpisah dari leaderboard di atas.
      webhookChannelId: snowflake('SAWERIA_WEBHOOK_CHANNEL_ID', errors),
    },
    fanClub: {
      channelId: snowflake('FANCLUB_LEADERBOARD_CHANNEL_ID', errors),
      topCount: int('FANCLUB_TOP_COUNT', 10),
    },
    tickets: {
      modRoleId: snowflake('MOD_ROLE_ID', errors),
      modNotifyChannelId: snowflake('MOD_NOTIFY_CHANNEL_ID', errors),
      categoryId: snowflake('TICKET_CATEGORY_ID', errors),
      // Discord tidak punya read-receipt yang bisa dibaca bot, jadi tiket tidak
      // bisa ditutup "5 menit setelah dibaca". Fallback: sekian jam setelah
      // moderator memutuskan (atau setelah mod menutup tiket umum).
      closeAfterHours: int('TICKET_CLOSE_AFTER_HOURS', 24),
      // Ketiganya opsional -- panel yang channel ID-nya belum diisi cuma
      // dilewati (tidak dipasang), bukan dianggap error. Dipasang/disegarkan
      // otomatis tiap bot start (lihat index.js), tidak perlu command manual.
      tiktokPanelChannelId: snowflake('VERIFY_TIKTOK_CHANNEL_ID', errors),
      saweriaPanelChannelId: snowflake('VERIFY_SAWERIA_CHANNEL_ID', errors),
      generalPanelChannelId: snowflake('CREATE_TICKET_CHANNEL_ID', errors),
    },
    levelUpChannelId: snowflake('LEVELUP_CHANNEL_ID', errors),
  };

  const leaderboardEnabled = Boolean(
    config.guildId && config.tiktok.username && config.leaderboard.channelId,
  );
  const ticketsEnabled = Boolean(
    config.guildId && config.tickets.modRoleId && config.tickets.modNotifyChannelId,
  );
  const saweriaEnabled = Boolean(config.saweria.channelId && config.saweria.streamKey);
  const fanClubEnabled = Boolean(config.fanClub.channelId);

  return {
    ...config,
    leaderboardEnabled,
    ticketsEnabled,
    saweriaEnabled,
    fanClubEnabled,
    errors,
  };
}
