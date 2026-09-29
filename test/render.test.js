import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { GiftStore } from '../src/giftStore.js';
import { buildLeaderboardEmbed } from '../src/leaderboard.js';
import { MILESTONES, TOP_ROLES } from '../src/roles.js';
import { buildPanel } from '../src/tickets.js';

describe('buildLeaderboardEmbed', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-render-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('tetap valid saat belum ada data sama sekali', async () => {
    const store = await new GiftStore(join(dir, 'empty.json'), 'Asia/Jakarta').load();
    const embed = buildLeaderboardEmbed(store, {
      topCount: 10,
      username: 'x',
      isLive: false,
    });
    const json = embed.toJSON();

    assert.equal(json.fields.length, 4);
    for (const field of json.fields) {
      // Discord menolak embed dengan field value kosong -- ini yang bikin
      // leaderboard gagal terkirim di hari pertama sebelum ada gift apa pun.
      assert.ok(field.value.length > 0, `field "${field.name}" tidak boleh kosong`);
    }
  });

  it('tidak melewati batas 1024 karakter per field walau nama panjang', async () => {
    const store = await new GiftStore(join(dir, 'long.json'), 'Asia/Jakarta').load();
    for (let i = 0; i < 25; i += 1) {
      store.recordGift({
        userId: `user-${i}`,
        displayId: 'u'.repeat(24) + i,
        nickname: 'N'.repeat(32) + i,
        coins: 1000 - i,
      });
    }

    const embed = buildLeaderboardEmbed(store, {
      topCount: 10,
      username: 'x',
      isLive: true,
    });
    for (const field of embed.toJSON().fields) {
      assert.ok(field.value.length <= 1024, `field "${field.name}" melebihi batas Discord`);
    }
  });

  it('menampilkan peringkat terurut dengan medali di tiga teratas', async () => {
    const store = await new GiftStore(join(dir, 'order.json'), 'Asia/Jakarta').load();
    store.recordGift({ userId: '1', displayId: 'kecil', coins: 10 });
    store.recordGift({ userId: '2', displayId: 'besar', coins: 900 });

    const allTime = embedField(
      buildLeaderboardEmbed(store, {
        topCount: 10,
        username: 'x',
        isLive: false,
      }),
      '🏆 All Time',
    );

    assert.ok(allTime.startsWith('🥇'));
    assert.ok(allTime.indexOf('besar') < allTime.indexOf('kecil'));
  });
});

describe('buildPanel', () => {
  it('menghasilkan satu embed dan satu tombol yang valid', () => {
    const panel = buildPanel();
    assert.equal(panel.embeds.length, 1);
    assert.equal(panel.components.length, 1);

    const row = panel.components[0].toJSON();
    assert.equal(row.components.length, 1);
    assert.equal(row.components[0].custom_id, 'verify:start');
  });
});

describe('definisi role', () => {
  it('milestone terurut naik dan tidak ada nilai kembar', () => {
    const coins = MILESTONES.map((m) => m.coins);
    assert.deepEqual(
      coins,
      [...coins].sort((a, b) => a - b),
    );
    assert.equal(new Set(coins).size, coins.length);
    assert.deepEqual(coins, [50, 100, 250, 500, 1000, 1500, 3000, 5000, 10000]);
  });

  it('setiap role punya nama unik -- nama dipakai sebagai kunci pencarian role di guild', () => {
    const names = [...MILESTONES, ...TOP_ROLES].map((role) => role.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('warna berada dalam rentang warna Discord yang sah', () => {
    for (const role of [...MILESTONES, ...TOP_ROLES]) {
      assert.ok(role.color >= 0 && role.color <= 0xffffff, `${role.name} warnanya di luar rentang`);
    }
  });
});

function embedField(embed, name) {
  return embed.toJSON().fields.find((field) => field.name === name).value;
}
