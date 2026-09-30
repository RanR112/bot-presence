import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { normalizeGift } from '../src/giftListener.js';
import { GiftStore } from '../src/giftStore.js';
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

  it('milestone yang sudah diberikan tidak terduplikasi', async () => {
    const store = await new GiftStore(join(dir, 'e.json'), 'Asia/Jakarta').load();
    store.createLink('discord-2', { displayId: 'x', realName: 'X' });
    store.markMilestonesGranted('discord-2', [50, 100]);
    store.markMilestonesGranted('discord-2', [100, 250]);
    assert.deepEqual(store.linkForDiscordId('discord-2').milestonesGranted, [50, 100, 250]);
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
