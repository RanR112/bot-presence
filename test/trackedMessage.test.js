import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { GiftStore } from '../src/giftStore.js';
import { trackedMessagePublisher } from '../src/trackedMessage.js';

/** Error yang meniru DiscordAPIError asli, lengkap dengan properti `.code`. */
function discordError(code, message = 'error') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Mock channel + client minimal. `messages` adalah Map id->payload yang
 * merepresentasikan "pesan yang sungguhan ada" -- fetch untuk id yang tidak
 * ada di situ melempar error 10008 (Unknown Message), persis Discord asli.
 */
function mockClientWithChannel({ fetchError = null } = {}) {
  const messages = new Map();
  let nextId = 1;
  const sendLog = [];
  const editLog = [];

  const channel = {
    isTextBased: () => true,
    messages: {
      fetch: async (id) => {
        if (fetchError) throw fetchError;
        if (!messages.has(id)) throw discordError(10008, 'Unknown Message');
        const stored = messages.get(id);
        return {
          id,
          edit: async (payload) => {
            editLog.push({ id, payload });
            messages.set(id, payload);
          },
        };
      },
    },
    send: async (payload) => {
      const id = String(nextId++);
      messages.set(id, payload);
      sendLog.push({ id, payload });
      return { id };
    },
  };

  const client = { channels: { fetch: async () => channel } };
  return { client, messages, sendLog, editLog };
}

describe('trackedMessagePublisher', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bp-tracked-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function freshStore(file) {
    return new GiftStore(join(dir, file), 'Asia/Jakarta').load();
  }

  it('pesan pertama: belum ada messageId tersimpan -> kirim pesan baru', async () => {
    const store = await freshStore('a.json');
    const { client, sendLog } = mockClientWithChannel();
    const tracker = trackedMessagePublisher({ store, metaKey: 'msgId' });

    await tracker.publishOrEdit(client, 'chan-1', () => ({ content: 'v1' }));

    assert.equal(sendLog.length, 1);
    assert.equal(store.getMeta('msgId'), '1');
  });

  it('messageId sudah ada dan pesannya beneran ada -> EDIT, bukan kirim baru', async () => {
    const store = await freshStore('b.json');
    const { client, sendLog, editLog } = mockClientWithChannel();
    const tracker = trackedMessagePublisher({ store, metaKey: 'msgId' });

    await tracker.publishOrEdit(client, 'chan-1', () => ({ content: 'v1' }));
    await tracker.publishOrEdit(client, 'chan-1', () => ({ content: 'v2' }));

    assert.equal(sendLog.length, 1, 'cuma sekali kirim pesan baru');
    assert.equal(editLog.length, 1, 'panggilan kedua harus edit');
    assert.equal(editLog[0].payload.content, 'v2');
  });

  it('messageId ada tapi pesannya BENAR-BENAR sudah dihapus (10008) -> kirim pesan baru, ini yang benar', async () => {
    const store = await freshStore('c.json');
    const { client, sendLog } = mockClientWithChannel();
    const tracker = trackedMessagePublisher({ store, metaKey: 'msgId' });

    store.setMeta('msgId', 'pesan-yang-sudah-dihapus');
    await tracker.publishOrEdit(client, 'chan-1', () => ({ content: 'v1' }));

    assert.equal(sendLog.length, 1);
    assert.notEqual(store.getMeta('msgId'), 'pesan-yang-sudah-dihapus');
  });

  it('BUG YANG DIPERBAIKI: error TRANSIEN (bukan 10008) saat fetch TIDAK BOLEH memicu kirim pesan baru', async () => {
    const store = await freshStore('d.json');
    const { client, sendLog } = mockClientWithChannel({
      fetchError: discordError(50_013, 'Missing Permissions'),
    });
    const tracker = trackedMessagePublisher({ store, metaKey: 'msgId' });

    store.setMeta('msgId', 'pesan-lama-yang-masih-ada-sebenarnya');
    await tracker.publishOrEdit(client, 'chan-1', () => ({ content: 'v1' }));

    assert.equal(sendLog.length, 0, 'tidak boleh bikin pesan baru cuma karena error sementara');
    assert.equal(
      store.getMeta('msgId'),
      'pesan-lama-yang-masih-ada-sebenarnya',
      'messageId lama tidak boleh berubah -- siklus berikutnya harus coba lagi ke pesan yang sama',
    );
  });

  it('buildPayload balik null/falsy -> publish dibatalkan diam-diam (mis. sumber data eksternal gagal)', async () => {
    const store = await freshStore('e.json');
    const { client, sendLog } = mockClientWithChannel();
    const tracker = trackedMessagePublisher({ store, metaKey: 'msgId' });

    await tracker.publishOrEdit(client, 'chan-1', () => null);

    assert.equal(sendLog.length, 0);
    assert.equal(store.getMeta('msgId'), null);
  });

  it('BUG YANG DIPERBAIKI: dua publish() bersamaan diantre berurutan, tidak overlap/race', async () => {
    const store = await freshStore('f.json');
    const { client, sendLog } = mockClientWithChannel();
    const tracker = trackedMessagePublisher({ store, metaKey: 'msgId' });

    const order = [];
    const slowBuild = (label, delayMs) => async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(label);
      return { content: label };
    };

    // Dua publish() ditembak nyaris bersamaan tanpa menunggu satu sama lain --
    // sebelum perbaikan, keduanya akan sama-sama lihat "belum ada messageId"
    // dan sama-sama kirim pesan baru (duplikat).
    const p1 = tracker.publishOrEdit(client, 'chan-1', slowBuild('A', 20));
    const p2 = tracker.publishOrEdit(client, 'chan-1', slowBuild('B', 5));
    await Promise.all([p1, p2]);

    assert.deepEqual(order, ['A', 'B'], 'B harus nunggu A selesai walau build B lebih cepat');
    assert.equal(sendLog.length, 1, 'cuma satu pesan yang dikirim (A), B mengedit pesan itu');
    assert.equal(sendLog[0].payload.content, 'A');
  });

  it('satu publish() gagal (error dilempar dari dalam) tidak menyumbat antrean publish() berikutnya', async () => {
    const store = await freshStore('g.json');
    const { client, sendLog } = mockClientWithChannel();
    const tracker = trackedMessagePublisher({ store, metaKey: 'msgId' });

    const failing = tracker.publishOrEdit(client, 'chan-1', () => {
      throw new Error('gagal ambil data eksternal');
    });
    await assert.rejects(failing);

    // Publish berikutnya harus tetap jalan normal, tidak ikut macet.
    await tracker.publishOrEdit(client, 'chan-1', () => ({ content: 'ok' }));
    assert.equal(sendLog.length, 1);
    assert.equal(sendLog[0].payload.content, 'ok');
  });

  it('channel tidak ditemukan: tidak crash, tidak kirim apa pun', async () => {
    const store = await freshStore('h.json');
    const client = { channels: { fetch: async () => null } };
    const tracker = trackedMessagePublisher({ store, metaKey: 'msgId' });

    await tracker.publishOrEdit(client, 'chan-tidak-ada', () => ({ content: 'v1' }));
    assert.equal(store.getMeta('msgId'), null);
  });
});
