/** Registers the `.js` -> `.ts` resolution hook used by the test runner. */
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
