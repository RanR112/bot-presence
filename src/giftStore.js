import { JsonStore } from './jsonStore.js';
import { periodKeys } from './time.js';

const DEFAULTS = {
  users: {},
  links: {},
  roleIds: {},
  meta: {},
};

const emptyBucket = () => ({ key: null, total: 0 });

/** Bucket yang kuncinya sudah basi dianggap nol -- ini yang bikin rollover harian jalan. */
const bucketValue = (bucket, currentKey) =>
  bucket && bucket.key === currentKey ? bucket.total : 0;

function addToBucket(bucket, currentKey, coins) {
  if (bucket.key !== currentKey) {
    bucket.key = currentKey;
    bucket.total = 0;
  }
  bucket.total += coins;
}

const emptyUser = () => ({
  displayId: null,
  nickname: null,
  allTime: 0,
  day: emptyBucket(),
  month: emptyBucket(),
  year: emptyBucket(),
  lastSeenAt: null,
});

/** Kunci sementara buat kredit manual sebelum userId numerik TikTok diketahui. */
const manualKey = (displayId) => `manual:${displayId.toLowerCase()}`;

export class GiftStore {
  #store;
  #timeZone;

  constructor(filePath, timeZone) {
    this.#store = new JsonStore(filePath, DEFAULTS);
    this.#timeZone = timeZone;
  }

  async load() {
    await this.#store.load();
    const data = this.#store.get();
    data.users ??= {};
    data.links ??= {};
    data.roleIds ??= {};
    data.meta ??= {};
    return this;
  }

  flush() {
    return this.#store.flush();
  }

  #keys() {
    return periodKeys(this.#timeZone);
  }

  recordGift({ userId, displayId, nickname, coins }) {
    if (!userId || !Number.isFinite(coins) || coins <= 0) return null;

    const data = this.#store.get();
    const keys = this.#keys();

    // Gabungkan kredit manual (klaim histori lewat `>addcoin`, dicatat sebelum
    // userId numerik TikTok diketahui) begitu userId aslinya pertama kali
    // terlihat lewat event gift sungguhan -- supaya totalnya tidak kepecah
    // jadi dua entri terpisah selamanya.
    if (displayId) {
      const pendingKey = manualKey(displayId);
      const pending = data.users[pendingKey];
      if (pending && pendingKey !== userId) {
        const target = (data.users[userId] ??= emptyUser());
        target.allTime += pending.allTime;
        delete data.users[pendingKey];
      }
    }

    const user = (data.users[userId] ??= emptyUser());

    if (displayId) user.displayId = displayId;
    if (nickname) user.nickname = nickname;
    user.allTime += coins;
    addToBucket(user.day, keys.day, coins);
    addToBucket(user.month, keys.month, coins);
    addToBucket(user.year, keys.year, coins);
    user.lastSeenAt = new Date().toISOString();

    // Member yang sudah verifikasi sebelum pernah gift baru dapat tiktokUserId
    // di sini. Setelah terisi, pencocokan pakai ID -- kebal ganti username.
    if (displayId) {
      const link = this.#findLinkByDisplayId(displayId);
      if (link && !link.entry.tiktokUserId) {
        link.entry.tiktokUserId = userId;
      }
    }

    this.#store.scheduleSave();
    return user.allTime;
  }

  totalsFor(userId) {
    const user = this.#store.get().users[userId];
    if (!user) return { day: 0, month: 0, year: 0, allTime: 0 };
    const keys = this.#keys();
    return {
      day: bucketValue(user.day, keys.day),
      month: bucketValue(user.month, keys.month),
      year: bucketValue(user.year, keys.year),
      allTime: user.allTime ?? 0,
    };
  }

  /** @param {'day'|'month'|'year'|'allTime'} period */
  #allRanked(period) {
    const keys = this.#keys();
    const entries = [];

