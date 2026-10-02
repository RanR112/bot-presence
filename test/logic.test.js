import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { normalizeFanClub, normalizeGift } from '../src/giftListener.js';
import { GiftStore } from '../src/giftStore.js';
import { fanClubBand } from '../src/roles.js';
import { periodKeys } from '../src/time.js';

const gift = (overrides = {}) => ({
  user: { id: '111', displayId: 'someone', nickname: 'Some One' },
  gift: { type: 1, diamondCount: 1, name: 'Rose' },
  repeatCount: 1,
  repeatEnd: 1,
  ...overrides,
});

describe('normalizeGift — semantik streak', () => {
  it('MENGABAIKAN event streak yang belum selesai', () => {
    // Ini inti anti-double-count: satu streak 10x mawar mengirim 10 event.
    // Kalau semuanya dihitung, totalnya jadi 1+2+...+10 = 55, bukan 10.
    assert.equal(normalizeGift(gift({ repeatCount: 3, repeatEnd: 0 })), null);
  });

  it('menghitung streak sekali saja di event penutup, dikali repeatCount', () => {
    const result = normalizeGift(gift({ repeatCount: 10, repeatEnd: 1 }));
    assert.equal(result.coins, 10);
    assert.equal(result.userId, '111');
    assert.equal(result.displayId, 'someone');
  });

  it('gift non-streak (type != 1) langsung dihitung walau repeatEnd 0', () => {
    const result = normalizeGift(
      gift({
        gift: { type: 2, diamondCount: 1000, name: 'Galaxy' },
        repeatEnd: 0,
      }),
    );
    assert.equal(result.coins, 1000);
  });

  it('mengalikan diamondCount dengan repeatCount', () => {
    const result = normalizeGift(
      gift({
        gift: { type: 1, diamondCount: 5, name: 'Finger Heart' },
        repeatCount: 4,
      }),
    );
    assert.equal(result.coins, 20);
  });

  it('menolak payload tanpa user atau gift', () => {
    assert.equal(normalizeGift({ gift: { diamondCount: 1 } }), null);
    assert.equal(normalizeGift({ user: { id: '1' } }), null);
    assert.equal(normalizeGift(null), null);
  });

  it('menolak gift bernilai nol', () => {
    assert.equal(normalizeGift(gift({ gift: { type: 2, diamondCount: 0 } })), null);
  });

  it('repeatCount tidak wajar tidak bikin coin jadi NaN/negatif', () => {
    const result = normalizeGift(gift({ gift: { type: 2, diamondCount: 10 }, repeatCount: -5 }));
    assert.equal(result.coins, 10);
  });
});

describe('normalizeFanClub — baca user.fansClub dari event apa pun (chat/gift/join)', () => {
  const userWithFanClub = (level, overrides = {}) => ({
    id: '111',
    displayId: 'someone',
    nickname: 'Some One',
    fansClub: { data: { level, clubName: 'x', anchorId: '999' } },
    ...overrides,
  });

  it('mengambil level dari user.fansClub.data.level', () => {
    const result = normalizeFanClub(userWithFanClub(23));
    assert.deepEqual(result, {
      userId: '111',
      displayId: 'someone',
      nickname: 'Some One',
      level: 23,
    });
  });

  it('user yang BUKAN anggota fan club (fansClub undefined) -> null, bukan error', () => {
    assert.equal(normalizeFanClub({ id: '1', displayId: 'bukan-member' }), null);
  });

  it('level 0 atau tidak valid diabaikan', () => {
    assert.equal(normalizeFanClub(userWithFanClub(0)), null);
    assert.equal(normalizeFanClub(userWithFanClub(-5)), null);
    assert.equal(normalizeFanClub(userWithFanClub(NaN)), null);
  });

  it('user tanpa id diabaikan (tidak crash)', () => {
    assert.equal(normalizeFanClub({ fansClub: { data: { level: 10 } } }), null);
  });

  it('input null/undefined tidak crash', () => {
    assert.equal(normalizeFanClub(null), null);
    assert.equal(normalizeFanClub(undefined), null);
  });
});

