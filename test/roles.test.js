import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { GiftStore } from '../src/giftStore.js';
import { MILESTONES, RoleManager } from '../src/roles.js';

/** Mock role Discord -- cuma id/name/color, cukup buat kebutuhan RoleManager. */
function mockRole(name, id) {
  const def = MILESTONES.find((m) => m.name === name);
  return { id, name, color: def?.color ?? 0 };
}

/**
 * Mock guild minimal: roles.cache berisi semua role milestone (sudah "ada"
 * sejak awal, mensimulasikan ensureRoles() yang sudah pernah jalan), dan
 * members.fetch mengembalikan mock member yang roles.add/remove-nya benar2
 * memutasi Set id yang dipegang -- supaya tes bisa verifikasi state akhir.
 */
function mockGuild({ heldRoleNames = [], memberExists = true, failAddFor = null } = {}) {
  const roleByName = new Map(MILESTONES.map((m, i) => [m.name, mockRole(m.name, `role-${i}`)]));
  const rolesCache = new Map([...roleByName.values()].map((r) => [r.id, r]));
  // Collection Discord.js punya .find() di atas Map -- Map biasa tidak.
  rolesCache.find = function (predicate) {
    for (const value of this.values()) if (predicate(value)) return value;
    return undefined;
  };

  const heldIds = new Set(heldRoleNames.map((name) => roleByName.get(name).id));

  const member = {
    roles: {
      cache: {
        has: (id) => heldIds.has(id),
      },
      add: async (role) => {
        if (failAddFor && role.name === failAddFor) throw new Error('Missing Permissions');
        heldIds.add(role.id);
      },
      remove: async (role) => {
        heldIds.delete(role.id);
      },
    },
  };

  return {
    guild: {
      roles: {
        cache: rolesCache,
        create: async ({ name, color }) => {
          const role = { id: `created-${name}`, name, color };
          rolesCache.set(role.id, role);
          return role;
        },
      },
      members: {
        fetch: async () => {
          if (!memberExists) throw new Error('Unknown Member');
          return member;
        },
      },
    },
    heldRoleNamesNow: () => [...heldIds].map((id) => rolesCache.get(id)?.name).filter(Boolean),
  };
}

