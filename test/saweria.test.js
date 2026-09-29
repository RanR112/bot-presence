import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchDonatorNames } from '../src/saweriaLeaderboard.js';

// Tes ini hit endpoint Saweria yang sungguhan -- dilewati kalau tidak ada
// koneksi internet / key tidak diset, supaya tidak bikin CI gagal karena
// sebab di luar kendali kita (bukan bug kode).
const REAL_STREAM_KEY = process.env.SAWERIA_TEST_STREAM_KEY;

describe(
  'fetchDonatorNames',
  { skip: !REAL_STREAM_KEY && 'SAWERIA_TEST_STREAM_KEY tidak diset' },
  () => {
    it('mengembalikan array nama tanpa nominal dari endpoint Saweria asli', async () => {
      const names = await fetchDonatorNames(REAL_STREAM_KEY);
      assert.ok(Array.isArray(names));
      assert.ok(names.length > 0, 'harus ada minimal satu donatur untuk akun tes ini');
      for (const name of names) {
        assert.equal(typeof name, 'string');
        assert.ok(name.length > 0);
      }
    });
  },
);

describe('fetchDonatorNames — penanganan error', () => {
  it('melempar error yang jelas kalau streamKey tidak valid', async () => {
    await assert.rejects(
      () => fetchDonatorNames('key-yang-jelas-salah-000000'),
      /Saweria merespons/,
    );
  });
});
