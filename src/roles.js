import { logger } from './logger.js';

export const MILESTONES = [
  { coins: 50, name: 'Bronze Fan', color: 0xcd7f32 },
  { coins: 100, name: 'Silver Fan', color: 0xc0c0c0 },
  { coins: 250, name: 'Gold Fan', color: 0xffd700 },
  { coins: 500, name: 'Platinum Fan', color: 0x7ec8e3 },
  { coins: 1000, name: 'Diamond Fan', color: 0xb9f2ff },
  { coins: 1500, name: 'Emerald Fan', color: 0x50c878 },
  { coins: 3000, name: 'Ruby Fan', color: 0xe0115f },
  { coins: 5000, name: 'Sapphire Fan', color: 0x0f52ba },
  { coins: 10000, name: 'Amethyst Fan', color: 0x9966cc },
];

export const TOP_ROLES = [
  { rank: 1, name: 'Top 1 Gifter', color: 0xffd700 },
  { rank: 2, name: 'Top 2 Gifter', color: 0xc0c0c0 },
  { rank: 3, name: 'Top 3 Gifter', color: 0xcd7f32 },
];

export class RoleManager {
  #guild;
  #store;

  constructor(guild, store) {
    this.#guild = guild;
    this.#store = store;
  }

  async #resolveRole({ name, color }) {
    const cachedId = this.#store.getRoleId(name);
    if (cachedId) {
      const cached = this.#guild.roles.cache.get(cachedId) ?? null;
      if (cached) return cached;
    }

    const byName = this.#guild.roles.cache.find((role) => role.name === name);
    if (byName) {
      this.#store.setRoleId(name, byName.id);
      return byName;
    }

    const created = await this.#guild.roles.create({
      name,
      color,
      reason: 'Role milestone/top gifter dibuat otomatis oleh bot',
    });
    this.#store.setRoleId(name, created.id);
    logger.info(`Role "${name}" dibuat.`);
    return created;
  }

  async ensureRoles() {
    for (const milestone of MILESTONES) await this.#resolveRole(milestone);
    for (const top of TOP_ROLES) await this.#resolveRole(top);
  }

  async #fetchMember(discordId) {
    try {
      return await this.#guild.members.fetch(discordId);
    } catch {
      return null;
    }
  }

  /**
   * Memberi role milestone yang sudah dilewati tapi belum pernah diberikan.
   * Milestone bersifat permanen -- tidak pernah dicabut walau peringkat turun.
   *
   * @returns {Promise<Array<{ coins: number, name: string }>>} milestone yang baru diberikan
   */
  async syncMilestones(discordId, allTimeCoins) {
    const link = this.#store.linkForDiscordId(discordId);
    if (!link) return [];

    const already = new Set(link.milestonesGranted ?? []);
    const earned = MILESTONES.filter((m) => allTimeCoins >= m.coins && !already.has(m.coins));
    if (earned.length === 0) return [];

    const member = await this.#fetchMember(discordId);
    if (!member) return [];

    const granted = [];
    for (const milestone of earned) {
      try {
        const role = await this.#resolveRole(milestone);
        await member.roles.add(role, `Mencapai ${milestone.coins} coin`);
        granted.push(milestone);
      } catch (error) {
        logger.error(`Gagal memberi role ${milestone.name} ke ${discordId}: ${error.message}`);
      }
    }

    if (granted.length > 0) {
      this.#store.markMilestonesGranted(
        discordId,
        granted.map((m) => m.coins),
      );
    }
    return granted;
  }

  /**
   * Menyelaraskan role Top 1/2/3. Beda dari milestone: role ini DICABUT dari
   * pemegang lama begitu peringkatnya tergeser. Pemegang lama dilacak lewat
   * store, bukan lewat cache member Discord, supaya tidak butuh intent
   * GuildMembers yang privileged.
   */
  async syncTopRoles() {
    const ranking = this.#store.ranking('allTime', TOP_ROLES.length);
    const holders = this.#store.getTopHolders();
    const changes = [];

    for (const top of TOP_ROLES) {
      const entry = ranking[top.rank - 1] ?? null;
      const desired = entry ? this.#discordIdForTiktokUser(entry) : null;
      const current = holders[String(top.rank)] ?? null;
      if (desired === current) continue;

      const role = await this.#resolveRole(top).catch(() => null);
      if (!role) continue;

      if (current) {
        const member = await this.#fetchMember(current);
        if (member) {
          await member.roles
            .remove(role, 'Peringkat top gifter bergeser')
            .catch((error) => logger.error(`Gagal mencabut ${top.name}: ${error.message}`));
        }
      }

      if (desired) {
        const member = await this.#fetchMember(desired);
        if (member) {
          await member.roles
            .add(role, `Naik ke peringkat ${top.rank} gifter`)
            .catch((error) => logger.error(`Gagal memberi ${top.name}: ${error.message}`));
        }
      }

      holders[String(top.rank)] = desired;
      changes.push({ rank: top.rank, from: current, to: desired });
    }

    if (changes.length > 0) this.#store.setTopHolders(holders);
    return changes;
  }

  /**
   * Mencabut SEMUA role (milestone + top gifter) dari member yang verifikasinya
   * dibatalkan moderator. Beda dari `syncMilestones`/`syncTopRoles`: ini aksi
   * eksplisit sekali jalan, bukan sinkronisasi berkala -- dipakai saat link-nya
   * sendiri dianggap salah/curang, jadi role yang sudah didapat lewat link itu
   * ikut ditarik, bukan dibiarkan menempel.
   */
  async revokeAllRoles(discordId) {
    const member = await this.#fetchMember(discordId);
    if (!member) return;

    for (const definition of [...MILESTONES, ...TOP_ROLES]) {
      const role = await this.#resolveRole(definition).catch(() => null);
      if (role && member.roles.cache.has(role.id)) {
        await member.roles
          .remove(role, 'Verifikasi TikTok dicabut moderator')
          .catch((error) =>
            logger.error(
              `Gagal mencabut role ${definition.name} dari ${discordId}: ${error.message}`,
            ),
          );
      }
    }

    const holders = this.#store.getTopHolders();
    let changed = false;
    for (const rank of Object.keys(holders)) {
      if (holders[rank] === discordId) {
        holders[rank] = null;
        changed = true;
      }
    }
    if (changed) this.#store.setTopHolders(holders);
  }

  #discordIdForTiktokUser(entry) {
    for (const [discordId, link] of this.#store.allLinks()) {
      if (link.tiktokUserId && link.tiktokUserId === entry.userId) return discordId;
      if (
        !link.tiktokUserId &&
        entry.displayId &&
        link.displayId?.toLowerCase() === entry.displayId.toLowerCase()
      ) {
        return discordId;
      }
    }
    return null;
  }
}