    for (const [userId, user] of Object.entries(this.#store.get().users)) {
      const total =
        period === 'allTime' ? (user.allTime ?? 0) : bucketValue(user[period], keys[period]);
      if (total > 0) {
        entries.push({
          userId,
          displayId: user.displayId,
          nickname: user.nickname,
          total,
        });
      }
    }

    entries.sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId));
    return entries;
  }

  /** @param {'day'|'month'|'year'|'allTime'} period */
  ranking(period, limit = 10) {
    return this.#allRanked(period).slice(0, limit);
  }

  /**
   * Posisi member di papan peringkat (1-based), dipakai `>rank`. Balik null
   * kalau member belum terverifikasi atau belum punya coin sama sekali di
   * periode itu (tidak masuk papan).
   *
   * @param {string} discordId
   * @param {'day'|'month'|'year'|'allTime'} [period]
   */
  rankPositionForDiscordId(discordId, period = 'allTime') {
    const link = this.#store.get().links[discordId];
    if (!link) return null;

    const userId = this.#resolvedUserIdFor(link) ?? manualKey(link.displayId ?? '');
    const ranked = this.#allRanked(period);
    const index = ranked.findIndex((entry) => entry.userId === userId);
    if (index === -1) return null;

    return { position: index + 1, total: ranked[index].total, outOf: ranked.length };
  }

  #findLinkByDisplayId(displayId) {
    const needle = displayId.toLowerCase();
    for (const [discordId, entry] of Object.entries(this.#store.get().links)) {
      if (entry.displayId?.toLowerCase() === needle) return { discordId, entry };
    }
    return null;
  }

  linkForDiscordId(discordId) {
    return this.#store.get().links[discordId] ?? null;
  }

  linkForDisplayId(displayId) {
    return this.#findLinkByDisplayId(displayId);
  }

  allLinks() {
    return Object.entries(this.#store.get().links);
  }

  /**
   * Peringkat level Fan Club, diurutkan dari tertinggi. Beda dari `ranking()`
   * (gift coin, dikunci ke userId TikTok numerik): ini dikunci ke discordId
   * karena levelnya memang klaim per-member yang sudah terverifikasi, bukan
   * data yang diamati dari TikTok langsung.
   */
  fanClubRanking(limit = 10) {
    const entries = [];
    for (const [discordId, link] of Object.entries(this.#store.get().links)) {
      if (link.fanClubLevel != null) {
        entries.push({
          discordId,
          displayId: link.displayId,
          realName: link.realName,
          level: link.fanClubLevel,
        });
      }
    }
    entries.sort((a, b) => b.level - a.level || a.discordId.localeCompare(b.discordId));
    return entries.slice(0, limit);
  }

  createLink(discordId, { displayId, realName }) {
    const data = this.#store.get();
    const existing = this.#findLinkByDisplayId(displayId);
    const tiktokUserId =
      existing?.entry.tiktokUserId ?? this.#userIdForDisplayId(displayId) ?? null;

    data.links[discordId] = {
      displayId,
      realName: realName ?? null,
      tiktokUserId,
      linkedAt: new Date().toISOString(),
      fanClubLevel: data.links[discordId]?.fanClubLevel ?? null,
      fanClubRoleId: data.links[discordId]?.fanClubRoleId ?? null,
    };
    this.#store.scheduleSave();
    return data.links[discordId];
  }

  /**
   * Level Fan Club itu klaim manual (member isi di form tiket, opsional,
   * dicek moderator dari screenshot), BUKAN hasil observasi otomatis --
   * makanya di-SET langsung (bukan accumulate seperti coin). Dipanggil dari
   * `>setfanclublevel`.
   */
  setFanClubLevel(discordId, level) {
    const link = this.#store.get().links[discordId];
    if (!link) return null;
    link.fanClubLevel = level;
    this.#store.scheduleSave();
    return link;
  }

  /** Dipanggil RoleManager setelah swap role fan club, supaya tahu role mana yang harus dicabut lain kali. */
  setFanClubRoleId(discordId, roleId) {
    const link = this.#store.get().links[discordId];
    if (!link) return;
    link.fanClubRoleId = roleId;
    this.#store.scheduleSave();
  }

  removeLink(discordId) {
    delete this.#store.get().links[discordId];
    this.#store.scheduleSave();
  }

  #userIdForDisplayId(displayId) {
    const needle = displayId.toLowerCase();
    for (const [userId, user] of Object.entries(this.#store.get().users)) {
      if (user.displayId?.toLowerCase() === needle) return userId;
    }
    return null;
  }

  totalsForLink(link) {
    if (!link) return { day: 0, month: 0, year: 0, allTime: 0 };
    const userId = this.#resolvedUserIdFor(link);
    if (userId) return this.totalsFor(userId);

    // Belum ada userId numerik sama sekali -- tapi mungkin ada kredit manual
    // yang tersimpan di kunci sementara "manual:<displayId>".
    const pending = this.#store.get().users[manualKey(link.displayId ?? '')];
    return pending
      ? { day: 0, month: 0, year: 0, allTime: pending.allTime }
      : { day: 0, month: 0, year: 0, allTime: 0 };
  }

  #resolvedUserIdFor(link) {
    return link.tiktokUserId ?? this.#userIdForDisplayId(link.displayId ?? '');
  }

  /**
   * Kredit coin manual (klaim histori gift SEBELUM bot mulai memantau,
   * direview moderator dari screenshot Riwayat Koin TikTok member). SELALU
   * menambah (increment), tidak pernah menimpa -- dan cuma menambah all-time,
   * bukan bucket hari/bulan/tahun, karena klaim histori bukan aktivitas
   * "hari ini". Dikunci ke userId numerik kalau sudah diketahui, kalau belum
   * dikunci sementara ke displayId dan otomatis digabung nanti (lihat
   * `recordGift`) begitu gift real-time pertama dari akun itu terdeteksi.
   *
   * @returns {number|null} total all-time setelah ditambah, atau null kalau member belum terverifikasi
   */
  addManualCoins(discordId, coins) {
    if (!Number.isFinite(coins) || coins <= 0) return null;

    const data = this.#store.get();
    const link = data.links[discordId];
    if (!link) return null;

    const key = this.#resolvedUserIdFor(link) ?? manualKey(link.displayId);
    const user = (data.users[key] ??= emptyUser());
    if (!user.displayId) user.displayId = link.displayId;
    user.allTime += coins;
    user.lastSeenAt = new Date().toISOString();

    this.#store.scheduleSave();
    return user.allTime;
  }

  /**
   * Kebalikan dari `addManualCoins` -- mengoreksi total yang salah/curang ke
   * bawah. Cuma menyentuh all-time (sama seperti addManualCoins), dan tidak
   * pernah minus (di-floor ke 0). Method ini cuma mengoreksi ANGKA -- role
   * TIDAK otomatis ikut turun di sini; pemanggil (lihat `>reducecoin` di
   * commands.js) yang bertanggung jawab memanggil `RoleManager.syncMilestones`
   * lagi setelah ini supaya role ikut disesuaikan ke tingkat yang benar.
   *
   * @returns {number|null} total all-time setelah dikurangi, atau null kalau member belum terverifikasi / belum punya coin sama sekali
   */
  reduceManualCoins(discordId, coins) {
    if (!Number.isFinite(coins) || coins <= 0) return null;

    const data = this.#store.get();
    const link = data.links[discordId];
    if (!link) return null;

    const key = this.#resolvedUserIdFor(link) ?? manualKey(link.displayId);
    const user = data.users[key];
    if (!user) return null;

    user.allTime = Math.max(0, user.allTime - coins);
    user.lastSeenAt = new Date().toISOString();

    this.#store.scheduleSave();
    return user.allTime;
  }

  getRoleId(name) {
    return this.#store.get().roleIds[name] ?? null;
  }

  setRoleId(name, id) {
    this.#store.get().roleIds[name] = id;
    this.#store.scheduleSave();
  }

  getMeta(key) {
    return this.#store.get().meta[key] ?? null;
  }

  setMeta(key, value) {
    this.#store.get().meta[key] = value;
    this.#store.scheduleSave();
  }
}
