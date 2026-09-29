const stamp = () => new Date().toISOString();

export const logger = {
  info: (msg) => console.log(`[${stamp()}] ${msg}`),
  warn: (msg) => console.warn(`[${stamp()}] WARN  ${msg}`),
  error: (msg) => console.error(`[${stamp()}] ERROR ${msg}`),
};
