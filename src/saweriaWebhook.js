// Template Pesan di dashboard Saweria (Integrations > Discord) harus diset
// persis ke: "Yay kamu dapet {amount} dari {donator}". Saweria me-render
// {amount} pakai format angka Indonesia (titik = pemisah ribuan), jadi
// "69.420" artinya Rp69.420, bukan 69,42.
const PATTERN = /^Yay kamu dapet ([\d.,]+) dari (.+)/;

/**
 * Parse isi pesan webhook Discord dari Saweria. Cuma baca baris pertama --
 * Saweria/donatur kadang menyisipkan baris tambahan (pesan opsional dari
 * donatur, atau disclaimer saat tombol test di dashboard diklik), jadi
 * parser ini aman dipakai apa pun yang ada di baris setelahnya.
 *
 * @returns {{donorName: string, rupiah: number}|null}
 */
export function parseSaweriaWebhookMessage(content) {
  const match = PATTERN.exec(content ?? '');
  if (!match) return null;

  const rupiah = Number.parseInt(match[1].replace(/[.,]/g, ''), 10);
  const donorName = match[2].trim();
  if (!Number.isFinite(rupiah) || rupiah <= 0 || !donorName) return null;

  return { donorName, rupiah };
}