describe('periodKeys — batas hari mengikuti WIB, bukan UTC', () => {
  it('17:30 UTC sudah dihitung sebagai hari BERIKUTNYA di WIB', () => {
    // 2026-09-29T17:30Z = 2026-09-30 00:30 WIB. Kalau pakai UTC, leaderboard
    // "hari ini" baru reset jam 7 pagi WIB -- salah untuk audiens Indonesia.
    const keys = periodKeys('Asia/Jakarta', new Date('2026-09-29T17:30:00Z'));
    assert.equal(keys.day, '2026-09-30');
    assert.equal(keys.month, '2026-09');
    assert.equal(keys.year, '2026');
  });

  it('16:59 UTC masih hari yang sama di WIB', () => {
    const keys = periodKeys('Asia/Jakarta', new Date('2026-09-29T16:59:00Z'));
    assert.equal(keys.day, '2026-09-29');
  });

  it('pergantian tahun ikut WIB', () => {
    const keys = periodKeys('Asia/Jakarta', new Date('2026-12-31T17:00:00Z'));
    assert.equal(keys.year, '2027');
    assert.equal(keys.month, '2027-01');
  });
});

describe('GiftStore', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-store-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mengakumulasi coin ke semua periode sekaligus', async () => {
    const store = await new GiftStore(join(dir, 'a.json'), 'Asia/Jakarta').load();
    store.recordGift({ userId: '1', displayId: 'a', nickname: 'A', coins: 30 });
    store.recordGift({ userId: '1', displayId: 'a', nickname: 'A', coins: 20 });

    const totals = store.totalsFor('1');
    assert.equal(totals.allTime, 50);
    assert.equal(totals.day, 50);
    assert.equal(totals.month, 50);
    assert.equal(totals.year, 50);
  });

  it('bucket dengan kunci periode basi dibaca sebagai nol, all time tetap utuh', async () => {
    const file = join(dir, 'b.json');
    await writeFile(
      file,
      JSON.stringify({
        users: {
          1: {
            displayId: 'lama',
            nickname: 'Lama',
            allTime: 500,
            day: { key: '2020-01-01', total: 500 },
            month: { key: '2020-01', total: 500 },
            year: { key: '2020', total: 500 },
          },
        },
      }),
      'utf8',
    );

    const store = await new GiftStore(file, 'Asia/Jakarta').load();
    const totals = store.totalsFor('1');
    assert.equal(totals.day, 0, 'total kemarin tidak boleh bocor ke hari ini');
    assert.equal(totals.month, 0);
    assert.equal(totals.year, 0);
    assert.equal(totals.allTime, 500, 'all time tidak pernah direset');
  });

  it('ranking mengurutkan dari terbesar dan membuang yang nol', async () => {
    const store = await new GiftStore(join(dir, 'c.json'), 'Asia/Jakarta').load();
    store.recordGift({ userId: '1', displayId: 'a', coins: 10 });
    store.recordGift({ userId: '2', displayId: 'b', coins: 90 });
    store.recordGift({ userId: '3', displayId: 'c', coins: 50 });

    const ranking = store.ranking('allTime', 10);
    assert.deepEqual(
      ranking.map((entry) => entry.displayId),
      ['b', 'c', 'a'],
    );
  });

  it('rankPositionForDiscordId mengembalikan posisi 1-based yang benar', async () => {
    const store = await new GiftStore(join(dir, 'c2.json'), 'Asia/Jakarta').load();
    store.createLink('discord-a', { displayId: 'a', realName: 'A' });
    store.createLink('discord-b', { displayId: 'b', realName: 'B' });
    store.createLink('discord-c', { displayId: 'c', realName: 'C' });
    store.recordGift({ userId: '1', displayId: 'a', coins: 10 });
    store.recordGift({ userId: '2', displayId: 'b', coins: 90 });
    store.recordGift({ userId: '3', displayId: 'c', coins: 50 });

    assert.deepEqual(store.rankPositionForDiscordId('discord-b'), {
      position: 1,
      total: 90,
      outOf: 3,
    });
    assert.deepEqual(store.rankPositionForDiscordId('discord-c'), {
      position: 2,
      total: 50,
      outOf: 3,
    });
    assert.deepEqual(store.rankPositionForDiscordId('discord-a'), {
      position: 3,
      total: 10,
      outOf: 3,
    });
  });

  it('rankPositionForDiscordId null kalau belum terverifikasi atau belum ada coin', async () => {
    const store = await new GiftStore(join(dir, 'c3.json'), 'Asia/Jakarta').load();
    assert.equal(store.rankPositionForDiscordId('tidak-ada'), null);

    store.createLink('discord-nol', { displayId: 'nol', realName: 'Nol' });
    assert.equal(store.rankPositionForDiscordId('discord-nol'), null);
  });

  it('link dibuat sebelum user pernah gift tetap nyambung saat gift pertama masuk', async () => {
    const store = await new GiftStore(join(dir, 'd.json'), 'Asia/Jakarta').load();
    store.createLink('discord-1', {
      displayId: 'BelumPernahGift',
      realName: 'Budi',
    });
    assert.equal(store.linkForDiscordId('discord-1').tiktokUserId, null);

    store.recordGift({
      userId: '999',
      displayId: 'belumpernahgift',
      coins: 75,
    });

    assert.equal(
      store.linkForDiscordId('discord-1').tiktokUserId,
      '999',
      'tiktokUserId di-backfill dari gift pertama (cocok tanpa peduli huruf besar/kecil)',
    );
    assert.equal(store.totalsForLink(store.linkForDiscordId('discord-1')).allTime, 75);
  });
});

