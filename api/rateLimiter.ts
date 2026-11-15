/**
 * Rate limiting for unauthenticated callers.
 *
 * Two lessons are baked in here:
 *
 * 1. The limiter must key on the *real* client. Behind Cloudflare/Traefik every
 *    socket shares the proxy's address, so socket-keyed limits turn one noisy
 *    visitor into a global outage. Forwarded headers are only honoured when the
 *    immediate peer is in a configured trusted-proxy list.
 * 2. Fixed windows must not let a caller double their allowance by straddling a
 *    boundary, so each key tracks a rolling window per tier.
 *
 * All state is in memory and lossy on restart: for an unauthenticated endpoint
 * that is the right trade — the limits exist to stop casual abuse, and a restart
 * costs an attacker nothing they could not get by waiting.
 */

export interface RateLimitTier {
  name: string;
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT_TIERS = {
  /** Cheap: decode bounds, fit, respond. Sized for one person correcting a lot. */
  preset: { name: 'preset', limit: 60, windowMs: 60_000 },
  /** Correction is CPU work; keep it tighter than the cheap path. */
  correct: { name: 'correct', limit: 20, windowMs: 60_000 },
  /** Wrong words are a guess loop, so this tier is deliberately small. */
  passphrase: { name: 'passphrase', limit: 10, windowMs: 15 * 60_000 },
  /** Whole-service ceiling, so one subnet cannot own the CPU. */
  correctGlobal: { name: 'correct-global', limit: 600, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitTier>;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

interface Slot {
  used: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly slots = new Map<string, Slot>();
  private readonly maxKeys: number;

  constructor(options: { maxKeys?: number } = {}) {
    // Bounded so a spoofed-header flood cannot grow this map without limit.
    this.maxKeys = options.maxKeys ?? 50_000;
  }

  check(key: string, tier: RateLimitTier, now = Date.now()): RateLimitDecision {
    const slot = this.slots.get(key);
    if (!slot || now >= slot.resetAt) {
      if (this.slots.size >= this.maxKeys) this.evict(now);
      this.slots.set(key, { used: 1, resetAt: now + tier.windowMs });
      return {
        allowed: true,
        limit: tier.limit,
        remaining: tier.limit - 1,
        resetAt: now + tier.windowMs,
        retryAfterSeconds: 0,
      };
    }
    if (slot.used >= tier.limit) {
      return {
        allowed: false,
        limit: tier.limit,
        remaining: 0,
        resetAt: slot.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((slot.resetAt - now) / 1000)),
      };
    }
    slot.used += 1;
    return {
      allowed: true,
      limit: tier.limit,
      remaining: tier.limit - slot.used,
      resetAt: slot.resetAt,
      retryAfterSeconds: 0,
    };
  }

  /** Drop expired windows; if none expired, drop the soonest-resetting entries. */
  private evict(now: number): void {
    for (const [key, slot] of this.slots) {
      if (now >= slot.resetAt) this.slots.delete(key);
    }
    if (this.slots.size < this.maxKeys) return;
    const ordered = [...this.slots.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of ordered.slice(0, Math.ceil(this.maxKeys / 10))) {
      this.slots.delete(key);
    }
  }

  reset(): void {
    this.slots.clear();
  }
}

/** Normalised IPv4/IPv6 text, or null when the value is not a bare address. */
function parseAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    return octets.join('.');
  }
  // IPv6 literals may be bracketed in headers.
  const bare = trimmed.replace(/^\[|\]$/g, '');
  if (/^[0-9a-f:]+$/i.test(bare) && bare.includes(':')) return bare.toLowerCase();
  return null;
}

/**
 * Resolve the client address. `trustedProxies` is an explicit allowlist: only
 * when the TCP peer is listed do forwarded headers get any weight, and even
 * then the leftmost *untrusted* hop wins so a client cannot spoof its own IP by
 * prepending a header.
 */
export function resolveClientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxies: readonly string[]
): string {
  const peer = socketAddress ? parseAddress(socketAddress) : null;
  if (!peer) return 'unknown';
  if (!trustedProxies.includes(peer)) return peer;

  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  if (!raw) return peer;
  const hops = raw
    .split(',')
    .map((hop) => parseAddress(hop))
    .filter((hop): hop is string => hop !== null);
  // Walk from the closest hop backwards: the first untrusted address is the
  // real client. Anything a caller prepends sits further left and is ignored.
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    if (!trustedProxies.includes(hops[index])) return hops[index];
  }
  return hops.length > 0 ? hops[0] : peer;
}

/**
 * Coarse grouping for the service-wide ceiling: IPv6 neighbours share a /64 in
 * practice, so charging them individually would let one host rotate freely.
 */
export function rateLimitGroup(address: string): string {
  if (!address.includes(':')) return address;
  const groups = address.split(':');
  return `${groups.slice(0, 4).join(':')}::/64`;
}