describe('RoleManager.syncMilestones -- satu role aktif, bukan menumpuk', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-roles-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(file, heldRoleNames = [], guildOpts = {}) {
    const store = await new GiftStore(join(dir, file), 'Asia/Jakarta').load();
    store.createLink('discord-1', { displayId: 'x', realName: 'X' });
    const { guild, heldRoleNamesNow } = mockGuild({ heldRoleNames, ...guildOpts });
    const roles = new RoleManager(guild, store);
    return { roles, heldRoleNamesNow };
  }

  it('member baru: dapat role pertama kali saat melewati 50 coin', async () => {
    const { roles, heldRoleNamesNow } = await setup('a.json');
    const result = await roles.syncMilestones('discord-1', 60);

    assert.deepEqual(
      result.granted.map((m) => m.name),
      ['Bronze Fan'],
    );
    assert.deepEqual(heldRoleNamesNow(), ['Bronze Fan']);
  });

  it('lompat beberapa tingkat sekaligus (mis. lewat addcoin besar): cuma tingkat tertinggi yang dipasang', async () => {
    const { roles, heldRoleNamesNow } = await setup('b.json');
    // 1600 coin melewati Bronze/Silver/Gold/Platinum/Diamond/Emerald sekaligus.
    const result = await roles.syncMilestones('discord-1', 1600);

    assert.deepEqual(
      result.granted.map((m) => m.name),
      ['Emerald Fan'],
      'notifikasi cuma menyebutkan tingkat tertinggi, bukan semua yang dilewati',
    );
    assert.deepEqual(
      heldRoleNamesNow(),
      ['Emerald Fan'],
      'cuma role Emerald yang benar-benar dipasang -- Bronze/Silver/dst tidak pernah ditambahkan sama sekali',
    );
  });

  it('naik dari tingkat lama ke baru: role lama DICABUT, role baru DIPASANG', async () => {
    const { roles, heldRoleNamesNow } = await setup('c.json', ['Bronze Fan']);
    const result = await roles.syncMilestones('discord-1', 150);

    assert.deepEqual(
      result.granted.map((m) => m.name),
      ['Silver Fan'],
    );
    assert.deepEqual(
      heldRoleNamesNow(),
      ['Silver Fan'],
      'Bronze Fan harus sudah tercabut, tersisa cuma Silver Fan',
    );
  });

  it('sudah di tingkat yang benar: tidak ada perubahan, granted kosong', async () => {
    const { roles, heldRoleNamesNow } = await setup('d.json', ['Silver Fan']);
    const result = await roles.syncMilestones('discord-1', 120);

    assert.deepEqual(result.granted, []);
    assert.deepEqual(heldRoleNamesNow(), ['Silver Fan']);
  });

  it('koreksi turun (reducecoin): role tinggi dicabut, diganti role yang sesuai total baru', async () => {
    const { roles, heldRoleNamesNow } = await setup('e.json', ['Gold Fan']);
    // Total dikoreksi turun jadi 120 -- di bawah Gold (250), tapi masih di atas Silver (100).
    const result = await roles.syncMilestones('discord-1', 120);

    assert.deepEqual(
      result.granted.map((m) => m.name),
      ['Silver Fan'],
    );
    assert.deepEqual(
      heldRoleNamesNow(),
      ['Silver Fan'],
      'Gold Fan harus tercabut, turun ke Silver Fan',
    );
  });

  it('membersihkan role yang sudah kadung menumpuk dari bug lama (regresi nyata)', async () => {
    // Skenario persis yang terjadi di server: member pegang 6 role sekaligus.
    const { roles, heldRoleNamesNow } = await setup('f.json', [
      'Bronze Fan',
      'Silver Fan',
      'Gold Fan',
      'Platinum Fan',
      'Diamond Fan',
      'Emerald Fan',
    ]);
    const result = await roles.syncMilestones('discord-1', 1600);

    assert.deepEqual(
      heldRoleNamesNow(),
      ['Emerald Fan'],
      'lima role rendah harus tercabut semua, cuma Emerald Fan yang tersisa',
    );
    assert.deepEqual(result.granted, [], 'Emerald Fan sudah dipegang sebelumnya, bukan "baru"');
  });

  it('belum mencapai tingkat manapun: tidak ada aksi apa pun', async () => {
    const { roles, heldRoleNamesNow } = await setup('g.json');
    const result = await roles.syncMilestones('discord-1', 10);

    assert.deepEqual(result.granted, []);
    assert.deepEqual(heldRoleNamesNow(), []);
  });

  it('member tidak ditemukan di guild: dilaporkan lewat memberNotFound, tidak crash', async () => {
    const { roles } = await setup('h.json', [], { memberExists: false });
    const result = await roles.syncMilestones('discord-1', 100);

    assert.equal(result.memberNotFound, true);
    assert.deepEqual(result.granted, []);
  });

  it('gagal assign role (mis. hierarki salah): dilaporkan lewat failed, bukan diam-diam hilang', async () => {
    const { roles } = await setup('i.json', [], { failAddFor: 'Bronze Fan' });
    const result = await roles.syncMilestones('discord-1', 60);

    assert.equal(result.granted.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].name, 'Bronze Fan');
    assert.match(result.failed[0].reason, /Missing Permissions/);
  });

  it('member yang belum terverifikasi (tidak ada link): balik kosong, tidak crash', async () => {
    const store = await new GiftStore(join(dir, 'j.json'), 'Asia/Jakarta').load();
    const { guild } = mockGuild();
    const roles = new RoleManager(guild, store);

    const result = await roles.syncMilestones('tidak-terverifikasi', 1000);
    assert.deepEqual(result, { granted: [], failed: [], memberNotFound: false });
  });
});