describe('GiftStore -- addManualCoins (klaim histori coin)', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-manual-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('menambah (bukan mengganti) all-time member yang sudah punya tiktokUserId', async () => {
    const store = await new GiftStore(join(dir, 'a.json'), 'Asia/Jakarta').load();
    store.createLink('discord-1', { displayId: 'sudahgift', realName: 'A' });
    store.recordGift({ userId: '111', displayId: 'sudahgift', coins: 100 });

    const total1 = store.addManualCoins('discord-1', 50);
    assert.equal(total1, 150, 'ditambahkan ke total yang sudah ada, bukan menimpa');

    const total2 = store.addManualCoins('discord-1', 25);
    assert.equal(total2, 175, 'pemanggilan kedua tetap menambah, tidak menimpa');
  });

  it('klaim histori TIDAK masuk ke bucket hari/bulan/tahun, cuma all-time', async () => {
    const store = await new GiftStore(join(dir, 'b.json'), 'Asia/Jakarta').load();
    store.createLink('discord-2', { displayId: 'histori', realName: 'B' });
    store.recordGift({ userId: '222', displayId: 'histori', coins: 10 });

    store.addManualCoins('discord-2', 500);

    const totals = store.totalsForLink(store.linkForDiscordId('discord-2'));
    assert.equal(totals.allTime, 510);
    assert.equal(totals.day, 10, 'klaim histori tidak ikut menambah "hari ini"');
    assert.equal(totals.month, 10);
    assert.equal(totals.year, 10);
  });

  it('balik null kalau Discord ID belum terverifikasi (belum ada link)', async () => {
    const store = await new GiftStore(join(dir, 'c.json'), 'Asia/Jakarta').load();
    assert.equal(store.addManualCoins('belum-verifikasi', 100), null);
  });

  it('member yang BELUM PERNAH gift real-time (tiktokUserId belum diketahui) tetap bisa dikredit', async () => {
    const store = await new GiftStore(join(dir, 'd.json'), 'Asia/Jakarta').load();
    store.createLink('discord-3', { displayId: 'baruverif', realName: 'C' });

    const total = store.addManualCoins('discord-3', 300);
    assert.equal(total, 300);
    assert.equal(
      store.totalsForLink(store.linkForDiscordId('discord-3')).allTime,
      300,
      'totalsForLink harus tetap menemukan kredit manual walau tiktokUserId masih null',
    );
  });

  it('kredit manual OTOMATIS TERGABUNG begitu gift real-time pertama datang dengan userId asli', async () => {
    const store = await new GiftStore(join(dir, 'e.json'), 'Asia/Jakarta').load();
    store.createLink('discord-4', { displayId: 'nantigift', realName: 'D' });
    store.addManualCoins('discord-4', 200);

    // Gift real-time pertama datang -- userId '444' baru pertama kali terlihat.
    store.recordGift({ userId: '444', displayId: 'nantigift', coins: 30 });

    const link = store.linkForDiscordId('discord-4');
    assert.equal(link.tiktokUserId, '444', 'tiktokUserId ikut ter-backfill seperti biasa');

    const totals = store.totalsForLink(link);
    assert.equal(totals.allTime, 230, '200 manual + 30 real-time harus tergabung jadi satu total');
    assert.equal(
      store.ranking('allTime', 10).length,
      1,
      'tidak boleh ada dua entri terpisah di ranking untuk member yang sama',
    );
  });

  it('penambahan jumlah invalid (0/negatif/NaN) diabaikan', async () => {
    const store = await new GiftStore(join(dir, 'f.json'), 'Asia/Jakarta').load();
    store.createLink('discord-5', { displayId: 'x', realName: 'X' });
    assert.equal(store.addManualCoins('discord-5', 0), null);
    assert.equal(store.addManualCoins('discord-5', -10), null);
    assert.equal(store.addManualCoins('discord-5', NaN), null);
  });
});

