import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox, newSubmissionRef } from '../src/lib/crypto.js';
import { escapeHtml, html } from '../src/lib/html.js';
import { buildIssueBody, buildIssueTitle, neutralizeGitHubMentions, submissionMarker } from '../src/github/issue-content.js';
import { verifyDiscordRequest } from '../src/discord/verify.js';
import { computeBasePermissions, computeChannelPermissions, missingPermissions, Permission } from '../src/discord/permissions.js';
import * as m from '../src/discord/messages.js';
import { modalValues } from '../src/discord/interactions.js';
import { classifyError } from '../src/domain/processor.js';
import { GitHubApiError } from '../src/github/client.js';
import { NetworkError } from '../src/lib/http.js';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 1));
  it('round-trips and authenticates ciphertext', () => {
    const enc = box.encrypt('hunter2');
    expect(enc).not.toContain('hunter2');
    expect(box.decrypt(enc)).toBe('hunter2');
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA');
    expect(() => box.decrypt(tampered)).toThrow();
  });
  it('produces keyed, stable fingerprints', () => {
    expect(box.mac('x')).toBe(box.mac('x'));
    expect(new SecretBox(Buffer.alloc(32, 2)).mac('x')).not.toBe(box.mac('x'));
  });
  it('generates readable submission refs', () => {
    expect(newSubmissionRef()).toMatch(/^TR-[0-9A-HJKMNP-TV-Z]{10}$/);
  });
});

describe('html escaping', () => {
  it('escapes interpolations but not nested templates', () => {
    expect(html`<p>${'<script>'}</p>`.value).toBe('<p>&lt;script&gt;</p>');
    expect(html`<div>${html`<b>${'&'}</b>`}</div>`.value).toBe('<div><b>&amp;</b></div>');
    expect(escapeHtml(`"'`)).toBe('&quot;&#39;');
  });
});

describe('issue content', () => {
  const input = {
    ref: 'TR-ABCDEFGHJK',
    appName: 'Billing | Portal',
    title: 'Export fails',
    description: 'Ping @octocat and @org/team.\n```\n@decorator\n```\nmail me at a@b.com',
    reporterDisplayName: 'Casey',
    reporterUsername: 'casey',
    reporterDiscordId: '555',
    submittedAt: new Date('2026-10-11T12:34:56Z'),
    guildName: 'Acme',
    guildId: '42',
    channelId: '43',
    isTest: false,
  };
  it('includes attribution, context, the stable ID and a hidden marker', () => {
    const body = buildIssueBody(input);
    expect(body).toContain('### Description');
    expect(body).toContain('Discord user ID `555`');
    expect(body).toContain('Casey (Discord username: casey)');
    expect(body).toContain('2026-10-11 12:34:56 UTC');
    expect(body).toContain('`TR-ABCDEFGHJK`');
    expect(body).toContain('Billing \\| Portal');
    expect(body).toContain('created by the Ticket Relay integration on their behalf');
    expect(body.endsWith(submissionMarker('TR-ABCDEFGHJK'))).toBe(true);
  });
  it('neutralizes GitHub mentions outside code only', () => {
    const out = neutralizeGitHubMentions(input.description);
    expect(out).toContain('@​octocat');
    expect(out).toContain('@​org/team');
    expect(out).toContain('\n@decorator\n');
    expect(out).toContain('a@b.com');
  });
  it('prefixes and truncates titles', () => {
    expect(buildIssueTitle('Web', 'Broken\nbutton', false)).toBe('[Web] Broken button');
    expect(buildIssueTitle('Web', 'x', true)).toBe('[Test] [Web] x');
    expect(buildIssueTitle('Web', 'y'.repeat(400), false)).toHaveLength(256);
  });
});

describe('Discord request verification', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const ts = String(now);
  const body = '{"type":1}';
  const sig = sign(null, Buffer.from(ts + body), privateKey).toString('hex');
  it('accepts valid signatures and rejects tampering, missing headers and stale timestamps', () => {
    expect(verifyDiscordRequest(hex, sig, ts, body, now)).toBe(true);
    expect(verifyDiscordRequest(hex, sig, ts, '{"type":2}', now)).toBe(false);
    expect(verifyDiscordRequest(hex, undefined, ts, body, now)).toBe(false);
    expect(verifyDiscordRequest(hex, sig, ts, body, now + 3600)).toBe(false);
    expect(verifyDiscordRequest(hex, 'zz', ts, body, now)).toBe(false);
  });
});

