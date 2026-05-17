export function resolvePublicAssetUrl(path = '') {
  const value = String(path || '').trim();
  if (!value) return '';
  if (/^(?:https?:)?\/\//.test(value) || value.startsWith('/')) return value;
  if (value.startsWith('../public/')) return value;
  if (value.startsWith('public/')) return `../${value}`;
  return `../public/${value.replace(/^\.\//, '')}`;
}