describe('GiftStore -- reduceManualCoins (koreksi coin ke bawah)', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-reduce-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mengurangi total all-time yang sudah ada', async () => {
    const store = await new GiftStore(join(dir, 'a.json'), 'Asia/Jakarta').load();
    store.createLink('discord-1', { displayId: 'x', realName: 'A' });
    store.addManualCoins('discord-1', 500);

    const total = store.reduceManualCoins('discord-1', 200);
    assert.equal(total, 300);
  });

  it('tidak pernah minus -- di-floor ke 0 kalau pengurangan melebihi total', async () => {
    const store = await new GiftStore(join(dir, 'b.json'), 'Asia/Jakarta').load();
    store.createLink('discord-2', { displayId: 'y', realName: 'B' });
    store.addManualCoins('discord-2', 50);

    const total = store.reduceManualCoins('discord-2', 999);
    assert.equal(total, 0);
  });

  it('balik null kalau member belum terverifikasi', async () => {
    const store = await new GiftStore(join(dir, 'c.json'), 'Asia/Jakarta').load();
    assert.equal(store.reduceManualCoins('belum-verifikasi', 100), null);
  });

  it('balik null kalau member terverifikasi tapi belum punya coin sama sekali', async () => {
    const store = await new GiftStore(join(dir, 'd.json'), 'Asia/Jakarta').load();
    store.createLink('discord-3', { displayId: 'z', realName: 'C' });
    assert.equal(store.reduceManualCoins('discord-3', 50), null);
  });

  it('cuma mengurangi all-time, TIDAK menyentuh bucket hari/bulan/tahun', async () => {
    const store = await new GiftStore(join(dir, 'e.json'), 'Asia/Jakarta').load();
    store.createLink('discord-4', { displayId: 'w', realName: 'D' });
    store.recordGift({ userId: '444', displayId: 'w', coins: 100 });

    store.reduceManualCoins('discord-4', 40);

    const totals = store.totalsForLink(store.linkForDiscordId('discord-4'));
    assert.equal(totals.allTime, 60);
    assert.equal(totals.day, 100, 'bucket hari ini tidak ikut berkurang');
  });

  it('penguranan jumlah invalid (0/negatif/NaN) diabaikan', async () => {
    const store = await new GiftStore(join(dir, 'f.json'), 'Asia/Jakarta').load();
    store.createLink('discord-5', { displayId: 'v', realName: 'E' });
    store.addManualCoins('discord-5', 100);
    assert.equal(store.reduceManualCoins('discord-5', 0), null);
    assert.equal(store.reduceManualCoins('discord-5', -10), null);
    assert.equal(store.reduceManualCoins('discord-5', NaN), null);
  });
});

describe('fanClubBand', () => {
  it('membulatkan ke bawah ke kelipatan 5 terdekat', () => {
    assert.equal(fanClubBand(23), 20);
    assert.equal(fanClubBand(25), 25);
    assert.equal(fanClubBand(29), 25);
    assert.equal(fanClubBand(5), 5);
  });

  it('level di bawah 5 tidak dapat band (null, bukan 0)', () => {
    assert.equal(fanClubBand(4), null);
    assert.equal(fanClubBand(1), null);
    assert.equal(fanClubBand(0), null);
  });

  it('input tidak valid (negatif/NaN) balik null, tidak crash', () => {
    assert.equal(fanClubBand(-5), null);
    assert.equal(fanClubBand(NaN), null);
  });
});

