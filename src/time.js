/**
 * Kunci periode untuk bucket leaderboard, dihitung di zona waktu yang dipilih
 * (default WIB) -- bukan UTC. Tanpa ini, "today" akan berganti jam 7 pagi WIB.
 */
export function periodKeys(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');

  return {
    day: `${year}-${month}-${day}`,
    month: `${year}-${month}`,
    year,
  };
}
