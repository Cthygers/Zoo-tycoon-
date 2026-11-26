// routes/public.ts — GET /privacy and GET /account/delete (static HTML, CONTACT_EMAIL substituted at startup).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.js';
import { publicDir } from '../paths.js';

export const CONTACT_PLACEHOLDER = '{{CONTACT_EMAIL}}';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function renderPage(file: string, contactEmail: string, dir: string = publicDir()): string {
  return readFileSync(join(dir, file), 'utf8').split(CONTACT_PLACEHOLDER).join(escapeHtml(contactEmail));
}

export function registerPublic(app: FastifyInstance, ctx: Ctx): void {
  const pages: Record<string, string> = {
    '/privacy': renderPage('privacy.html', ctx.config.contactEmail),
    '/account/delete': renderPage('delete-account.html', ctx.config.contactEmail),
  };
  for (const [path, html] of Object.entries(pages)) {
    app.get(path, async (_req, reply) =>
      reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'public, max-age=3600')
        .send(html),
    );
  }
}
