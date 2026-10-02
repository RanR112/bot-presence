import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSaweriaWebhookMessage } from '../src/saweriaWebhook.js';

describe('parseSaweriaWebhookMessage', () => {
  it('parse pesan normal: rupiah dengan pemisah ribuan + nama donatur', () => {
    const result = parseSaweriaWebhookMessage('Yay kamu dapet 69.420 dari Someguy');
    assert.deepEqual(result, { donorName: 'Someguy', rupiah: 69420 });
  });

  it('baris tambahan setelah pesan utama (pesan opsional donatur, atau tombol test Saweria) diabaikan', () => {
    const result = parseSaweriaWebhookMessage('Yay kamu dapet 5.000 dari Rav\np ngetes bot');
    assert.deepEqual(result, { donorName: 'Rav', rupiah: 5000 });
  });

  const fakeDisclaimer = parseSaweriaWebhookMessage(
    'Yay kamu dapet 69.420 dari Someguy\nTHIS IS A FAKE MESSAGE! HAVE A GOOD ONE',
  );
  it('disclaimer tombol test Saweria juga diabaikan', () => {
    assert.deepEqual(fakeDisclaimer, { donorName: 'Someguy', rupiah: 69420 });
  });

  it('nama donatur multi-kata ikut terbaca utuh', () => {
    const result = parseSaweriaWebhookMessage('Yay kamu dapet 5.000 dari Rav Si Keren');
    assert.deepEqual(result, { donorName: 'Rav Si Keren', rupiah: 5000 });
  });

  it('rupiah tanpa pemisah ribuan tetap terbaca', () => {
    const result = parseSaweriaWebhookMessage('Yay kamu dapet 500 dari X');
    assert.equal(result.rupiah, 500);
  });

  it('pesan yang tidak cocok format balik null', () => {
    assert.equal(parseSaweriaWebhookMessage('pesan random dari bot lain'), null);
    assert.equal(parseSaweriaWebhookMessage(''), null);
    assert.equal(parseSaweriaWebhookMessage(null), null);
    assert.equal(parseSaweriaWebhookMessage(undefined), null);
  });

  it('rupiah nol atau negatif ditolak', () => {
    assert.equal(parseSaweriaWebhookMessage('Yay kamu dapet 0 dari X'), null);
  });
});
