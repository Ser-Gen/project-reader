/**
 * Let `node --test` import the sources directly.
 *
 * The app is bundled by Vite, so TypeScript modules import each other with the
 * `.js` specifiers TypeScript wants. Node strips types natively but resolves
 * specifiers literally, so this hook retries a failed `./x.js` as `./x.ts`.
 * It exists only for tests; nothing in `src/` knows about it.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const asTs = specifier.slice(0, -3) + '.ts';
    try {
      const candidate = new URL(asTs, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return next(asTs, context);
    } catch {
      /* fall through to the normal resolution and let it report the error */
    }
  }
  return next(specifier, context);
}