describe('channel permission computation', () => {
  const guild = '1';
  const roles = [
    { id: '1', name: '@everyone', permissions: String(Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES), position: 0 },
    { id: '2', name: 'bot', permissions: String(Permission.EMBED_LINKS | Permission.READ_MESSAGE_HISTORY), position: 1 },
    { id: '3', name: 'admin', permissions: String(Permission.ADMINISTRATOR), position: 2 },
  ];
  it('combines roles and applies overwrites in Discord order', () => {
    const base = computeBasePermissions(guild, '999', 'bot', ['2'], roles);
    expect(missingPermissions(computeChannelPermissions(base, guild, 'bot', ['2'], {}))).toEqual([]);
    const hidden = { permission_overwrites: [{ id: '1', type: 0, allow: '0', deny: String(Permission.VIEW_CHANNEL) }] };
    expect(missingPermissions(computeChannelPermissions(base, guild, 'bot', ['2'], hidden))).toContain('View Channel');
    const roleAllow = { permission_overwrites: [...hidden.permission_overwrites, { id: '2', type: 0, allow: String(Permission.VIEW_CHANNEL), deny: '0' }] };
    expect(missingPermissions(computeChannelPermissions(base, guild, 'bot', ['2'], roleAllow))).toEqual([]);
    const memberDeny = { permission_overwrites: [...roleAllow.permission_overwrites, { id: 'bot', type: 1, allow: '0', deny: String(Permission.SEND_MESSAGES) }] };
    expect(missingPermissions(computeChannelPermissions(base, guild, 'bot', ['2'], memberDeny))).toEqual(['Send Messages', 'Embed Links']);
  });
  it('treats administrators and the owner as having everything', () => {
    const admin = computeBasePermissions(guild, '999', 'bot', ['3'], roles);
    expect(missingPermissions(computeChannelPermissions(admin, guild, 'bot', ['3'], { permission_overwrites: [{ id: '1', type: 0, allow: '0', deny: String(Permission.VIEW_CHANNEL) }] }))).toEqual([]);
    expect(missingPermissions(computeBasePermissions(guild, 'bot', 'bot', [], roles))).toEqual([]);
  });
});

describe('Discord payloads respect platform limits', () => {
  const apps = Array.from({ length: 60 }, (_, i) => ({ publicId: `APP${String(i).padStart(7, '0')}`, name: `App ${i} ${'x'.repeat(120)}`, description: 'd'.repeat(150) }));
  it('fits up to 25 apps in the panel menu directly', () => {
    const panel = m.buildPanelMessage({ title: null, intro: null, apps: apps.slice(0, 25) });
    const select = panel.components[0]!.components[0]!;
    expect(select.options).toHaveLength(25);
    expect(select.options.every((o) => o.label.length <= 100 && (o.description?.length ?? 0) <= 100)).toBe(true);
    expect(panel.allowed_mentions).toEqual({ parse: [] });
  });
  it('adds a "More apps" entry and paginates when there are more than 25', () => {
    const panel = m.buildPanelMessage({ title: null, intro: null, apps });
    const options = panel.components[0]!.components[0]!.options;
    expect(options).toHaveLength(25);
    expect(options[24]!.value).toBe(m.MORE_APPS_VALUE);
    const pages = [0, 1, 2].map((p) => m.buildPickerPage(apps, p));
    const shown = pages.flatMap((p) => (p.components[0]!.components[0] as { options: { value: string }[] }).options.map((o) => o.value));
    expect(new Set(shown).size).toBe(60);
    expect((pages[0]!.components[1]!.components[0] as { disabled: boolean }).disabled).toBe(true);
    expect((pages[2]!.components[1]!.components[1] as { disabled: boolean }).disabled).toBe(true);
    expect(pages[0]!.flags).toBe(m.EPHEMERAL);
  });
  it('builds a modal within limits with guidance and a secrets reminder', () => {
    const modal = m.buildTicketModal({ publicId: 'ABCDEFGHJK', name: 'A very long application name that goes on', repoId: 9, repoPrivate: false });
    expect(modal.title.length).toBeLessThanOrEqual(45);
    expect(modal.custom_id.length).toBeLessThanOrEqual(100);
    expect(modal.components.length).toBeLessThanOrEqual(5);
    const text = (modal.components[0] as { content: string }).content;
    expect(text).toMatch(/steps to reproduce/);
    expect(text).toMatch(/publicly on GitHub/);
    expect(text).toMatch(/passwords, tokens or other secrets/);
    for (const c of modal.components.slice(1) as { label: string; description: string; component: { placeholder: string; max_length: number } }[]) {
      expect(c.label.length).toBeLessThanOrEqual(45);
      expect(c.description.length).toBeLessThanOrEqual(100);
      expect(c.component.placeholder.length).toBeLessThanOrEqual(100);
      expect(c.component.max_length).toBeLessThanOrEqual(4000);
    }
  });
  it('confirmation explains private visibility and disables mentions', () => {
    const msg = m.createdMessage({ appName: '@everyone app', ref: 'TR-1', issueNumber: 12, issueUrl: 'https://github.com/o/r/issues/12', repoPrivate: true });
    expect(msg.flags).toBe(m.EPHEMERAL);
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect(msg.embeds[0]!.description).toMatch(/only works for people with access/);
    expect(msg.embeds[0]!.fields!.map((f) => f.value)).toContain('#12');
    expect(msg.embeds[0]!.fields![0]!.value).not.toContain('@everyone');
  });
  it('reads Label-wrapped and legacy modal values', () => {
    expect(modalValues([{ type: 18, component: { type: 4, custom_id: 'title', value: 'a' } }, { type: 1, components: [{ type: 4, custom_id: 'description', value: 'b' }] }])).toEqual({ title: 'a', description: 'b' });
  });
});

