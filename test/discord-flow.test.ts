import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { updateApp } from '../src/domain/store.js';
import { EPHEMERAL } from '../src/discord/messages.js';
import { eventually, makeApp, makeWorkspace, member, modalSubmit, nextInteractionId, resetDb, sendInteraction, testDb, type TestEnv } from './helpers.js';

const TICKET = { title: 'Export button does nothing', description: 'Steps: open reports, click export. Expected a CSV, got nothing.' };

let env: TestEnv;
beforeEach(async () => {
  await resetDb();
  env = await makeApp();
});
afterAll(async () => {
  await testDb().end();
});

async function submissions() {
  return (await env.db.query('SELECT * FROM submissions ORDER BY created_at')).rows;
}

describe('Discord interactions endpoint', () => {
  it('rejects requests with an invalid signature and answers PING', async () => {
    expect((await sendInteraction(env, { type: 1 }, { badSignature: true })).statusCode).toBe(401);
    const ping = await sendInteraction(env, { id: '1', type: 1, token: 't' });
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toEqual({ type: 1 });
  });

  it('opens the ticket form for the selected app', async () => {
    const ws = await makeWorkspace(env, { apps: [{ name: 'Mobile App' }, { name: 'Website', repoIndex: 1 }] });
    const res = await sendInteraction(env, {
      id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, channel_id: ws.channelId, member: member(),
      data: { custom_id: 'tr:pick', component_type: 3, values: [ws.apps[1]!.public_id] },
    });
    const body = res.json();
    expect(body.type).toBe(9);
    expect(body.data.custom_id).toBe(`tr:form:${ws.apps[1]!.public_id}:${ws.apps[1]!.repo_id}`);
    expect(body.data.title).toBe('New ticket: Website');
    expect(JSON.stringify(body.data)).not.toContain('org'); // repository details stay hidden
  });

  it('refuses disabled apps and servers that are not set up', async () => {
    const ws = await makeWorkspace(env, { apps: [{ name: 'Old', enabled: false }] });
    const disabled = await sendInteraction(env, {
      id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, member: member(),
      data: { custom_id: 'tr:pick', values: [ws.apps[0]!.public_id] },
    });
    expect(disabled.json().type).toBe(4);
    expect(disabled.json().data.flags).toBe(EPHEMERAL);
    expect(disabled.json().data.embeds[0].title).toBe('App unavailable');

    const unknown = await sendInteraction(env, { id: nextInteractionId(), type: 3, token: 't', guild_id: '123', member: member(), data: { custom_id: 'tr:pick', values: ['X'] } });
    expect(unknown.json().data.embeds[0].title).toBe('Not set up');
  });

  it('pages through more than 25 apps', async () => {
    const ws = await makeWorkspace(env, { apps: Array.from({ length: 30 }, (_, i) => ({ name: `App ${String(i).padStart(2, '0')}` })) });
    const more = await sendInteraction(env, { id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, member: member(), data: { custom_id: 'tr:pick', values: ['__more'] } });
    expect(more.json().type).toBe(4);
    expect(more.json().data.components[0].components[0].options).toHaveLength(25);
    const page2 = await sendInteraction(env, { id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, member: member(), data: { custom_id: 'tr:page:1' } });
    expect(page2.json().type).toBe(7);
    expect(page2.json().data.components[0].components[0].options).toHaveLength(5);
    const pick = await sendInteraction(env, { id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, member: member(), data: { custom_id: 'tr:pickp', values: [ws.apps[29]!.public_id] } });
    expect(pick.json().type).toBe(9);
  });

  it('defers, files the issue in the mapped repository and privately confirms', async () => {
    const ws = await makeWorkspace(env, { apps: [{ name: 'Mobile App', labels: ['bug'] }, { name: 'Website', repoIndex: 1 }] });
    const res = await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, TICKET, { member: { nick: 'Casey the Tester', user: { id: '555000000000000009', username: 'casey', global_name: 'Casey' } } }));
    expect(res.json()).toEqual({ type: 5, data: { flags: EPHEMERAL } });

    const edit = await eventually(async () => env.discord.interactionEdits[0]);
    const issues = env.github.allIssues();
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.repo).toBe(`${env.github.repos.get(ws.repoIds[0]!)!.owner}/mobile`);
    expect(issue.title).toBe('[Mobile App] Export button does nothing');
    expect(issue.labels).toEqual(['bug']);
    expect(issue.body).toContain('Casey the Tester (Discord username: casey)');
    expect(issue.body).toContain('Discord user ID `555000000000000009`');
    expect(issue.body).toContain('Guild');

    const [sub] = await submissions();
    expect(sub.status).toBe('created');
    expect(issue.body).toContain(sub.ref);
    expect(edit.payload.embeds[0].title).toBe('Ticket submitted');
    expect(JSON.stringify(edit.payload)).toContain(`#${issue.number}`);
    expect(JSON.stringify(edit.payload)).toContain(sub.ref);
    expect(edit.payload.embeds[0].description).toMatch(/private repository/);
    expect(edit.payload.allowed_mentions).toEqual({ parse: [] });
  });

  it('routes several apps that share one repository and labels them separately', async () => {
    const ws = await makeWorkspace(env, { apps: [{ name: 'iOS', labels: ['bug'] }, { name: 'Android', labels: ['support'] }] });
    await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, TICKET));
    await sendInteraction(env, modalSubmit(ws, ws.apps[1]!, { title: 'Crash on start', description: 'App crashes when opened on Pixel.' }, { member: member('555000000000000002', 'Robin') }));
    await eventually(async () => env.github.allIssues().length === 2);
    const titles = env.github.allIssues().map((i) => [i.repo, i.title, i.labels[0]]);
    expect(titles).toEqual([
      [expect.stringMatching(/\/mobile$/), '[iOS] Export button does nothing', 'bug'],
      [expect.stringMatching(/\/mobile$/), '[Android] Crash on start', 'support'],
    ]);
  });

  it('echoes the text back when the form is invalid or the app changed while it was open', async () => {
    const ws = await makeWorkspace(env);
    const short = await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, { title: 'ab', description: 'too short' }));
    expect(short.json().data.embeds[0].description).toContain('too short');

    const app = ws.apps[0]!;
    const other = env.github.repos.get(ws.repoIds[1]!)!;
    await updateApp(env.db, ws.workspace.id, app.id, { name: app.name, description: null, repo: { id: other.id, owner: other.owner, name: other.name, private: other.private }, labels: [], enabled: true });
    const stale = await sendInteraction(env, modalSubmit(ws, app, TICKET)); // custom_id still has the old repo ID
    expect(stale.json().data.embeds[0].title).toBe('Please submit again');
    expect(stale.json().data.embeds[0].description).toContain('Export button does nothing');
    expect(await submissions()).toHaveLength(0);
    expect(env.github.createCalls).toBe(0);
  });

  it('processes a repeated delivery of the same interaction only once', async () => {
    const ws = await makeWorkspace(env);
    const body = modalSubmit(ws, ws.apps[0]!, TICKET);
    const [a, b] = await Promise.all([sendInteraction(env, body), sendInteraction(env, body)]);
    expect(a.json().type).toBe(5);
    expect(b.json().type).toBe(5);
    await eventually(async () => (await submissions())[0]?.status === 'created');
    await env.worker.drain();
    expect(await submissions()).toHaveLength(1);
    expect(env.github.createCalls).toBe(1);
  });

  it('blocks accidental duplicate submissions, even when sent concurrently', async () => {
    const ws = await makeWorkspace(env);
    const results = await Promise.all([1, 2, 3].map(() => sendInteraction(env, modalSubmit(ws, ws.apps[0]!, TICKET))));
    const types = results.map((r) => r.json().type).sort();
    expect(types).toEqual([4, 4, 5]);
    const dup = results.find((r) => r.json().type === 4)!.json();
    expect(dup.data.embeds[0].title).toBe('Already submitted');
    await eventually(async () => env.github.allIssues().length === 1);
    expect(await submissions()).toHaveLength(1);

    // Same text from another member is not a duplicate.
    const other = await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, TICKET, { member: member('555000000000000077', 'Sam') }));
    expect(other.json().type).toBe(5);
  });

  it('applies the per-user rate limit configured for the workspace', async () => {
    const ws = await makeWorkspace(env);
    await env.db.query('UPDATE workspaces SET rate_limit_count = 2, rate_limit_window_minutes = 10 WHERE id = $1', [ws.workspace.id]);
    const r1 = await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, { title: 'First problem', description: 'Something broke number one.' }));
    const r2 = await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, { title: 'Second problem', description: 'Something broke number two.' }));
    const r3 = await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, { title: 'Third problem', description: 'Something broke number three.' }));
    expect([r1, r2].map((r) => r.json().type)).toEqual([5, 5]);
    expect(r3.json().type).toBe(4);
    expect(r3.json().data.embeds[0].title).toBe('Please wait a moment');
    expect(r3.json().data.embeds[0].description).toMatch(/about 10 minutes/);
    expect(r3.json().data.embeds[0].description).toContain('Something broke number three.');
    const other = await sendInteraction(env, modalSubmit(ws, ws.apps[0]!, TICKET, { member: member('555000000000000088', 'Kim') }));
    expect(other.json().type).toBe(5);
  });

  it('keeps workspaces isolated: a server only reaches its own apps', async () => {
    const a = await makeWorkspace(env);
    const b = await makeWorkspace(env);
    // Workspace B's server tries to use workspace A's app.
    const res = await sendInteraction(env, { ...modalSubmit(a, a.apps[0]!, TICKET), guild_id: b.guildId });
    expect(res.json().data.embeds[0].title).toBe('App unavailable');
    expect(await submissions()).toHaveLength(0);
  });
});
