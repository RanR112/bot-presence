import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { logger } from './logger.js';

export class JsonStore {
  #path;
  #data;
  #saveTimer = null;
  #saving = null;

  constructor(filePath, defaults) {
    this.#path = filePath;
    this.#data = structuredClone(defaults);
  }

  async load() {
    try {
      const raw = await readFile(this.#path, 'utf8');
      this.#data = { ...this.#data, ...JSON.parse(raw) };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // File rusak tidak boleh menghentikan bot -- lebih baik mulai dari
        // state default daripada crash-loop. File lama tetap ditimpa nanti.
        logger.warn(`State ${this.#path} tidak terbaca (${error.message}), pakai default.`);
      }
    }
    return this.#data;
  }

  get() {
    return this.#data;
  }

  /** Menunda tulis ke disk supaya burst gift tidak memicu ratusan write. */
  scheduleSave(delayMs = 2000) {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.save().catch((error) => logger.error(`Gagal menyimpan state: ${error.message}`));
    }, delayMs);
    this.#saveTimer.unref?.();
  }

  async save() {
    if (this.#saving) return this.#saving;

    this.#saving = (async () => {
      const tmp = `${this.#path}.tmp`;
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
      await rename(tmp, this.#path);
    })();

    try {
      await this.#saving;
    } finally {
      this.#saving = null;
    }
  }

  async flush() {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.save();
  }
}
