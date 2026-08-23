// Shared slide validator for the two extra-slide sources — --extras (a file)
// and --roast (model output). Whatever the origin, the page owns shape, field
// length, and count. Kept in its own module so index.ts and roast.ts can both
// import it without a cycle.

import { z } from 'zod';

import type { WrappedExtra } from './types.ts';

// Fields arrive unparsed (a file or model output); non-strings degrade to
// undefined/'' and the length caps below decide what survives.
const rawExtraSchema = z.object({
  headline: z.string().catch(''),
  title: z.string().optional().catch(undefined),
  subline: z.string().optional().catch(undefined),
  footnote: z.string().optional().catch(undefined),
});

export function coerceExtras(parsed: unknown[]): WrappedExtra[] {
  // Cap by code points, not UTF-16 units — String.slice can split a surrogate
  // pair and leave a lone half that renders as U+FFFD on the slide.
  const cap = (s: string | undefined, n: number): string | undefined => {
    if (s === undefined || s.trim().length === 0) return undefined;
    return [...s.trim()].slice(0, n).join('');
  };
  const out: WrappedExtra[] = [];
  for (const item of parsed.slice(0, 6)) {
    const o = rawExtraSchema.safeParse(item);
    if (!o.success) continue;
    const headline = cap(o.data.headline, 120);
    if (!headline) continue;
    out.push({
      headline,
      title: cap(o.data.title, 60),
      subline: cap(o.data.subline, 200),
      footnote: cap(o.data.footnote, 160),
    });
  }
  return out;
}
