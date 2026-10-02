import { JsonStore } from './jsonStore.js';
import { periodKeys } from './time.js';

const DEFAULTS = {
  users: {},
  links: {},
  roleIds: {},
  meta: {},
  saweriaDonors: {},
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
  fanClubLevel: null,
  fanClubObservedAt: null,
});

/** Kunci sementara buat kredit manual sebelum userId numerik TikTok diketahui. */
const manualKey = (displayId) => `manual:${displayId.toLowerCase()}`;

/** Sama seperti `manualKey`, tapi buat member yang CUMA ditautkan lewat Saweria (belum punya akun TikTok sama sekali). */
const saweriaManualKey = (donorName) => `manual-saweria:${donorName.toLowerCase()}`;

const emptySaweriaDonor = () => ({
  displayName: null,
  totalRupiah: 0,
  creditedCoins: 0,
  lastSeenAt: null,
});

/** Rp per 1 coin TikTok -- dibulatkan dari harga asli Rp207 biar gampang dihitung. */
export const SAWERIA_RUPIAH_PER_COIN = 200;

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
    data.saweriaDonors ??= {};
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

  /**
   * Level Fan Club yang DIAMATI otomatis dari event chat/gift/join (lihat
   * `GiftListener`/`normalizeFanClub`) -- dicatat untuk SIAPA PUN yang
   * levelnya kelihatan di event, terverifikasi atau tidak, persis seperti
   * gift coin. Beda dari coin: ini SET (menimpa), bukan accumulate, karena
   * level adalah snapshot status saat ini, bukan angka kumulatif.
   */
  recordFanClubLevel({ userId, displayId, nickname, level }) {
    if (!userId || !Number.isFinite(level) || level <= 0) return;

    const data = this.#store.get();

    // Sama seperti recordGift: gabungkan record manual (klaim histori lewat
    // kolom opsional di tiket, SEBELUM userId numerik diketahui) begitu
    // userId aslinya pertama kali terlihat.
    if (displayId) {
      const pendingKey = manualKey(displayId);
      const pending = data.users[pendingKey];
      if (pending && pendingKey !== userId) {
        const target = (data.users[userId] ??= emptyUser());
        if (target.allTime === 0) target.allTime = pending.allTime;
        delete data.users[pendingKey];
      }
    }

    const user = (data.users[userId] ??= emptyUser());
    if (displayId) user.displayId = displayId;
    if (nickname) user.nickname = nickname;
    user.fanClubLevel = level;
    user.fanClubObservedAt = new Date().toISOString();

    this.#store.scheduleSave();
  }

  /**
   * Level Fan Club "efektif" buat ditampilkan/role-sync: hasil OBSERVASI
   * otomatis selalu menang kalau sudah ada (lebih baru/akurat), fallback ke
   * klaim MANUAL moderator cuma untuk member yang belum pernah kelihatan
   * chat/gift/join sejak verifikasi (supaya tidak kosong di hari pertama).
   */
  effectiveFanClubLevel(link) {
    if (!link) return null;
    const userId = this.#resolvedUserIdFor(link);
    const observed = userId ? (this.#store.get().users[userId]?.fanClubLevel ?? null) : null;
    return observed ?? link.fanClubLevel ?? null;
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
   * Peringkat level Fan Club, diurutkan dari tertinggi. Sumbernya DUA:
   * (1) hasil observasi otomatis di `users` -- siapa pun, terverifikasi atau
   *     tidak, persis seperti leaderboard gift coin;
   * (2) klaim manual di `links` untuk member terverifikasi yang BELUM pernah
   *     teramati (supaya tidak hilang dari papan di hari pertama sebelum
   *     mereka chat/gift/join lagi saat LIVE dipantau bot).
   * Satu TikTok user cuma boleh muncul sekali -- kalau sudah ada hasil
   * observasi, entri manual untuk akun yang sama tidak ikut ditambahkan.
   */
  fanClubRanking(limit = 10) {
    const data = this.#store.get();
    const entries = [];
    const observedUserIds = new Set();

    for (const [userId, user] of Object.entries(data.users)) {
      if (user.fanClubLevel != null) {
        observedUserIds.add(userId);
        entries.push({
          key: userId,
          displayId: user.displayId,
          realName: user.nickname,
          level: user.fanClubLevel,
        });
      }
    }

    for (const [discordId, link] of Object.entries(data.links)) {
      if (link.fanClubLevel == null) continue;
      const userId = this.#resolvedUserIdFor(link);
      if (userId && observedUserIds.has(userId)) continue; // sudah terwakili lewat observasi
      entries.push({
        key: `link:${discordId}`,
        displayId: link.displayId,
        realName: link.realName,
        level: link.fanClubLevel,
      });
    }

    entries.sort((a, b) => b.level - a.level || a.key.localeCompare(b.key));
    return entries.slice(0, limit);
  }

  createLink(discordId, { displayId, realName }) {
    const data = this.#store.get();
    const existing = this.#findLinkByDisplayId(displayId);
    const tiktokUserId =
      existing?.entry.tiktokUserId ?? this.#userIdForDisplayId(displayId) ?? null;
    const priorLink = data.links[discordId];

    data.links[discordId] = {
      displayId,
      realName: realName ?? null,
      tiktokUserId,
      linkedAt: new Date().toISOString(),
      fanClubLevel: priorLink?.fanClubLevel ?? null,
      fanClubRoleId: priorLink?.fanClubRoleId ?? null,
      saweriaDonorName: priorLink?.saweriaDonorName ?? null,
      saweriaLinkedAt: priorLink?.saweriaLinkedAt ?? null,
    };

    // Kalau member ini sebelumnya sudah ditautkan lewat Saweria (`>verify s`)
    // dan sempat dapat kredit coin manual SEBELUM akun TikTok-nya diketahui,
    // gabungkan ke entri TikTok yang baru ditautkan ini sekarang juga --
    // sama seperti `recordGift` menggabungkan kredit histori TikTok, supaya
    // totalnya tidak kepecah jadi dua "akun" terpisah selamanya.
    if (priorLink?.saweriaDonorName) {
      const pendingKey = saweriaManualKey(priorLink.saweriaDonorName);
      const pending = data.users[pendingKey];
      if (pending && pending.allTime > 0) {
        const targetKey = tiktokUserId ?? manualKey(displayId);
        const target = (data.users[targetKey] ??= emptyUser());
        target.allTime += pending.allTime;
        delete data.users[pendingKey];
      }
    }

    this.#store.scheduleSave();
    return data.links[discordId];
  }

  #findLinkBySaweriaName(name) {
    const needle = name.toLowerCase();
    for (const [discordId, entry] of Object.entries(this.#store.get().links)) {
      if (entry.saweriaDonorName?.toLowerCase() === needle) return { discordId, entry };
    }
    return null;
  }

  /** Versi publik `#findLinkBySaweriaName` -- dipakai tiket Saweria buat cek nama sudah diklaim atau belum SEBELUM bikin channel. */
  linkForSaweriaName(name) {
    return this.#findLinkBySaweriaName(name);
  }

  /** Total rupiah yang sudah tercatat bot buat satu nama donatur (dari webhook), 0 kalau belum pernah ada. */
  saweriaLedgerTotal(donorName) {
    return this.#store.get().saweriaDonors[donorName.toLowerCase()]?.totalRupiah ?? 0;
  }

  /**
   * Catat satu donasi Saweria yang terdeteksi dari pesan webhook (lihat
   * `saweriaWebhook.js`). Diakumulasi ke ledger PER NAMA DONATUR (teks bebas
   * dari Saweria, bukan identitas terverifikasi) -- baru terhubung ke member
   * Discord lewat `>verify s`. Kalau nama ini sudah ditautkan, selisihnya
   * langsung dikonversi (lihat `SAWERIA_RUPIAH_PER_COIN`) dan dikreditkan ke
   * pool coin member itu juga, real-time tiap donasi baru masuk -- tidak
   * perlu moderator menjalankan command lagi tiap kali.
   *
   * @returns {{credited: boolean, discordId?: string, deltaCoins?: number, newTotal?: number|null}}
   */
  recordSaweriaDonation({ donorName, rupiah }) {
    if (!donorName || !Number.isFinite(rupiah) || rupiah <= 0) return { credited: false };

    const data = this.#store.get();
    const key = donorName.toLowerCase();
    const donor = (data.saweriaDonors[key] ??= emptySaweriaDonor());
    donor.displayName = donorName;
    donor.totalRupiah += rupiah;
    donor.lastSeenAt = new Date().toISOString();
    this.#store.scheduleSave();

    // realtime: true -- donasi ini terjadi SAAT INI (webhook baru saja
    // memicu), jadi harus kehitung di bucket hari/bulan/tahun juga, persis
    // seperti gift TikTok real-time lewat `recordGift`.
    return this.#creditSaweriaIfLinked(key, { realtime: true });
  }

  /**
   * Kreditkan selisih coin yang belum dikreditkan buat donatur `key` (nama
   * donatur, huruf kecil) kalau sudah ditautkan ke member -- dipanggil tiap
   * ada donasi baru DAN sekali lagi saat `>verify s` pertama kali menautkan
   * (buat "catch-up" histori rupiah yang sudah terkumpul sebelum ditautkan).
   * `creditedCoins` dipakai sebagai penanda supaya rupiah yang sama tidak
   * pernah dikonversi dua kali.
   *
   * @param {boolean} [options.realtime] - true kalau delta ini dari donasi
   *   yang BARU SAJA terjadi (webhook real-time) -- ikut masuk bucket
   *   hari/bulan/tahun, bukan cuma all-time. false (default) dipakai saat
   *   `>verify s` nge-"catch-up" ledger lama yang terkumpul SEBELUM
   *   ditautkan -- itu histori, bukan aktivitas hari ini, jadi cuma all-time
   *   (sama seperti `addManualCoins`/`>addcoin`).
   */
  #creditSaweriaIfLinked(key, { realtime = false } = {}) {
    const data = this.#store.get();
    const donor = data.saweriaDonors[key];
    if (!donor) return { credited: false };

    const link = this.#findLinkBySaweriaName(donor.displayName ?? key);
    if (!link) return { credited: false };

    const targetCoins = Math.floor(donor.totalRupiah / SAWERIA_RUPIAH_PER_COIN);
    const deltaCoins = targetCoins - donor.creditedCoins;
    if (deltaCoins === 0) return { credited: false };

    donor.creditedCoins = targetCoins;
    this.#store.scheduleSave();

    const newTotal =
      deltaCoins > 0
        ? realtime
          ? this.#creditRealtimeCoins(link.discordId, deltaCoins)
          : this.addManualCoins(link.discordId, deltaCoins)
        : this.reduceManualCoins(link.discordId, -deltaCoins);

    return { credited: true, discordId: link.discordId, deltaCoins, newTotal };
  }

  /**
   * Sama seperti `addManualCoins`, tapi IKUT mengisi bucket hari/bulan/tahun
   * (bukan cuma all-time) -- dipakai khusus buat kredit Saweria real-time
   * (donasi yang baru saja terjadi), supaya berperilaku persis seperti gift
   * TikTok lewat `recordGift`, bukan seperti klaim histori.
   */
  #creditRealtimeCoins(discordId, coins) {
    const data = this.#store.get();
    const link = data.links[discordId];
    if (!link) return null;
    const keys = this.#keys();

    const key = this.#resolvedUserIdFor(link) ?? this.#coinKeyFor(discordId, link);
    const user = (data.users[key] ??= emptyUser());
    if (!user.displayId && link.displayId) user.displayId = link.displayId;
    user.allTime += coins;
    addToBucket(user.day, keys.day, coins);
    addToBucket(user.month, keys.month, coins);
    addToBucket(user.year, keys.year, coins);
    user.lastSeenAt = new Date().toISOString();

    this.#store.scheduleSave();
    return user.allTime;
  }

  /**
   * Tautkan nama donatur Saweria (teks bebas, dari field `{donator}` webhook)
   * ke member Discord lewat `>verify s`. Kalau ledger-nya sudah punya histori
   * rupiah dari sebelum ditautkan, langsung di-"catch-up" jadi coin saat itu
   * juga. Tidak mensyaratkan member sudah punya akun TikTok tertaut --
   * `links[discordId]` dibuat kalau belum ada.
   *
   * @returns {{error?: 'taken', credited: boolean, discordId?: string, deltaCoins?: number, newTotal?: number|null}}
   */
  linkSaweriaDonor(discordId, donorName) {
    const existing = this.#findLinkBySaweriaName(donorName);
    if (existing && existing.discordId !== discordId) {
      return { error: 'taken', credited: false };
    }

    const data = this.#store.get();
    data.links[discordId] ??= {
      displayId: null,
      realName: null,
      tiktokUserId: null,
      linkedAt: new Date().toISOString(),
      fanClubLevel: null,
      fanClubRoleId: null,
      saweriaDonorName: null,
      saweriaLinkedAt: null,
    };
    data.links[discordId].saweriaDonorName = donorName;
    data.links[discordId].saweriaLinkedAt = new Date().toISOString();
    this.#store.scheduleSave();

    return this.#creditSaweriaIfLinked(donorName.toLowerCase());
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

    // Belum ada userId numerik sama sekali -- tapi mungkin ada kredit yang
    // tersimpan di kunci sementara "manual:<displayId>" (TikTok) atau
    // "manual-saweria:<nama>" (member yang cuma tertaut lewat Saweria).
    // `totalsFor` dipakai apa adanya (bukan baca `.allTime` manual) karena
    // kunci ini bisa juga punya isi bucket hari/bulan/tahun -- donasi Saweria
    // real-time (lihat `#creditRealtimeCoins`) mengisi bucket itu juga, beda
    // dari klaim histori lewat `addManualCoins` yang cuma all-time.
    const pendingKey = link.displayId
      ? manualKey(link.displayId)
      : link.saweriaDonorName
        ? saweriaManualKey(link.saweriaDonorName)
        : null;
    const pending = pendingKey ? this.#store.get().users[pendingKey] : null;
    return pending
      ? this.totalsFor(pendingKey)
      : { day: 0, month: 0, year: 0, allTime: 0 };
  }

  #resolvedUserIdFor(link) {
    return link.tiktokUserId ?? this.#userIdForDisplayId(link.displayId ?? '');
  }

  /**
   * Kunci penyimpanan coin buat link yang BELUM punya userId numerik TikTok.
   * Member yang punya displayId (akun TikTok sudah diisi, meski belum pernah
   * gift) dikunci ke displayId seperti biasa -- supaya tetap bisa digabung
   * otomatis begitu gift pertamanya terdeteksi (lihat `recordGift`). Member
   * yang CUMA tertaut lewat Saweria (`>verify s`, displayId masih null)
   * dikunci ke discordId-nya sendiri, karena tidak ada displayId buat
   * digabungkan nanti.
   */
  #coinKeyFor(discordId, link) {
    if (link.displayId) return manualKey(link.displayId);
    if (link.saweriaDonorName) return saweriaManualKey(link.saweriaDonorName);
    return `manual-discord:${discordId}`;
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

    const key = this.#resolvedUserIdFor(link) ?? this.#coinKeyFor(discordId, link);
    const user = (data.users[key] ??= emptyUser());
    if (!user.displayId && link.displayId) user.displayId = link.displayId;
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

    const key = this.#resolvedUserIdFor(link) ?? this.#coinKeyFor(discordId, link);
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
