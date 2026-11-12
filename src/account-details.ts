export type UsageWindow = { remaining: number; resetsAt: number | null };
export type AccountUsage = { fiveHour: UsageWindow | null; weekly: UsageWindow | null; updatedAt: number; unavailable?: boolean };
export function parseUsage(response: any): AccountUsage {
  const bucket = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits;
  const windows = [bucket?.primary, bucket?.secondary];
  const window = (minutes: number): UsageWindow | null => {
    const value = windows.find(w => w?.windowDurationMins === minutes);
    if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return null;
    return { remaining: Math.max(0, Math.min(100, 100 - value.usedPercent)), resetsAt: typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : null };
  };
  return { fiveHour: window(300), weekly: window(10080), updatedAt: Date.now() };
}
export function profilePicture(raw: string): string | null {
  try {
    const auth = JSON.parse(raw);
    const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString());
    const url = new URL(claims.picture);
    const host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (host === 'lh3.googleusercontent.com' || host.endsWith('.googleusercontent.com') || host === 'cdn.auth0.com' || host.endsWith('.oaistatic.com') || host === 'cdn.openai.com') return url.href;
  } catch {}
  return null;
}
export function photoType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && Buffer.from(bytes.slice(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0,4)).toString() === 'RIFF' && Buffer.from(bytes.slice(8,12)).toString() === 'WEBP') return 'image/webp';
  return null;
}