describe('GiftStore -- fan club level (klaim manual)', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-fanclub-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('createLink membuat fanClubLevel/fanClubRoleId default null', async () => {
    const store = await new GiftStore(join(dir, 'a.json'), 'Asia/Jakarta').load();
    const link = store.createLink('discord-1', { displayId: 'x', realName: 'A' });
    assert.equal(link.fanClubLevel, null);
    assert.equal(link.fanClubRoleId, null);
  });

  it('setFanClubLevel meng-set (bukan menambah) dan persist ke link', async () => {
    const store = await new GiftStore(join(dir, 'b.json'), 'Asia/Jakarta').load();
    store.createLink('discord-2', { displayId: 'x', realName: 'B' });

    store.setFanClubLevel('discord-2', 23);
    assert.equal(store.linkForDiscordId('discord-2').fanClubLevel, 23);

    store.setFanClubLevel('discord-2', 8);
    assert.equal(
      store.linkForDiscordId('discord-2').fanClubLevel,
      8,
      'set kedua harus MENGGANTI, bukan menambahkan ke 23',
    );
  });

  it('setFanClubLevel/setFanClubRoleId tidak crash untuk discordId yang belum terverifikasi', async () => {
    const store = await new GiftStore(join(dir, 'c.json'), 'Asia/Jakarta').load();
    assert.equal(store.setFanClubLevel('tidak-ada', 10), null);
    store.setFanClubRoleId('tidak-ada', 'role-x'); // tidak boleh throw
  });

  it('fanClubRanking mengurutkan dari level tertinggi, membuang yang belum diklaim', async () => {
    const store = await new GiftStore(join(dir, 'd.json'), 'Asia/Jakarta').load();
    store.createLink('discord-a', { displayId: 'a', realName: 'A' });
    store.createLink('discord-b', { displayId: 'b', realName: 'B' });
    store.createLink('discord-c', { displayId: 'c', realName: 'C' }); // belum diklaim

    store.setFanClubLevel('discord-a', 12);
    store.setFanClubLevel('discord-b', 40);

    const ranking = store.fanClubRanking(10);
    assert.deepEqual(
      ranking.map((e) => e.displayId),
      ['b', 'a'],
      'urut dari level tertinggi, member yang belum klaim tidak ikut masuk papan',
    );
    assert.equal(ranking[0].level, 40);
  });

  it('fanClubRanking menghormati limit', async () => {
    const store = await new GiftStore(join(dir, 'e.json'), 'Asia/Jakarta').load();
    for (let i = 0; i < 5; i += 1) {
      store.createLink(`discord-${i}`, { displayId: `u${i}`, realName: `U${i}` });
      store.setFanClubLevel(`discord-${i}`, 10 + i);
    }
    assert.equal(store.fanClubRanking(3).length, 3);
  });
});

