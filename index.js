import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ActivityType, Client, GatewayIntentBits } from 'discord.js';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('[ERROR] DISCORD_BOT_TOKEN belum diisi. Set lewat environment variable atau .env.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('clientReady', () => {
  console.log(`[${new Date().toISOString()}] Online sebagai ${client.user.tag}`);

  const statusText = process.env.PRESENCE_TEXT?.trim();
  if (statusText) {
    client.user.setPresence({
      status: 'online',
      activities: [
        {
          name: 'custom',
          type: ActivityType.Custom,
          state: statusText,
          ...(process.env.PRESENCE_EMOJI?.trim()
            ? { emoji: { name: process.env.PRESENCE_EMOJI.trim() } }
            : {}),
        },
      ],
    });
    console.log(`[${new Date().toISOString()}] Status di-set: "${statusText}"`);
  }
});

client.on('shardDisconnect', (event, shardId) => {
  console.warn(`[${new Date().toISOString()}] Shard ${shardId} terputus (code ${event.code}). discord.js akan reconnect otomatis.`);
});

client.on('shardReconnecting', (shardId) => {
  console.log(`[${new Date().toISOString()}] Shard ${shardId} mencoba reconnect...`);
});

client.on('error', (error) => {
  console.error(`[${new Date().toISOString()}] Gateway error: ${error.message}`);
});

client.login(token).catch((error) => {
  console.error(`[${new Date().toISOString()}] Gagal login: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection: ${reason?.message ?? reason}`);
});
