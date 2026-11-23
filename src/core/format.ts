// Player-facing number formatting shared by the simulation's messages and the UI.

/**
 * Money as players read it everywhere: "$8,791", a real minus sign for losses ("−$308"),
 * "+$1,364" with `sign`, and "$1.25M" for big amounts with `compact`.
 */
export function fmtMoney(v: number, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const neg = v < 0;
  const a = Math.abs(Math.round(v));
  let body: string;
  if (opts.compact && a >= 1_000_000) body = `${(a / 1_000_000).toFixed(a >= 10_000_000 ? 1 : 2)}M`;
  else body = a.toLocaleString('en-US');
  const sign = neg && a > 0 ? '−' : opts.sign ? '+' : '';
  return `${sign}$${body}`;
}
