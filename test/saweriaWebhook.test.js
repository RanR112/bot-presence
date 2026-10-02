import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractSaweriaCandidateTexts,
  parseSaweriaWebhookEvent,
  parseSaweriaWebhookMessage,
} from '../src/saweriaWebhook.js';

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

describe('extractSaweriaCandidateTexts / parseSaweriaWebhookEvent', () => {
  it('Saweria kirim template lewat EMBED (content kosong) -- tetap terbaca dari description', () => {
    const message = {
      content: '',
      embeds: [{ title: null, description: 'Yay kamu dapet 1.000 dari Rav\ntes', footer: null, author: null }],
    };
    assert.deepEqual(parseSaweriaWebhookEvent(message), { donorName: 'Rav', rupiah: 1000 });
  });

  it('kalau suatu saat Saweria taruh di title bukan description, tetap kebaca', () => {
    const message = { content: '', embeds: [{ title: 'Yay kamu dapet 2.000 dari Budi' }] };
    assert.deepEqual(parseSaweriaWebhookEvent(message), { donorName: 'Budi', rupiah: 2000 });
  });

  it('content biasa (bukan embed) tetap didukung buat kompatibilitas mundur', () => {
    const message = { content: 'Yay kamu dapet 500 dari X', embeds: [] };
    assert.deepEqual(parseSaweriaWebhookEvent(message), { donorName: 'X', rupiah: 500 });
  });

  it('tidak ada kandidat yang cocok -> null, tidak crash', () => {
    assert.equal(parseSaweriaWebhookEvent({ content: '', embeds: [] }), null);
    assert.equal(parseSaweriaWebhookEvent({ content: '', embeds: [{ description: 'bukan format saweria' }] }), null);
  });

  it('extractSaweriaCandidateTexts mengumpulkan semua sumber teks yang ada', () => {
    const message = {
      content: 'content text',
      embeds: [{ title: 'title text', description: 'desc text', footer: { text: 'footer text' }, author: { name: 'author text' } }],
    };
    assert.deepEqual(extractSaweriaCandidateTexts(message), [
      'content text',
      'title text',
      'desc text',
      'footer text',
      'author text',
    ]);
  });
});
