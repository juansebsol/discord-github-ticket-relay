import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { handleInteraction, type Interaction } from '../../discord/interactions.js';
import { verifyDiscordRequest } from '../../discord/verify.js';
import { setGitHubStatusByInstallation } from '../../domain/store.js';
import { safeEqual } from '../../lib/crypto.js';
import type { Web } from '../server.js';

export function verifyGitHubSignature(secret: string, signature: string | undefined, rawBody: string): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return safeEqual(expected, signature);
}

export function registerWebhookRoutes(app: FastifyInstance, web: Web): void {
  const { deps, processor } = web;

  /** Discord Interactions Endpoint URL. Every request is signature-checked. */
  app.post('/discord/interactions', async (req, reply) => {
    if (!deps.discord) return reply.code(503).send({ error: 'Discord is not configured' });
    const valid = verifyDiscordRequest(
      deps.discord.config.publicKey,
      req.headers['x-signature-ed25519'] as string | undefined,
      req.headers['x-signature-timestamp'] as string | undefined,
      req.rawBody ?? '',
    );
    if (!valid) return reply.code(401).send({ error: 'invalid request signature' });

    const interaction = req.body as Interaction;
    const result = await handleInteraction(deps, processor, interaction);
    if (result.after) {
      // Start slow work (creating the GitHub issue) only after Discord has its response.
      const after = result.after;
      reply.raw.once('finish', () => {
        after().catch((err) => deps.log.error({ err: (err as Error).message }, 'post-response processing failed'));
      });
    }
    return reply.code(200).send(result.response);
  });

  /** Optional GitHub App webhook: keeps connection status current when the app is uninstalled or suspended. */
  app.post('/github/webhook', async (req, reply) => {
    const secret = deps.github && deps.config.github?.webhookSecret;
    if (!secret) return reply.code(404).send();
    if (!verifyGitHubSignature(secret, req.headers['x-hub-signature-256'] as string | undefined, req.rawBody ?? '')) {
      return reply.code(401).send({ error: 'invalid signature' });
    }
    const event = req.headers['x-github-event'];
    const body = req.body as { action?: string; installation?: { id?: number; account?: { login?: string } } };
    const installationId = body.installation?.id;
    if (event === 'installation' && typeof installationId === 'number') {
      const account = body.installation?.account?.login ?? 'the account';
      if (body.action === 'deleted') {
        await setGitHubStatusByInstallation(deps.db, installationId, 'removed', `The GitHub App was uninstalled from ${account}.`);
      } else if (body.action === 'suspend') {
        await setGitHubStatusByInstallation(deps.db, installationId, 'suspended', `The GitHub App installation on ${account} was suspended.`);
      } else if (body.action === 'unsuspend' || body.action === 'new_permissions_accepted') {
        await setGitHubStatusByInstallation(deps.db, installationId, 'active', null);
      }
      deps.log.info({ event, action: body.action, installationId }, 'github installation event');
    }
    return reply.code(204).send();
  });
}