describe('GiftStore -- fan club level (observasi otomatis)', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-fanclub-observed-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recordFanClubLevel SET (menimpa), bukan accumulate seperti coin', async () => {
    const store = await new GiftStore(join(dir, 'a.json'), 'Asia/Jakarta').load();
    store.recordFanClubLevel({ userId: '111', displayId: 'x', nickname: 'X', level: 10 });
    store.recordFanClubLevel({ userId: '111', displayId: 'x', nickname: 'X', level: 15 });

    store.createLink('discord-1', { displayId: 'x', realName: 'X' });
    assert.equal(store.effectiveFanClubLevel(store.linkForDiscordId('discord-1')), 15);
  });

  it('tercatat untuk SIAPA PUN, termasuk yang belum terverifikasi sama sekali', async () => {
    const store = await new GiftStore(join(dir, 'b.json'), 'Asia/Jakarta').load();
    store.recordFanClubLevel({ userId: '222', displayId: 'belum-verif', nickname: null, level: 7 });

    const ranking = store.fanClubRanking(10);
    assert.equal(ranking.length, 1);
    assert.equal(ranking[0].displayId, 'belum-verif');
    assert.equal(ranking[0].level, 7);
  });

  it('effectiveFanClubLevel: observasi MENANG kalau sudah ada, fallback ke manual kalau belum', async () => {
    const store = await new GiftStore(join(dir, 'c.json'), 'Asia/Jakarta').load();
    store.createLink('discord-2', { displayId: 'y', realName: 'Y' });

    // Belum pernah teramati -- pakai klaim manual.
    store.setFanClubLevel('discord-2', 5);
    assert.equal(store.effectiveFanClubLevel(store.linkForDiscordId('discord-2')), 5);

    // Begitu teramati lewat event real-time, observasi MENANG walau lebih kecil
    // dari klaim manual -- observasi dianggap lebih akurat/terkini.
    store.recordFanClubLevel({ userId: '333', displayId: 'y', nickname: 'Y', level: 3 });
    assert.equal(
      store.effectiveFanClubLevel(store.linkForDiscordId('discord-2')),
      3,
      'observasi real-time menang atas klaim manual lama',
    );
  });

  it('effectiveFanClubLevel balik null untuk member belum terverifikasi/belum ada data sama sekali', async () => {
    const store = await new GiftStore(join(dir, 'd.json'), 'Asia/Jakarta').load();
    assert.equal(store.effectiveFanClubLevel(null), null);

    store.createLink('discord-3', { displayId: 'z', realName: 'Z' });
    assert.equal(store.effectiveFanClubLevel(store.linkForDiscordId('discord-3')), null);
  });

  it('fanClubRanking menggabungkan observasi + manual TANPA duplikat untuk akun yang sama', async () => {
    const store = await new GiftStore(join(dir, 'e.json'), 'Asia/Jakarta').load();
    store.createLink('discord-4', { displayId: 'gabung', realName: 'Gabung' });
    store.setFanClubLevel('discord-4', 5); // klaim manual dulu

    store.recordFanClubLevel({
      userId: '444',
      displayId: 'gabung',
      nickname: 'Gabung',
      level: 20,
    }); // lalu teramati dengan level lebih tinggi

    const ranking = store.fanClubRanking(10);
    assert.equal(
      ranking.length,
      1,
      'tidak boleh ada 2 entri (observasi + manual) untuk akun yang sama',
    );
    assert.equal(
      ranking[0].level,
      20,
      'entri yang dipakai harus dari hasil observasi, bukan manual',
    );
  });

  it('fanClubRanking: observasi (belum terverifikasi) dan manual (sudah terverifikasi, belum teramati) tampil berdampingan', async () => {
    const store = await new GiftStore(join(dir, 'f.json'), 'Asia/Jakarta').load();
    store.recordFanClubLevel({
      userId: '555',
      displayId: 'cuma-nonton',
      nickname: null,
      level: 30,
    });

    store.createLink('discord-5', { displayId: 'sudah-verif', realName: 'Verif' });
    store.setFanClubLevel('discord-5', 12);

    const ranking = store.fanClubRanking(10);
    assert.deepEqual(
      ranking.map((e) => e.displayId),
      ['cuma-nonton', 'sudah-verif'],
    );
  });

  it('recordFanClubLevel mengabaikan payload tidak valid tanpa crash', async () => {
    const store = await new GiftStore(join(dir, 'g.json'), 'Asia/Jakarta').load();
    store.recordFanClubLevel({ userId: null, level: 10 });
    store.recordFanClubLevel({ userId: '1', level: 0 });
    store.recordFanClubLevel({ userId: '1', level: NaN });
    assert.deepEqual(store.fanClubRanking(10), []);
  });
});

