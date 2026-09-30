import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  infoEmbed,
  milestoneProgressEmbed,
  notVerifiedEmbed,
  progressBar,
  rankEmbed,
  saweriaEmbed,
  statsEmbed,
} from '../src/commands.js';
import { GiftStore } from '../src/giftStore.js';
import { buildLeaderboardEmbed } from '../src/leaderboard.js';
import { MILESTONES } from '../src/roles.js';
import { buildPanel } from '../src/tickets.js';

const fakeUser = (overrides = {}) => ({
  username: 'someone',
  displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png',
  ...overrides,
});

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
    const names = MILESTONES.map((role) => role.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('warna berada dalam rentang warna Discord yang sah', () => {
    for (const role of MILESTONES) {
      assert.ok(role.color >= 0 && role.color <= 0xffffff, `${role.name} warnanya di luar rentang`);
    }
  });
});

describe('progressBar', () => {
  it('0% cuma kotak kosong, 100% cuma kotak terisi', () => {
    assert.equal(progressBar(0), '⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜');
    assert.equal(progressBar(1), '🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩');
  });

  it('membulatkan ke segmen terdekat', () => {
    assert.equal(progressBar(0.4), '🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜');
  });

  it('rasio di luar 0..1 di-clamp, tidak error', () => {
    assert.equal(progressBar(-0.5), '⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜');
    assert.equal(progressBar(1.5), '🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩');
  });
});

describe('notVerifiedEmbed / embed yang butuh link', () => {
  it('statsEmbed, rankEmbed, milestoneProgressEmbed semua tampil pesan belum terverifikasi kalau link null', () => {
    const user = fakeUser();
    for (const embed of [
      statsEmbed(user, null, { day: 0, month: 0, year: 0, allTime: 0 }),
      rankEmbed(user, null, { day: 0, month: 0, year: 0, allTime: 0 }, null),
      milestoneProgressEmbed(user, null, { day: 0, month: 0, year: 0, allTime: 0 }),
    ]) {
      assert.equal(embed.toJSON().title, notVerifiedEmbed().toJSON().title);
    }
  });
});

describe('milestoneProgressEmbed', () => {
  it('menghitung persentase & sisa coin dengan benar di antara dua tingkat', () => {
    // Silver (100) -> Gold (250), posisi di 160: (160-100)/(250-100) = 40%.
    const embed = milestoneProgressEmbed(fakeUser(), { displayId: 'x' }, { allTime: 160 });
    const desc = embed.toJSON().description;
    assert.ok(desc.includes('40%'), `harus mengandung 40%, dapat: ${desc}`);
    assert.ok(desc.includes('90'), 'harus menyebutkan sisa 90 coin menuju Gold Fan');
    assert.ok(desc.includes('Silver Fan'));
    assert.ok(desc.includes('Gold Fan'));
  });

  it('di bawah tingkat pertama, range dimulai dari 0', () => {
    // 25 dari 50 (Bronze) = 50%.
    const embed = milestoneProgressEmbed(fakeUser(), { displayId: 'x' }, { allTime: 25 });
    const desc = embed.toJSON().description;
    assert.ok(desc.includes('50%'));
    assert.ok(desc.includes('Belum ada'));
  });

  it('di tingkat tertinggi, tidak ada pembagian dengan nol dan bar penuh', () => {
    const embed = milestoneProgressEmbed(fakeUser(), { displayId: 'x' }, { allTime: 10000 });
    const desc = embed.toJSON().description;
    assert.ok(desc.includes('100%'));
    assert.ok(desc.includes('tingkat tertinggi'));
    assert.ok(!desc.includes('NaN'));
    assert.ok(!desc.includes('Infinity'));
  });
});

describe('rankEmbed', () => {
  it('menampilkan posisi rank kalau ada, atau "belum masuk papan" kalau tidak', () => {
    const withRank = rankEmbed(
      fakeUser(),
      { displayId: 'x' },
      { allTime: 100 },
      { position: 3, total: 100, outOf: 20 },
    );
    const rankField = withRank.toJSON().fields.find((f) => f.name.includes('Rank Coin'));
    assert.equal(rankField.value, '#3 dari 20 member');

    const withoutRank = rankEmbed(fakeUser(), { displayId: 'x' }, { allTime: 0 }, null);
    const rankField2 = withoutRank.toJSON().fields.find((f) => f.name.includes('Rank Coin'));
    assert.equal(rankField2.value, 'Belum masuk papan');
  });

  it('field Level Fan Club menampilkan nilai asli kalau sudah diset moderator', () => {
    const withLevel = rankEmbed(
      fakeUser(),
      { displayId: 'x', fanClubLevel: 23 },
      { allTime: 100 },
      null,
    );
    const field = withLevel.toJSON().fields.find((f) => f.name.includes('Fan Club'));
    assert.equal(field.value, 'Lv.23');

    const withoutLevel = rankEmbed(
      fakeUser(),
      { displayId: 'x', fanClubLevel: null },
      { allTime: 100 },
      null,
    );
    const field2 = withoutLevel.toJSON().fields.find((f) => f.name.includes('Fan Club'));
    assert.equal(field2.value, 'Belum diklaim');
  });
});

describe('statsEmbed', () => {
  it('field-fieldnya tidak kosong untuk member terverifikasi baru (semua nol)', () => {
    const embed = statsEmbed(
      fakeUser(),
      { displayId: 'x' },
      { day: 0, month: 0, year: 0, allTime: 0 },
    );
    for (const field of embed.toJSON().fields) {
      assert.ok(field.value.length > 0, `field "${field.name}" tidak boleh kosong`);
    }
  });
});

describe('saweriaEmbed / infoEmbed', () => {
  it('saweriaEmbed mengandung link Saweria yang benar', () => {
    assert.ok(saweriaEmbed().toJSON().description.includes('https://saweria.co/salmennn'));
  });

  it('infoEmbed mengarah ke channel info', () => {
    assert.ok(infoEmbed().toJSON().description.includes('1554521502416773250'));
  });
});

function embedField(embed, name) {
  return embed.toJSON().fields.find((field) => field.name === name).value;
}
