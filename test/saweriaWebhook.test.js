import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSaweriaWebhookMessage } from '../src/saweriaWebhook.js';

describe('parseSaweriaWebhookMessage', () => {
  it('parse pesan normal: nama donatur + rupiah dengan pemisah ribuan', () => {
    const result = parseSaweriaWebhookMessage('Ada donasi masuk dari Someguy sebesar Rp 69.420');
    assert.deepEqual(result, { donorName: 'Someguy', rupiah: 69420 });
  });

  it('baris tambahan setelah pesan utama (mis. dari tombol test Saweria) diabaikan', () => {
    const result = parseSaweriaWebhookMessage(
      'Ada donasi masuk dari Someguy sebesar Rp 69.420\nTHIS IS A FAKE MESSAGE! HAVE A GOOD ONE',
    );
    assert.deepEqual(result, { donorName: 'Someguy', rupiah: 69420 });
  });

  it('nama donatur multi-kata ikut terbaca utuh', () => {
    const result = parseSaweriaWebhookMessage('Ada donasi masuk dari Rav Si Keren sebesar Rp 5.000');
    assert.deepEqual(result, { donorName: 'Rav Si Keren', rupiah: 5000 });
  });

  it('rupiah tanpa pemisah ribuan tetap terbaca', () => {
    const result = parseSaweriaWebhookMessage('Ada donasi masuk dari X sebesar Rp 500');
    assert.equal(result.rupiah, 500);
  });

  it('pesan yang tidak cocok format balik null', () => {
    assert.equal(parseSaweriaWebhookMessage('pesan random dari bot lain'), null);
    assert.equal(parseSaweriaWebhookMessage(''), null);
    assert.equal(parseSaweriaWebhookMessage(null), null);
    assert.equal(parseSaweriaWebhookMessage(undefined), null);
  });

  it('rupiah nol atau negatif ditolak', () => {
    assert.equal(parseSaweriaWebhookMessage('Ada donasi masuk dari X sebesar Rp 0'), null);
  });
});
