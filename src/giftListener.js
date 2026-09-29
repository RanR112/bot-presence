import {
  ControlEvent,
  TikTokLiveConnection,
  UserOfflineError,
  WebcastEvent,
} from 'tiktok-live-connector';

import { logger } from './logger.js';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Menormalkan satu event gift jadi jumlah coin yang boleh dihitung.
 *
 * Gift yang bisa di-streak (gift.type === 1) mengirim event berkali-kali selama
 * streak masih jalan, dengan repeatCount yang terus naik. Kalau semuanya
 * dihitung, satu streak 10x mawar akan tercatat 1+2+3+...+10. Makanya hanya
 * event penutup (repeatEnd) yang dihitung, dengan repeatCount sebagai pengali.
 *
 * @returns {{ userId: string, displayId: string|null, nickname: string|null, coins: number, giftName: string|null }|null}
 */
export function normalizeGift(data) {
  const gift = data?.gift;
  const user = data?.user;
  if (!gift || !user?.id) return null;

  const streakable = gift.type === 1;
  const streakFinished = data.repeatEnd === 1 || data.repeatEnd === true;
  if (streakable && !streakFinished) return null;

  const diamonds = Number(gift.diamondCount ?? 0);
  const repeat = Number(data.repeatCount ?? 1);
  const coins = diamonds * (Number.isFinite(repeat) && repeat > 0 ? repeat : 1);
  if (!Number.isFinite(coins) || coins <= 0) return null;

  return {
    userId: String(user.id),
    displayId: user.displayId || null,
    nickname: user.nickname || null,
    coins,
    giftName: gift.name || null,
  };
}

export class GiftListener {
  #username;
  #pollMs;
  #onGift;
  #onLiveChange;
  #running = false;
  #connection = null;

  constructor({ username, pollSeconds, onGift, onLiveChange }) {
    this.#username = username;
    this.#pollMs = pollSeconds * 1000;
    this.#onGift = onGift;
    this.#onLiveChange = onLiveChange ?? (() => {});
  }

  get isLive() {
    return Boolean(this.#connection?.isConnected);
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#loop().catch((error) => logger.error(`Gift listener berhenti total: ${error.message}`));
  }

  async stop() {
    this.#running = false;
    await this.#disconnect();
  }

  async #disconnect() {
    if (!this.#connection) return;
    try {
      await this.#connection.disconnect();
    } catch {
      // Sudah terputus duluan -- tidak ada yang perlu dilakukan.
    }
    this.#connection = null;
  }

  async #loop() {
    while (this.#running) {
      try {
        await this.#session();
      } catch (error) {
        if (!(error instanceof UserOfflineError)) {
          logger.warn(`Koneksi TikTok LIVE gagal: ${error.message}`);
        }
      }
      await this.#disconnect();
      if (this.#running) await sleep(this.#pollMs);
    }
  }

  async #session() {
    const connection = new TikTokLiveConnection(this.#username, {
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
    });

    if (!(await connection.fetchIsLive())) return;

    await connection.connect();
    this.#connection = connection;
    logger.info(`Terhubung ke LIVE @${this.#username} (room ${connection.roomId}).`);
    this.#onLiveChange(true);

    connection.on(WebcastEvent.GIFT, (data) => {
      const gift = normalizeGift(data);
      if (!gift) return;
      try {
        this.#onGift(gift);
      } catch (error) {
        logger.error(`Gagal memproses gift: ${error.message}`);
      }
    });

    // DIAGNOSTIK SEMENTARA: enterCount yang dipakai project notifier utama
    // (via polling HTTP) terbukti meleset dari angka asli TikTok (493 vs 671
    // pada sesi 2026-09-29). totalUser di sini datang dari event WebSocket
    // yang berbeda -- log ini dipakai untuk bandingkan keduanya di sesi LIVE
    // berikutnya. Dibatasi 1x/menit supaya tidak membanjiri log (event ini
    // bisa muncul tiap beberapa detik). Hapus setelah perbandingan selesai.
    let lastRoomUserLogAt = 0;
    connection.on(WebcastEvent.ROOM_USER, (data) => {
      const now = Date.now();
      if (now - lastRoomUserLogAt < 60_000) return;
      lastRoomUserLogAt = now;
      logger.info(
        `[diagnostik viewer] totalUser=${data.totalUser} total=${data.total} popularity=${data.popularity}`,
      );
    });

    // Sesi dianggap selesai saat stream berakhir ATAU koneksi putus -- keduanya
    // harus melepas loop supaya listener kembali menunggu LIVE berikutnya.
    await new Promise((done) => {
      connection.on(WebcastEvent.STREAM_END, () => done());
      connection.on(ControlEvent.DISCONNECTED, () => done());
      connection.on(ControlEvent.ERROR, (error) => {
        logger.warn(`Error koneksi TikTok: ${error?.message ?? error}`);
      });
    });

    logger.info(`LIVE @${this.#username} berakhir, kembali memantau.`);
    this.#onLiveChange(false);
  }
}