describe('GitHub error classification', () => {
  const sub = { repo_owner: 'o', repo_name: 'r', labels: ['bug'], attempts: 1 } as never;
  it('never retries blindly when the create request may have reached GitHub', () => {
    expect(classifyError(new NetworkError('t', true, 'TIMEOUT'), 'create', sub).type).toBe('uncertain');
    expect(classifyError(new NetworkError('r', true, 'ECONNRESET'), 'create', sub).type).toBe('uncertain');
    expect(classifyError(new GitHubApiError(502, 'Bad gateway', null, false, null), 'create', sub).type).toBe('uncertain');
    expect(classifyError(new NetworkError('x', false, 'ECONNREFUSED'), 'create', sub).type).toBe('retry');
  });
  it('maps definite GitHub failures to actionable outcomes', () => {
    expect(classifyError(new GitHubApiError(403, 'Resource not accessible by integration', null, false, null), 'create', sub)).toMatchObject({ type: 'failed', code: 'missing_permission' });
    expect(classifyError(new GitHubApiError(410, 'Issues are disabled', null, false, null), 'create', sub)).toMatchObject({ type: 'failed', code: 'issues_disabled' });
    expect(classifyError(new GitHubApiError(404, 'Not Found', null, false, null), 'create', sub)).toMatchObject({ type: 'failed', code: 'repo_not_accessible' });
    expect(classifyError(new GitHubApiError(422, 'Validation Failed', null, false, null), 'create', sub).type).toBe('retry_without_labels');
    expect(classifyError(new GitHubApiError(403, 'secondary rate limit', 90, true, null), 'create', sub)).toMatchObject({ type: 'retry', delaySeconds: 90 });
    expect(classifyError(new GitHubApiError(404, 'Not Found', null, false, null), 'token', sub)).toMatchObject({ type: 'failed', code: 'installation_missing' });
  });
});

describe('deployment config', () => {
  const base = { ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') };
  it('reports missing provider variables instead of crashing', () => {
    const c = loadConfig(base);
    expect(c.discord).toBeNull();
    expect(c.missing.discord).toContain('DISCORD_BOT_TOKEN');
    expect(c.missing.github).toContain('GITHUB_APP_PRIVATE_KEY_FILE');
  });
  it('requires a 32-byte encryption key and never enables dev login in production', () => {
    expect(() => loadConfig({ ...base, ENCRYPTION_KEY: 'short' })).toThrow(/32 bytes/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', DEV_LOGIN: 'true' }).devLogin).toBe(false);
    expect(loadConfig({ ...base, DEV_LOGIN: 'true', PUBLIC_URL: 'https://relay.example.com' }).devLogin).toBe(false);
  });

  it('loads the GitHub private key from a file path in either variable and reports bad keys clearly', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const file = path.join(tmpdir(), 'ticket-relay-test-key.pem');
    writeFileSync(file, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    const gh = { ...base, GITHUB_APP_ID: '1', GITHUB_APP_SLUG: 's', GITHUB_CLIENT_ID: 'Iv1', GITHUB_CLIENT_SECRET: 'x' };
    expect(loadConfig({ ...gh, GITHUB_APP_PRIVATE_KEY_FILE: file }).github).not.toBeNull();
    expect(loadConfig({ ...gh, GITHUB_APP_PRIVATE_KEY: file }).github).not.toBeNull(); // common mix-up
    const missing = loadConfig({ ...gh, GITHUB_APP_PRIVATE_KEY_FILE: '/nope/sec.pem' });
    expect(missing.github).toBeNull();
    expect(missing.missing.github.join()).toMatch(/file not found/);
    const garbage = loadConfig({ ...gh, GITHUB_APP_PRIVATE_KEY: 'not-a-key' });
    expect(garbage.missing.github.join()).toMatch(/not a valid private key/);
  });
});
