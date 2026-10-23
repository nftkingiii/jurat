import { ONECLICK } from './config';

export interface Token {
  assetId: string;
  symbol: string;
  decimals: number;
}

/** The tokens a request offers first; any other 1Click NEAR asset still works. */
const PREFERRED = ['USDC', 'USDT', 'wNEAR', 'BTC', 'ETH', 'ZEC'];

export async function loadTokens(): Promise<Token[]> {
  const res = await fetch(`${ONECLICK}/v0/tokens`);
  if (!res.ok) throw new Error(`1Click token list: HTTP ${res.status}`);
  const all: any[] = await res.json();
  const near = all.filter((t) => t.blockchain === 'near' && typeof t.assetId === 'string' && Number.isInteger(t.decimals));
  const seen = new Set<string>();
  const out: Token[] = [];
  for (const sym of PREFERRED) {
    const t = near.find((x) => x.symbol === sym);
    if (t && !seen.has(t.assetId)) {
      seen.add(t.assetId);
      out.push({ assetId: t.assetId, symbol: t.symbol, decimals: t.decimals });
    }
  }
  return out;
}

/** "1.5" with 6 decimals -> "1500000". Throws on anything that is not a plain amount. */
export function toUnits(amount: string, decimals: number): string {
  const m = amount.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error('Enter an amount like 250 or 12.5');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  const units = (m[1] + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  if (units === '0') throw new Error('Enter an amount above zero');
  return units;
}

/** "1500000" with 6 decimals -> "1.5". */
export function fromUnits(units: string, decimals: number): string {
  const s = units.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals).replace(/^0+(?=\d)/, '');
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac}` : whole;
}

export function symbolFor(assetId: string, tokens: Token[]): Token | undefined {
  return tokens.find((t) => t.assetId === assetId);
}
