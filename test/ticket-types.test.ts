import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTicketType, listTicketTypes, updateTicketType } from '../src/domain/ticket-types.js';
import { form, get, makeAdmin, makeApp, makeWorkspace, member, modalSubmit, nextInteractionId, resetDb, sendInteraction, testDb, eventually, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env, { apps: [{ name: 'Mobile App', labels: ['support'] }, { name: 'Website', repoIndex: 1 }] });
});
afterAll(async () => {
  await testDb().end();
});

async function addTypes() {
  await createTicketType(env.db, ws.workspace.id, { name: 'Bug report', description: 'Something isn’t working', label: 'bug', title_prefix: 'Bug', guidance: 'Steps to reproduce, expected and actual behavior.', placeholder: '1. Open…  2. Click…', enabled: true });
  await createTicketType(env.db, ws.workspace.id, { name: 'Feature request', description: null, label: 'enhancement', title_prefix: null, guidance: 'What problem would this solve?', placeholder: null, enabled: true });
  return listTicketTypes(env.db, ws.workspace.id);
}

const pickApp = (publicId = ws.apps[0]!.public_id) =>
  sendInteraction(env, { id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, member: member(), data: { custom_id: 'tr:pick', values: [publicId] } });

describe('ticket types in Discord', () => {
  it('keeps the original one-step form when no types exist', async () => {
    expect((await pickApp()).json().type).toBe(9);
  });

  it('asks for a type after the app, then opens that type’s form', async () => {
    const [bug] = await addTypes();
    const step = (await pickApp()).json();
    expect(step.type).toBe(4);
    expect(step.data.flags).toBe(64);
    const select = step.data.components[0].components[0];
    expect(select.custom_id).toBe(`tr:type:${ws.apps[0]!.public_id}:${ws.apps[0]!.repo_id}`);
    expect(select.options.map((o: { label: string }) => o.label)).toEqual(['Bug report', 'Feature request']);
    expect(select.options[0].description).toBe('Something isn’t working');

    const modal = (await sendInteraction(env, { id: nextInteractionId(), type: 3, token: 't', guild_id: ws.guildId, member: member(), data: { custom_id: select.custom_id, values: [bug!.public_id] } })).json();
    expect(modal.type).toBe(9);
    expect(modal.data.custom_id).toBe(`tr:form:${ws.apps[0]!.public_id}:${ws.apps[0]!.repo_id}:${bug!.public_id}`);
    expect(modal.data.title).toBe('Bug report: Mobile App');
    expect(modal.data.components[0].content).toContain('Steps to reproduce, expected and actual behavior.');
    expect(modal.data.components[2].component.placeholder).toBe('1. Open…  2. Click…');
  });

  it('files the issue with the type label, the app labels and a title prefix', async () => {
    const [bug, feature] = await addTypes();
    env.github.repos.get(ws.repoIds[0]!)!.labels.push('enhancement');
    const body = modalSubmit(ws, ws.apps[0]!, { title: 'Export fails', description: 'Click export, nothing happens at all.' });
    body.data.custom_id += `:${bug!.public_id}`;
    await sendInteraction(env, body);
    const feat = modalSubmit(ws, ws.apps[0]!, { title: 'Dark mode', description: 'Please add a dark mode to the app.' }, { member: member('555000000000000002', 'Robin') });
    feat.data.custom_id += `:${feature!.public_id}`;
    await sendInteraction(env, feat);
    await eventually(async () => env.github.allIssues().length === 2);
    const [i1, i2] = env.github.allIssues();
    expect(i1!.title).toBe('[Bug] [Mobile App] Export fails');
    expect(i1!.labels).toEqual(['support', 'bug']);
    expect(i1!.body).toContain('| **Type** | Bug report |');
    expect(i2!.title).toBe('[Feature request] [Mobile App] Dark mode'); // no prefix set: uses the name
    expect(i2!.labels).toEqual(['support', 'enhancement']);
    const page = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/tickets`, ...get(ws.owner) });
    expect(page.body).toContain('Bug report');
  });

  it('still files a ticket whose type was removed while the form was open', async () => {
    const [bug] = await addTypes();
    await updateTicketType(env.db, ws.workspace.id, bug!.id, { ...bug!, enabled: false });
    const body = modalSubmit(ws, ws.apps[0]!, { title: 'Export fails', description: 'Click export, nothing happens at all.' });
    body.data.custom_id += `:${bug!.public_id}`;
    expect((await sendInteraction(env, body)).json().type).toBe(5);
    await eventually(async () => env.github.allIssues().length === 1);
    expect(env.github.allIssues()[0]!).toMatchObject({ title: '[Mobile App] Export fails', labels: ['support'] });
  });
});

describe('ticket types admin', () => {
  it('adds, edits, orders and validates types', async () => {
    const base = `/w/${ws.workspace.id}/tickets/types`;
    const bad = await env.server.inject({ method: 'POST', url: base, ...form(ws.owner, { name: '', enabled: '1' }) });
    expect(bad.statusCode).toBe(400);
    await env.server.inject({ method: 'POST', url: base, ...form(ws.owner, { name: 'Bug report', label: 'bug', title_prefix: 'Bug', enabled: '1' }) });
    await env.server.inject({ method: 'POST', url: base, ...form(ws.owner, { name: 'Question', label: 'question', enabled: '1' }) });
    const dup = await env.server.inject({ method: 'POST', url: base, ...form(ws.owner, { name: 'bug report', enabled: '1' }) });
    expect(dup.body).toContain('already exists');
    const [, question] = await listTicketTypes(env.db, ws.workspace.id);
    await env.server.inject({ method: 'POST', url: `${base}/${question!.id}/move`, ...form(ws.owner, { direction: 'up' }) });
    expect((await listTicketTypes(env.db, ws.workspace.id)).map((t) => t.name)).toEqual(['Question', 'Bug report']);

    const types = await env.server.inject({ method: 'GET', url: base, ...get(ws.owner) });
    expect(types.body).toContain('Ticket types');
    // The repos have "bug" and "support" by default, but not "question".
    expect(types.body).toContain('<code>question</code> is missing');
    const panel = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/tickets/panel`, ...get(ws.owner) });
    expect(panel.body).toContain('What kind of ticket is this?');
  });

  it('creates missing labels only when the admin clicks the button', async () => {
    await createTicketType(env.db, ws.workspace.id, { name: 'Question', description: null, label: 'question', title_prefix: null, guidance: null, placeholder: null, enabled: true });
    await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/tickets/types`, ...get(ws.owner) });
    expect(env.github.repos.get(ws.repoIds[0]!)!.labels).not.toContain('question');
    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/tickets/types/create-labels`, ...form(ws.owner) });
    expect(env.github.repos.get(ws.repoIds[0]!)!.labels).toContain('question');
    expect(env.github.repos.get(ws.repoIds[1]!)!.labels).toContain('question');
  });

  it('updates the panel steps and is isolated per workspace', async () => {
    await addTypes();
    await env.server.inject({ method: 'POST', url: `/w/${ws.workspace.id}/tickets/panel`, ...form(ws.owner, { intent: 'publish' }) });
    const msg = [...env.discord.messages.values()][0]!;
    expect(msg.payload.embeds[0].description).toContain('2. Pick what kind of ticket it is.');
    const other = await makeWorkspace(env, { owner: await makeAdmin(env) });
    const res = await env.server.inject({ method: 'GET', url: `/w/${ws.workspace.id}/tickets/types/new`, ...get(other.owner) });
    expect(res.statusCode).toBe(404);
  });
});
