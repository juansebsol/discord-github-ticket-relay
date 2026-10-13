import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { get, makeApp, makeWorkspace, resetDb, testConfig, testDb, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  await resetDb();
  env = await makeApp({ config: testConfig({ LEGAL_OPERATOR_NAME: 'Acme Labs', LEGAL_CONTACT_EMAIL: 'support@acme.example' }) });
});
afterAll(async () => {
  await testDb().end();
});

describe('legal pages', () => {
  it('serves the Terms of Service and Privacy Policy publicly, as separate pages', async () => {
    for (const [url, title] of [['/terms', 'Terms of Service'], ['/privacy', 'Privacy Policy']]) {
      const res = await env.server.inject({ method: 'GET', url: url! });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain(`<h1>${title}</h1>`);
      expect(res.body).toContain('Acme Labs');
      expect(res.body).toContain('<a href="mailto:support@acme.example">support@acme.example</a>');
      expect(res.body).toContain('including its Discord bot'); // the fake bot shares the product name
    }
    const privacy = await env.server.inject({ method: 'GET', url: '/privacy' });
    expect(privacy.body).toContain('If the repository is public, the issue is public.');
    expect(privacy.body).toContain('We don’t keep your GitHub access token');
  });

  it('falls back to the server administrators when no contact is configured', async () => {
    const bare = await makeApp();
    const res = await bare.server.inject({ method: 'GET', url: '/terms' });
    expect(res.body).toContain('the operator of relay.example.test');
    expect(res.body).toContain('the administrators of the Discord server where you use the bot');
  });

  it('links them from sign-in and lists the URLs on the Deployment page', async () => {
    expect((await env.server.inject({ method: 'GET', url: '/login' })).body).toMatch(/href="\/terms"[\s\S]*href="\/privacy"/);
    const ws = await makeWorkspace(env);
    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/deployment`, ...get(ws.owner) });
    expect(page.body).toContain('value="https://relay.example.test/terms"');
    expect(page.body).toContain('value="https://relay.example.test/privacy"');
    expect(page.body).not.toContain('Set LEGAL_CONTACT_EMAIL');
  });
});
