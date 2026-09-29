import { ActivityType } from 'discord.js';

import { logger } from './logger.js';

export function applyPresence(client, { text, emoji }) {
  if (!text) return;

  client.user.setPresence({
    status: 'online',
    activities: [
      {
        name: 'custom',
        type: ActivityType.Custom,
        state: text,
        ...(emoji ? { emoji: { name: emoji } } : {}),
      },
    ],
  });
  logger.info(`Status di-set: "${text}"`);
}
