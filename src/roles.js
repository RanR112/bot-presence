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

// Ungu -- sengaja beda dari palet logam/permata milestone gift coin di atas,
// supaya kedua sistem role tidak tertukar secara visual di daftar member.
const FAN_CLUB_COLOR = 0x9b59b6;

/** Level Fan Club dikelompokkan kelipatan 5 (Lv.5, Lv.10, ...), meniru istilah TikTok sendiri. */
export function fanClubBand(level) {
  if (!Number.isFinite(level) || level < 5) return null;
  return Math.floor(level / 5) * 5;
}

function fanClubRoleDef(band) {
  return { name: `Fan Lv.${band}`, color: FAN_CLUB_COLOR };
}

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
      reason: 'Role milestone dibuat otomatis oleh bot',
    });
    this.#store.setRoleId(name, created.id);
    logger.info(`Role "${name}" dibuat.`);
    return created;
  }

  async ensureRoles() {
    for (const milestone of MILESTONES) await this.#resolveRole(milestone);
  }

  async #fetchMember(discordId) {
    try {
      return await this.#guild.members.fetch(discordId);
    } catch {
      return null;
    }
  }

  /**
   * Menyelaraskan role milestone member ke TEPAT SATU role -- tingkat
   * tertinggi yang sudah dicapai. Beda dari desain awal (permanen, menumpuk):
   * sekarang naik dari Bronze ke Silver berarti Bronze DICABUT dan Silver
   * DIPASANG, bukan keduanya menempel sekaligus. Kalau member melompat
   * beberapa tingkat sekaligus (mis. lewat `>addcoin` jumlah besar), yang
   * dipasang cuma tingkat tertinggi -- tingkat yang dilewati di tengah tidak
   * pernah benar-benar dipasang jadi tidak perlu dicabut lagi.
   *
   * Status "role apa yang sedang dipegang" dibaca langsung dari Discord
   * (`member.roles.cache`), bukan dari state kita sendiri -- jadi otomatis
   * konsisten walau sebelumnya sempat salah/menumpuk karena bug.
   *
   * @returns {Promise<{ granted: Array<{coins: number, name: string}>, failed: Array<{name: string, reason: string}>, memberNotFound: boolean }>}
   */
  async syncMilestones(discordId, allTimeCoins) {
    const link = this.#store.linkForDiscordId(discordId);
    if (!link) return { granted: [], failed: [], memberNotFound: false };

    const target = MILESTONES.filter((m) => allTimeCoins >= m.coins).at(-1) ?? null;
    if (!target) return { granted: [], failed: [], memberNotFound: false };

    const member = await this.#fetchMember(discordId);
    if (!member) {
      logger.error(
        `syncMilestones: member ${discordId} tidak ditemukan di guild -- seharusnya di tingkat ${target.name}.`,
      );
      return { granted: [], failed: [], memberNotFound: true };
    }

    const failed = [];
    let justGranted = false;

    for (const milestone of MILESTONES) {
      const role = await this.#resolveRole(milestone);
      const isTarget = milestone.coins === target.coins;
      const hasRole = member.roles.cache.has(role.id);

      if (isTarget && !hasRole) {
        try {
          await member.roles.add(role, `Naik ke tingkat ${target.name} (${allTimeCoins} coin)`);
          justGranted = true;
        } catch (error) {
          logger.error(`Gagal memberi role ${target.name} ke ${discordId}: ${error.message}`);
          failed.push({ name: target.name, reason: error.message });
        }
        continue;
      }
      if (!isTarget && hasRole) {
        await member.roles
          .remove(role, `Naik ke tingkat ${target.name}, role lama dicabut`)
          .catch((error) =>
            logger.error(
              `Gagal mencabut role ${milestone.name} dari ${discordId}: ${error.message}`,
            ),
          );
      }
    }

    return { granted: justGranted ? [target] : [], failed, memberNotFound: false };
  }

  /**
   * Menyelaraskan role Fan Club member ke TEPAT SATU role, sama seperti
   * `syncMilestones` -- tapi levelnya klaim manual (diset moderator lewat
   * `>setfanclublevel`), bukan diamati otomatis, jadi tidak ada array tetap
   * seperti MILESTONES buat dicek satu-satu. Role lama yang harus dicabut
   * dilacak lewat `link.fanClubRoleId` yang disimpan di store.
   *
   * @returns {Promise<{ granted: {level: number, band: number, name: string}|null, failed: string|null, memberNotFound: boolean }>}
   */
  async syncFanClubLevel(discordId, level) {
    const link = this.#store.linkForDiscordId(discordId);
    if (!link) return { granted: null, failed: null, memberNotFound: false };

    const band = fanClubBand(level);
    if (!band) return { granted: null, failed: null, memberNotFound: false };

    const member = await this.#fetchMember(discordId);
    if (!member) {
      logger.error(
        `syncFanClubLevel: member ${discordId} tidak ditemukan di guild -- seharusnya Fan Lv.${band}.`,
      );
      return { granted: null, failed: null, memberNotFound: true };
    }

    const def = fanClubRoleDef(band);
    const role = await this.#resolveRole(def);

    if (role.id === link.fanClubRoleId && member.roles.cache.has(role.id)) {
      return { granted: null, failed: null, memberNotFound: false };
    }

    if (link.fanClubRoleId && link.fanClubRoleId !== role.id) {
      const oldRole = this.#guild.roles.cache.get(link.fanClubRoleId);
      if (oldRole && member.roles.cache.has(oldRole.id)) {
        await member.roles
          .remove(oldRole, `Level Fan Club diperbarui ke Lv.${band}`)
          .catch((error) =>
            logger.error(`Gagal mencabut role fan club lama dari ${discordId}: ${error.message}`),
          );
      }
    }

    try {
      await member.roles.add(role, `Level Fan Club: ${level} (Lv.${band})`);
    } catch (error) {
      logger.error(`Gagal memberi role ${def.name} ke ${discordId}: ${error.message}`);
      return { granted: null, failed: error.message, memberNotFound: false };
    }

    this.#store.setFanClubRoleId(discordId, role.id);
    return { granted: { level, band, name: def.name }, failed: null, memberNotFound: false };
  }

  /**
   * Mencabut SEMUA role milestone dan role Fan Club dari member yang
   * verifikasinya dibatalkan moderator. Beda dari `syncMilestones`: ini aksi
   * eksplisit sekali jalan, bukan sinkronisasi berkala -- dipakai saat
   * link-nya sendiri dianggap salah/curang, jadi role yang sudah didapat
   * lewat link itu ikut ditarik, bukan dibiarkan menempel.
   */
  async revokeAllRoles(discordId) {
    const member = await this.#fetchMember(discordId);
    if (!member) return;

    for (const milestone of MILESTONES) {
      const role = await this.#resolveRole(milestone).catch(() => null);
      if (role && member.roles.cache.has(role.id)) {
        await member.roles
          .remove(role, 'Verifikasi TikTok dicabut moderator')
          .catch((error) =>
            logger.error(
              `Gagal mencabut role ${milestone.name} dari ${discordId}: ${error.message}`,
            ),
          );
      }
    }

    const link = this.#store.linkForDiscordId(discordId);
    if (link?.fanClubRoleId) {
      const role = this.#guild.roles.cache.get(link.fanClubRoleId);
      if (role && member.roles.cache.has(role.id)) {
        await member.roles
          .remove(role, 'Verifikasi TikTok dicabut moderator')
          .catch((error) =>
            logger.error(`Gagal mencabut role fan club dari ${discordId}: ${error.message}`),
          );
      }
    }
  }
}
