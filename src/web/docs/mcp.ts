/**
 * MCP › Docs: how to connect a coding agent and work with it, every tool, claims, what's safe and
 * what to do when something's wrong. Also the setup snippets the Connect tab shows.
 */
import { MCP_GROUPS, MCP_SWITCH_KEYS, MCP_SWITCHES, type McpSwitch } from '../../domain/permissions.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { CLAIM_DAYS, MAX_CLAIMS } from '../../mcp/claims.js';
import { PROMPTS } from '../../mcp/prompts.js';
import { LIMITS } from '../../mcp/server.js';
import { TOOLS } from '../../mcp/tools.js';
import { EXPIRY_DAYS } from '../../mcp/tokens.js';
import { copyBtn, tag } from '../ui.js';
import { docNote, docPage } from './page.js';

const PLACEHOLDER = 'trm_YOUR_TOKEN';

/** How to add the server to each agent, with a token (or a placeholder). */
function clients(url: string, token: string) {
  return [
    { id: 'claude', name: 'Claude Code', where: html`Run it in a terminal. <code>--scope user</code> adds it for every project; leave it out for this project only.`, text: `claude mcp add --transport http --scope user ticket-relay ${url} --header "Authorization: Bearer ${token}"` },
    { id: 'cursor', name: 'Cursor', where: html`In <code>~/.cursor/mcp.json</code> for every project, or <code>.cursor/mcp.json</code> in one.`, text: JSON.stringify({ mcpServers: { 'ticket-relay': { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
    { id: 'vscode', name: 'VS Code', where: html`In <code>.vscode/mcp.json</code>, or your user configuration (<em>MCP: Open User Configuration</em>).`, text: JSON.stringify({ servers: { 'ticket-relay': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
    { id: 'codex', name: 'Codex', where: html`In <code>~/.codex/config.toml</code>, with the token in the <code>TICKET_RELAY_TOKEN</code> environment variable.`, text: `# In your shell profile: export TICKET_RELAY_TOKEN="${token}"\n[mcp_servers.ticket-relay]\nurl = "${url}"\nbearer_token_env_var = "TICKET_RELAY_TOKEN"` },
    { id: 'other', name: 'Other', where: html`Any agent that connects to remote MCP servers over HTTP (Streamable HTTP).`, text: `URL:    ${url}\nHeader: Authorization: Bearer ${token}` },
  ];
}

/** One agent at a time, with a copy button (app.js switches them; without it they're all shown). */
export function setupTabs(url: string, token: string | null): SafeHtml {
  const list = clients(url, token ?? PLACEHOLDER);
  return html`<div class="mcp-setup" data-mcp-tabs>
    <div class="seg js-only" role="tablist" aria-label="Your coding agent">${list.map((c, i) => html`<button type="button" class="seg-item" role="tab" id="mcp-tab-${c.id}" aria-controls="mcp-pane-${c.id}" aria-selected="${i === 0 ? 'true' : 'false'}" data-mcp-tab="${c.id}">${c.name}</button>`)}</div>
    ${list.map((c) => html`<div class="mcp-pane" id="mcp-pane-${c.id}" role="tabpanel" aria-labelledby="mcp-tab-${c.id}" data-mcp-pane="${c.id}">
      <div class="nojs mcp-pane-name">${c.name}</div>
      <p class="small muted">${c.where}${token ? '' : html` Put your token where it says <code>${PLACEHOLDER}</code>.`}</p>
      <div class="mcp-code"><pre>${c.text}</pre>${copyBtn(c.text, `Copy the ${c.name} setup`)}</div>
    </div>`)}
  </div>`;
}

const fn = (name: string) => html`<code>${name}</code>`;

/** Every tool behind a switch, under its switch's name. */
function toolList(group: string): SafeHtml {
  const keys = MCP_SWITCH_KEYS.filter((k) => MCP_SWITCHES[k].group === group);
  return html`<dl class="docs-tools">${keys.map((k: McpSwitch) => html`
    <dt>${MCP_SWITCHES[k].name}${'github' in MCP_SWITCHES[k] ? tag('GitHub', { cls: 'subtle' }) : ''}<span class="fns">${TOOLS.filter((t) => t.switch === k).map((t) => fn(t.name))}</span></dt>
    <dd>${TOOLS.filter((t) => t.switch === k).map((t) => html`<p>${t.description}</p>`)}</dd>`)}</dl>`;
}

export function mcpDocs(o: { base: string; url: string; admin: boolean; on: boolean }): SafeHtml {
  const examples: [string, SafeHtml][] = [
    ['What should I work on in PhotoCraft?', html`Finds the most urgent unclaimed tickets (${fn('find_tickets')}), reads the top one (${fn('get_ticket')}) and offers to claim it.`],
    ['Which tickets does this branch fix?', html`Reads your commits and changes, then ${fn('find_related')} with them: tickets to write as “Fixes #N”, and ones only related.`],
    ['Is #412 fixed? Did it ship?', html`${fn('get_ticket')} and ${fn('find_related')}: the pull request that fixes it, whether it’s merged, and the release it went out in.`],
    ['Is anyone already working on the export crash?', html`${fn('find_related')} with your words: open pull requests that look related, and who claimed the tickets.`],
    ['How many open bugs came in this week, per label?', html`${fn('count_tickets')} with <code>created_after: 7d</code>, grouped by label.`],
    ['What did the last release fix, and what came in since?', html`${fn('get_release')}: its pull requests and the tickets they fixed, what’s merged but not released, and new tickets since.`],
    ['Close the duplicates of #412.', html`${fn('find_tickets')} in Repeat bugs, checks each, asks you, then ${fn('close_ticket')} as duplicates. Each can be undone for 15 minutes.`],
    ['What’s on my plate?', html`${fn('my_work')}: your claims, any open pull request for each, and what you did lately.`],
  ];

  const sections = [
    {
      id: 'overview',
      title: 'How it works',
      body: html`<p>MCP (Model Context Protocol) is how coding agents use outside tools. Ticket Relay is one: an agent connected to it can find tickets, read everything about one, see what’s related, claim it and, if you allow it, change it on GitHub.</p>
        <ul>
          <li><strong>It acts as you.</strong> The agent can do what your MCP tools allow, nothing more. Admins and owners have every tool; a moderator has the ones an admin switched on.</li>
          <li><strong>One token per device.</strong> You make it here, paste it into your agent once, and it stays connected until the token expires or is revoked.</li>
          <li><strong>Reading costs nothing.</strong> Answers come from what Ticket Relay already keeps (the copy of every issue and pull request, triage, Moderation’s lists), so asking is quick and doesn’t use up GitHub’s limits.</li>
        </ul>`,
    },
    {
      id: 'setup',
      title: 'Get connected',
      body: html`<ol class="docs-steps">
          ${o.admin ? html`<li><strong>Turn MCP on</strong> (admins) on the <a href="${o.base}/mcp">Connect</a> tab.${o.on ? html` ${tag('Done', { cls: 'subtle' })}` : ''}</li>
          <li><strong>Choose moderators’ tools</strong> (admins) in <a href="${o.base}/members#moderator-access">Members &amp; permissions</a> › a moderator › MCP · coding agents. Turn on Read for those who should look things up, and Write only for those who should change tickets.</li>` : ''}
          <li><strong>Make a token</strong> on the <a href="${o.base}/mcp#connect">Connect</a> tab. Name it after the device (“Laptop, Claude Code”). Copy it: it’s shown once.</li>
          <li><strong>Add Ticket Relay to your agent</strong> with the token:</li>
        </ol>
        ${setupTabs(o.url, null)}
        <ol class="docs-steps" start="${o.admin ? '5' : '3'}">
          <li><strong>Check it’s connected.</strong> In Claude Code, <code>/mcp</code> lists <em>ticket-relay</em> as connected. Then ask: “Use Ticket Relay to list the apps.”</li>
        </ol>`,
    },
    {
      id: 'tokens',
      title: 'Tokens',
      body: html`<ul>
          <li><strong>Read &amp; write</strong> tokens can use every tool you have. <strong>Read only</strong> ones can only find and read, even though you can write: use them for agents that run on their own. If you have no write tools, your tokens are read only.</li>
          <li>They expire after ${EXPIRY_DAYS.map((d) => (d === 365 ? '1 year' : `${d} days`)).join(', ')}${o.admin ? ', or never (admins only)' : ''}. The Connect tab shows when each was last used, and from what.</li>
          <li>Treat a token like a password: don’t commit it to a repository or paste it in a chat. If one leaks, revoke it and make another; the agent using it is cut off on its next call.</li>
          <li>Removing someone from the workspace revokes their tokens.</li>
        </ul>`,
    },
    {
      id: 'asking',
      title: 'Asking your agent',
      body: html`<p>Ask in your own words; the agent picks the tools. A few that work well:</p>
        <div class="table-wrap"><table class="docs-table"><thead><tr><th>You ask</th><th>What it does</th></tr></thead>
          <tbody>${examples.map(([ask, what]) => html`<tr><td>“${ask}”</td><td>${what}</td></tr>`)}</tbody></table></div>
        <h3>Ready-made prompts</h3>
        <p>Longer jobs come ready-made. In Claude Code they’re slash commands: type <code>/mcp__ticket-relay__</code> and pick one. Other agents list them with the server’s prompts. You only see the ones your tools allow.</p>
        <dl class="docs-tools">${PROMPTS.map((p) => html`<dt>${p.title}<span class="fns">${fn(`/mcp__ticket-relay__${p.name}`)}${p.args.length ? html` <span class="muted">${p.args.map((a) => `${a.name}${a.required ? '' : ' (optional)'}`).join(', ')}</span>` : ''}</span></dt><dd><p>${p.description}</p></dd>`)}</dl>`,
    },
    {
      id: 'naming',
      title: 'Naming tickets',
      body: html`<p>Agents can name a ticket any of these ways:</p>
        <ul>
          <li><code>owner/repo#123</code>, or <code>repo#123</code>.</li>
          <li><code>#123</code>, when only one connected repository has an issue 123.</li>
          <li>A GitHub link to the issue or pull request.</li>
          <li>A Discord ticket’s reference, like <code>TR-7KQ2M9XA4D</code>.</li>
        </ul>`,
    },
    {
      id: 'read',
      title: 'Read tools',
      body: html`<p>${MCP_GROUPS.find((g) => g.key === 'read')!.desc}</p>${toolList('read')}
        <h3>Filters for finding and counting</h3>
        <p>${fn('find_tickets')} and ${fn('count_tickets')} take the same filters, all optional: <code>app</code>, <code>state</code> (open, closed, all), <code>list</code> (repeat, fixed, quiet, spam, old), <code>source</code> (discord, github), <code>priority</code>, <code>labels</code> and <code>without_labels</code>, <code>claimed</code> (me, anyone, nobody), <code>has_pr</code>, <code>min_reports</code>, <code>created_after</code>/<code>before</code> and <code>updated_after</code>/<code>before</code> (a date or a span like <code>7d</code>), and <code>text</code>. Counting groups by one or two of app, priority, label, list, source, state, claimed, has_pr, week or month.</p>`,
    },
    {
      id: 'write',
      title: 'Write tools',
      body: html`<p>${MCP_GROUPS.find((g) => g.key === 'write')!.desc}</p>${toolList('write')}
        <dl class="docs-tools"><dt>Undo<span class="fns">${fn('undo')}</span></dt><dd><p>${TOOLS.find((t) => t.name === 'undo')!.description} Comes with Close or Saved replies.</p></dd></dl>
        ${docNote(html`Agents never write comments of their own: they can only post your <a href="${o.base}/moderation/replies">saved replies</a> and close reasons’ comments, worded by your admins.`)}`,
    },
    {
      id: 'claims',
      title: 'Claims',
      body: html`<p>A claim says “I’m on it”, so two people don’t fix the same bug. It’s kept in Ticket Relay: nothing is written to GitHub.</p>
        <ul>
          <li>One person per ticket, up to ${String(MAX_CLAIMS)} at a time each.</li>
          <li>A claim ends when you release it or the ticket closes. It lapses after ${String(CLAIM_DAYS)} days without your agent reading the ticket, unless a pull request for it is open.</li>
          <li>Write “Fixes #123” in your pull request: the claim stays while it’s open, and GitHub closes the issue when it merges.</li>
          <li>Claims show in Ticket management on the ticket, and on the <a href="${o.base}/mcp#claims">Connect</a> tab, where admins can release anyone’s.</li>
        </ul>`,
    },
    {
      id: 'safety',
      title: 'What keeps it safe',
      body: html`<ul>
          <li>Agents reach only these tools: nothing else on the server, no files, no settings, no comments of their own.</li>
          <li>Every call checks the token and the person’s tools at that moment, so a change in Members &amp; permissions applies on the agent’s next call.</li>
          <li>Changes on GitHub show in the <a href="${o.base}/moderation/log">Mod log</a> under the person’s name, marked “via MCP”. Closes and replies can be undone for 15 minutes.</li>
          <li>Coding agents ask before running a tool that changes something, unless you’ve told them not to.</li>
          <li>Each token is limited to ${String(LIMITS.requests)} requests, ${String(LIMITS.calls)} tool calls and ${String(LIMITS.actions)} changes a minute.</li>
        </ul>
        ${docNote(html`Ticket text, comments and pull request descriptions are written by members and the public. Agents are told to treat them as information, never instructions, but check what your agent proposes before letting it change tickets, especially several at once.`, 'warn')}`,
    },
    {
      id: 'trouble',
      title: 'When something’s wrong',
      body: html`<div class="table-wrap"><table class="docs-table"><thead><tr><th>Your agent says</th><th>What to do</th></tr></thead><tbody>
          <tr><td>The token doesn’t work (401)</td><td>It was revoked or expired, or you’re no longer a member. Make a new one on the Connect tab and update your agent.</td></tr>
          <tr><td>MCP is off (403)</td><td>An admin turned it off. Your tokens work again once it’s back on.</td></tr>
          <tr><td>Your access doesn’t include a tool</td><td>Ask an admin to switch it on. Then reconnect so the agent reloads its tools (in Claude Code: <code>/mcp</code>, then reconnect).</td></tr>
          <tr><td>The token is read-only</td><td>Make a Read &amp; write token, if you have write tools.</td></tr>
          <tr><td>Moderation is off</td><td>Changes on GitHub need Moderation turned on, in Moderation › Replies &amp; reasons.</td></tr>
          <tr><td>Too many calls or changes a minute</td><td>Wait a minute. Ask the agent to work through fewer tickets at a time.</td></tr>
          <tr><td>GitHub’s hourly limit is used up</td><td>Wait a few minutes. Reading tickets doesn’t need GitHub, so only fresh comments and changes wait.</td></tr>
          <tr><td>It doesn’t show up at all</td><td>Check the address and the header: <code>Authorization: Bearer trm_…</code>. In Claude Code, <code>claude mcp list</code> shows whether it connected.</td></tr>
        </tbody></table></div>`,
    },
    ...(o.admin ? [{
      id: 'admins',
      title: 'For admins',
      body: html`<ul>
          <li><strong>On or off:</strong> the Connect tab. Off cuts every agent at once; tokens and claims are kept for when it’s back.</li>
          <li><strong>Who can do what:</strong> <a href="${o.base}/members#moderator-access">Members &amp; permissions</a> › a moderator › MCP · coding agents. Each tool is its own switch, apart from the pages: seeing Ticket management doesn’t let their agent find tickets. The Read and Write switches turn a whole group on or off.</li>
          <li><strong>Tokens:</strong> everyone’s are on the Connect tab, with when they were last used. Revoke any of them there.</li>
          <li><strong>Claims:</strong> release anyone’s on the Connect tab.</li>
          <li><strong>What agents changed:</strong> the <a href="${o.base}/moderation/log">Mod log</a>, marked “via MCP”.</li>
        </ul>`,
    }] : []),
  ];

  return docPage({
    intro: html`<h1>Using Ticket Relay from your coding agent</h1><p>Connect Claude Code, Cursor, VS Code or Codex once, then ask about tickets in your own words: what to work on, what a branch fixes, whether a bug is fixed and released.</p>`,
    sections,
  });
}
