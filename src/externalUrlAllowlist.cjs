const ALLOWED_EXTERNAL_ORIGINS = [
  'https://quavence.com',
  'https://www.quavence.com',
  'https://lmstudio.ai',
  'https://github.com',
  'https://discord.gg',
  'https://discord.com',
];

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedExternalUrl(url) {
  const target = String(url || '').trim();
  if (!target) return false;
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:') return false;
    const origin = `${parsed.protocol}//${parsed.host}`.toLowerCase();
    return ALLOWED_EXTERNAL_ORIGINS.includes(origin);
  } catch {
    return false;
  }
}

module.exports = {
  ALLOWED_EXTERNAL_ORIGINS,
  isAllowedExternalUrl,
  normalizeOrigin,
};