describe('RoleManager.syncFanClubLevel -- klaim manual moderator, satu role aktif', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-fanclub-roles-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(file, guildOpts = {}) {
    const store = await new GiftStore(join(dir, file), 'Asia/Jakarta').load();
    store.createLink('discord-1', { displayId: 'x', realName: 'X' });
    const { guild, heldRoleNamesNow } = mockGuild(guildOpts);
    const roles = new RoleManager(guild, store);
    return { roles, store, heldRoleNamesNow };
  }

  it('level 23 dibulatkan ke bawah jadi band Lv.20', async () => {
    const { roles, heldRoleNamesNow } = await setup('a.json');
    const result = await roles.syncFanClubLevel('discord-1', 23);

    assert.deepEqual(result.granted, { level: 23, band: 20, name: 'Fan Lv.20' });
    assert.deepEqual(heldRoleNamesNow(), ['Fan Lv.20']);
  });

  it('level di bawah 5: tidak ada role sama sekali (bukan Lv.0)', async () => {
    const { roles, heldRoleNamesNow } = await setup('b.json');
    const result = await roles.syncFanClubLevel('discord-1', 3);

    assert.equal(result.granted, null);
    assert.deepEqual(heldRoleNamesNow(), []);
  });

  it('naik band: role lama dicabut, role baru dipasang (dilacak lewat fanClubRoleId, bukan enumerasi array tetap)', async () => {
    const { roles, store, heldRoleNamesNow } = await setup('c.json');
    await roles.syncFanClubLevel('discord-1', 12); // Lv.10
    assert.deepEqual(heldRoleNamesNow(), ['Fan Lv.10']);
    assert.equal(store.linkForDiscordId('discord-1').fanClubRoleId, 'created-Fan Lv.10');

    const result = await roles.syncFanClubLevel('discord-1', 27); // naik ke Lv.25
    assert.deepEqual(result.granted, { level: 27, band: 25, name: 'Fan Lv.25' });
    assert.deepEqual(
      heldRoleNamesNow(),
      ['Fan Lv.25'],
      'Fan Lv.10 harus tercabut, tersisa cuma Fan Lv.25',
    );
  });

  it('koreksi turun: role tinggi dicabut, diganti band yang lebih rendah', async () => {
    const { roles, heldRoleNamesNow } = await setup('d.json');
    await roles.syncFanClubLevel('discord-1', 40); // Lv.40
    const result = await roles.syncFanClubLevel('discord-1', 8); // dikoreksi turun ke Lv.5

    assert.deepEqual(result.granted, { level: 8, band: 5, name: 'Fan Lv.5' });
    assert.deepEqual(heldRoleNamesNow(), ['Fan Lv.5']);
  });

  it('level sama (band sama) dipanggil dua kali: idempoten, tidak ada perubahan', async () => {
    const { roles, heldRoleNamesNow } = await setup('e.json');
    await roles.syncFanClubLevel('discord-1', 12);
    const result = await roles.syncFanClubLevel('discord-1', 14); // masih band 10

    assert.equal(result.granted, null);
    assert.deepEqual(heldRoleNamesNow(), ['Fan Lv.10']);
  });

  it('member tidak ditemukan: dilaporkan lewat memberNotFound', async () => {
    const { roles } = await setup('f.json', { memberExists: false });
    const result = await roles.syncFanClubLevel('discord-1', 10);
    assert.equal(result.memberNotFound, true);
    assert.equal(result.granted, null);
  });

  it('member belum terverifikasi: balik kosong, tidak crash', async () => {
    const store = await new GiftStore(join(dir, 'g.json'), 'Asia/Jakarta').load();
    const { guild } = mockGuild();
    const roles = new RoleManager(guild, store);

    const result = await roles.syncFanClubLevel('tidak-terverifikasi', 20);
    assert.deepEqual(result, { granted: null, failed: null, memberNotFound: false });
  });

  it('revokeAllRoles juga mencabut role fan club', async () => {
    const { roles, heldRoleNamesNow } = await setup('h.json');
    await roles.syncFanClubLevel('discord-1', 15);
    await roles.syncMilestones('discord-1', 60); // sekalian pasang milestone juga

    assert.deepEqual(heldRoleNamesNow().sort(), ['Bronze Fan', 'Fan Lv.15'].sort());

    await roles.revokeAllRoles('discord-1');
    assert.deepEqual(heldRoleNamesNow(), []);
  });
});
