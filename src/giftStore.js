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
  ranking(period, limit = 10) {
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
    return entries.slice(0, limit);
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
      milestonesGranted: data.links[discordId]?.milestonesGranted ?? [],
    };
    this.#store.scheduleSave();
    return data.links[discordId];
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

  markMilestonesGranted(discordId, coinValues) {
    const link = this.#store.get().links[discordId];
    if (!link) return;
    const granted = new Set(link.milestonesGranted ?? []);
    for (const value of coinValues) granted.add(value);
    link.milestonesGranted = [...granted].sort((a, b) => a - b);
    this.#store.scheduleSave();
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