describe('GiftStore -- konversi donasi Saweria ke coin', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-saweria-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('donasi dari nama yang BELUM ditautkan cuma masuk ledger, tidak mengkredit siapa pun', async () => {
    const store = await new GiftStore(join(dir, 'a.json'), 'Asia/Jakarta').load();
    const result = store.recordSaweriaDonation({ donorName: 'Someguy', rupiah: 5000 });
    assert.equal(result.credited, false);
  });

  it('linkSaweriaDonor menautkan nama donatur dan langsung catch-up histori ledger jadi coin', async () => {
    const store = await new GiftStore(join(dir, 'b.json'), 'Asia/Jakarta').load();
    store.recordSaweriaDonation({ donorName: 'Someguy', rupiah: 5000 }); // Rp5.000 / Rp200 = 25 coin

    const result = store.linkSaweriaDonor('discord-1', 'Someguy');
    assert.equal(result.credited, true);
    assert.equal(result.deltaCoins, 25);
    assert.equal(result.newTotal, 25);
    assert.equal(store.linkForDiscordId('discord-1').saweriaDonorName, 'Someguy');
  });

  it('donasi berikutnya SETELAH ditautkan otomatis mengkredit tanpa perlu verify ulang', async () => {
    const store = await new GiftStore(join(dir, 'c.json'), 'Asia/Jakarta').load();
    store.linkSaweriaDonor('discord-2', 'Rav'); // tautkan duluan, belum ada histori

    const result = store.recordSaweriaDonation({ donorName: 'Rav', rupiah: 1000 }); // 5 coin
    assert.equal(result.credited, true);
    assert.equal(result.deltaCoins, 5);
    assert.equal(result.newTotal, 5);
  });

  it('pencocokan nama donatur TIDAK peka huruf besar/kecil', async () => {
    const store = await new GiftStore(join(dir, 'd.json'), 'Asia/Jakarta').load();
    store.linkSaweriaDonor('discord-3', 'RavRafael');

    const result = store.recordSaweriaDonation({ donorName: 'ravrafael', rupiah: 400 }); // 2 coin
    assert.equal(result.credited, true);
    assert.equal(result.deltaCoins, 2);
  });

  it('nama donatur yang sudah ditautkan ke member lain tidak bisa ditautkan ulang', async () => {
    const store = await new GiftStore(join(dir, 'e.json'), 'Asia/Jakarta').load();
    store.linkSaweriaDonor('discord-4', 'Unik');

    const result = store.linkSaweriaDonor('discord-5', 'Unik');
    assert.equal(result.error, 'taken');
  });

  it('rupiah sisa (belum cukup 1 coin) tidak hilang -- terbawa ke donasi berikutnya', async () => {
    const store = await new GiftStore(join(dir, 'f.json'), 'Asia/Jakarta').load();
    store.linkSaweriaDonor('discord-6', 'Pecahan');

    const first = store.recordSaweriaDonation({ donorName: 'Pecahan', rupiah: 150 }); // < 200, belum 1 coin
    assert.equal(first.credited, false);

    const second = store.recordSaweriaDonation({ donorName: 'Pecahan', rupiah: 150 }); // total 300 -> 1 coin
    assert.equal(second.credited, true);
    assert.equal(second.deltaCoins, 1);
  });

  it('linkSaweriaDonor tidak mensyaratkan akun TikTok sudah tertaut -- bikin link baru kalau belum ada', async () => {
    const store = await new GiftStore(join(dir, 'g.json'), 'Asia/Jakarta').load();
    store.linkSaweriaDonor('discord-7', 'Baru');

    const link = store.linkForDiscordId('discord-7');
    assert.equal(link.displayId, null);
    assert.equal(link.saweriaDonorName, 'Baru');
  });

  it('createLink (verify t) tidak menghapus saweriaDonorName yang sudah ditautkan lebih dulu', async () => {
    const store = await new GiftStore(join(dir, 'h.json'), 'Asia/Jakarta').load();
    store.linkSaweriaDonor('discord-8', 'Gabungan');
    store.createLink('discord-8', { displayId: 'tiktoknya', realName: 'Nama' });

    const link = store.linkForDiscordId('discord-8');
    assert.equal(link.displayId, 'tiktoknya');
    assert.equal(link.saweriaDonorName, 'Gabungan', 'verify t tidak boleh menimpa tautan Saweria yang sudah ada');
  });

  it('linkSaweriaDonor tidak menghapus displayId TikTok yang sudah ditautkan lebih dulu', async () => {
    const store = await new GiftStore(join(dir, 'i.json'), 'Asia/Jakarta').load();
    store.createLink('discord-9', { displayId: 'tiktoknya', realName: 'Nama' });
    store.linkSaweriaDonor('discord-9', 'NamaSaweria');

    const link = store.linkForDiscordId('discord-9');
    assert.equal(link.displayId, 'tiktoknya');
    assert.equal(link.saweriaDonorName, 'NamaSaweria');
  });

  it('totalsForLink membaca coin dari member yang CUMA tertaut lewat Saweria (belum ada TikTok)', async () => {
    const store = await new GiftStore(join(dir, 'j.json'), 'Asia/Jakarta').load();
    store.linkSaweriaDonor('discord-10', 'HanyaSaweria');
    store.recordSaweriaDonation({ donorName: 'HanyaSaweria', rupiah: 2000 }); // 10 coin

    const totals = store.totalsForLink(store.linkForDiscordId('discord-10'));
    assert.equal(totals.allTime, 10);
  });

  it('verify t SETELAH verify s menggabungkan coin Saweria yang sudah terkumpul ke entri TikTok', async () => {
    const store = await new GiftStore(join(dir, 'k.json'), 'Asia/Jakarta').load();
    store.linkSaweriaDonor('discord-11', 'GabungBelakangan');
    store.recordSaweriaDonation({ donorName: 'GabungBelakangan', rupiah: 4000 }); // 20 coin, belum ada akun TikTok

    store.createLink('discord-11', { displayId: 'barutiktok', realName: 'Baru' });

    const totals = store.totalsForLink(store.linkForDiscordId('discord-11'));
    assert.equal(totals.allTime, 20, '20 coin dari Saweria harus ikut pindah ke entri TikTok yang baru ditautkan');

    // Donasi Saweria berikutnya tetap kekredit ke member yang sama (nama masih tertaut).
    const result = store.recordSaweriaDonation({ donorName: 'GabungBelakangan', rupiah: 1000 }); // +5 coin
    assert.equal(result.credited, true);
    assert.equal(result.deltaCoins, 5);
    assert.equal(result.newTotal, 25);
  });

  it('donasi real-time (webhook, SUDAH ditautkan) ikut masuk bucket hari/bulan/tahun, bukan cuma all-time', async () => {
    const store = await new GiftStore(join(dir, 'l.json'), 'Asia/Jakarta').load();
    store.linkSaweriaDonor('discord-12', 'RealTime');

    store.recordSaweriaDonation({ donorName: 'RealTime', rupiah: 2000 }); // 10 coin

    const totals = store.totalsForLink(store.linkForDiscordId('discord-12'));
    assert.equal(totals.allTime, 10);
    assert.equal(totals.day, 10, 'donasi yang baru terjadi harus ikut kehitung hari ini');
    assert.equal(totals.month, 10);
    assert.equal(totals.year, 10);
  });

  it('linkForSaweriaName dan saweriaLedgerTotal dipakai alur tiket buat cek klaim duplikat & cross-check nominal', async () => {
    const store = await new GiftStore(join(dir, 'n.json'), 'Asia/Jakarta').load();
    assert.equal(store.linkForSaweriaName('BelumAda'), null);
    assert.equal(store.saweriaLedgerTotal('BelumAda'), 0);

    store.linkSaweriaDonor('discord-14', 'SudahAda');
    store.recordSaweriaDonation({ donorName: 'SudahAda', rupiah: 1500 });

    const found = store.linkForSaweriaName('sudahada'); // tidak peka huruf besar/kecil
    assert.equal(found.discordId, 'discord-14');
    assert.equal(store.saweriaLedgerTotal('SUDAHADA'), 1500);
  });

  it('catch-up histori lewat verify s (ledger SEBELUM ditautkan) CUMA masuk all-time, bukan aktivitas hari ini', async () => {
    const store = await new GiftStore(join(dir, 'm.json'), 'Asia/Jakarta').load();
    store.recordSaweriaDonation({ donorName: 'Histori', rupiah: 3000 }); // numpuk duluan, belum tertaut

    store.linkSaweriaDonor('discord-13', 'Histori'); // baru ditautkan sekarang -- catch-up 15 coin

    const totals = store.totalsForLink(store.linkForDiscordId('discord-13'));
    assert.equal(totals.allTime, 15);
    assert.equal(totals.day, 0, 'catch-up histori bukan aktivitas hari ini');
    assert.equal(totals.month, 0);
    assert.equal(totals.year, 0);
  });
});
