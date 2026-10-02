// Template Pesan di dashboard Saweria (Integrations > Discord) harus diset
// persis ke: "Ada donasi masuk dari {donator} sebesar Rp {amount}". Saweria
// me-render {amount} pakai format angka Indonesia (titik = pemisah ribuan),
// jadi "69.420" artinya Rp69.420, bukan 69,42.
const PATTERN = /^Ada donasi masuk dari (.+?) sebesar Rp\s*([\d.,]+)/;

/**
 * Parse isi pesan webhook Discord dari Saweria. Cuma baca baris pertama --
 * Saweria kadang menyisipkan baris tambahan (mis. saat tombol test di
 * dashboard diklik), jadi parser ini aman dipakai apa pun yang ada di baris
 * setelahnya.
 *
 * @returns {{donorName: string, rupiah: number}|null}
 */
export function parseSaweriaWebhookMessage(content) {
  const match = PATTERN.exec(content ?? '');
  if (!match) return null;

  const donorName = match[1].trim();
  const rupiah = Number.parseInt(match[2].replace(/[.,]/g, ''), 10);
  if (!Number.isFinite(rupiah) || rupiah <= 0 || !donorName) return null;

  return { donorName, rupiah };
}
