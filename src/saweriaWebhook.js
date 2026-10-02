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

/**
 * Saweria TERNYATA mengirim template-nya lewat EMBED (title/description),
 * bukan `message.content` -- ketahuan dari `content` yang selalu kosong di
 * pesan asli, walau terlihat ada teks di Discord (itu teks embed). Daripada
 * menebak field yang mana persis, kumpulkan semua kandidat teks yang masuk
 * akal (content + title/description/footer/author tiap embed) supaya tahan
 * banting kalau Saweria ganti-ganti struktur embed-nya.
 *
 * @param {{content?: string, embeds?: Array<{title?: string, description?: string, footer?: {text?: string}, author?: {name?: string}}>}} message
 * @returns {string[]}
 */
export function extractSaweriaCandidateTexts(message) {
  const texts = [];
  if (message?.content) texts.push(message.content);
  for (const embed of message?.embeds ?? []) {
    if (embed?.title) texts.push(embed.title);
    if (embed?.description) texts.push(embed.description);
    if (embed?.footer?.text) texts.push(embed.footer.text);
    if (embed?.author?.name) texts.push(embed.author.name);
  }
  return texts;
}

/** Coba parse tiap kandidat teks dari pesan webhook, balikan hasil pertama yang cocok. */
export function parseSaweriaWebhookEvent(message) {
  for (const text of extractSaweriaCandidateTexts(message)) {
    const parsed = parseSaweriaWebhookMessage(text);
    if (parsed) return parsed;
  }
  return null;
}
