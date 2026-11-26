// test/support/fakeGoogleMain.ts — `npm run fake-google -- [port] [issuer]`: run the fake Google issuer
// for local development and e2e (GET /jwks, GET /token?sub&email&aud&nonce). Ctrl+C stops it.
import { startFakeGoogle } from './fakeGoogle.js';

const port = Number(process.argv[2] ?? process.env.FAKE_GOOGLE_PORT ?? 8799);
const issuer = process.argv[3] || undefined;
const g = await startFakeGoogle(port, issuer);
process.stdout.write(`fake Google on ${g.url}\n  GOOGLE_JWKS_URL=${g.url}/jwks\n  GOOGLE_ISSUERS=${g.issuer}\n  token: ${g.url}/token?sub=parent1&aud=<GOOGLE_CLIENT_IDS>&nonce=<nonce>\n`);
const stop = () => void g.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
