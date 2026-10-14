import type { FastifyInstance } from 'fastify';
import { html, type SafeHtml } from '../../lib/html.js';
import { botIdentity } from '../discord-preview.js';
import { legalPage } from '../layout.js';
import type { Web } from '../server.js';

/** Bump when either document changes in substance. */
const LAST_UPDATED = 'October 13, 2026';

/**
 * Public Terms of Service and Privacy Policy. Discord asks for both URLs before a bot can be
 * verified. The text describes what this codebase actually stores and shares; keep it in
 * sync when data handling changes (submissions, contributor verification, sessions, logs).
 */
export function registerLegalRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const host = new URL(deps.config.publicUrl).host;
  const operator = deps.config.legal.operatorName ?? `the operator of ${host}`;
  const email = deps.config.legal.contactEmail;
  const contact: SafeHtml = email
    ? html`<a href="mailto:${email}">${email}</a>`
    : html`the administrators of the Discord server where you use the bot, who can pass your request on to us`;

  /** The bot's Discord name, and how to refer to it when it shares the product's name. */
  async function names() {
    const service = 'Ticket Relay';
    const bot = (await botIdentity(deps)).name;
    const theBot: SafeHtml = bot === service ? html`its Discord bot` : html`the Discord bot <strong>${bot}</strong>`;
    return { service, bot, theBot };
  }

  app.get('/terms', async (_req, reply) => {
    const { service, theBot } = await names();
    const body = html`
      <h2>1. About these terms</h2>
      <p>${service} (the “Service”) is run by ${operator} (“we”, “us”). It includes ${theBot}, the web console at <a href="${deps.config.publicUrl}">${host}</a> and the GitHub App that files issues. By using the Service, for example by opening a ticket, verifying as a contributor or signing in to the console, you agree to these terms and to our <a href="/privacy">Privacy Policy</a>. If you don’t agree, don’t use the Service.</p>

      <h2>2. What the Service does</h2>
      <ul>
        <li><strong>Tickets.</strong> Members of a Discord server pick an app and fill in a short form. The Service files the ticket as an issue in the GitHub repository the server’s administrators chose for that app, and sends the member a private confirmation.</li>
        <li><strong>Contributor roles.</strong> Members can sign in with GitHub so the Service can count their merged pull requests or commits in the server’s repositories and give them a matching Discord role.</li>
        <li><strong>Console.</strong> Server owners, admins and moderators manage setup and tickets in the web console after signing in with Discord.</li>
        <li><strong>AI triage (optional).</strong> If a server’s administrators turn it on, an AI model reviews filed tickets and may label them, comment on them, update the member’s private confirmation in Discord, or close them as duplicates, spam or questions for the community, as the administrators configured. Its calls can be wrong; administrators can review and undo them on GitHub.</li>
      </ul>

      <h2>3. Who can use it</h2>
      <p>You must be allowed to use Discord under its terms, including its minimum age for your country, and follow the rules of the server where you use the bot. If you add the bot to a server or connect a GitHub account or repository, you confirm that you have the authority to do so.</p>

      <h2>4. Your tickets and content</h2>
      <ul>
        <li>You are responsible for what you submit. Only submit information you have the right to share.</li>
        <li><strong>Never include passwords, access tokens, payment details or other secrets</strong>, or other people’s personal information.</li>
        <li>Tickets become GitHub issues. If the repository is <strong>public, anyone on the internet can read the issue</strong>, including your Discord display name and username. The form tells you whether the repository is public or private before you submit.</li>
        <li>You allow us to store, process and send your submission to GitHub and Discord as needed to run the Service. Once an issue exists on GitHub, the repository’s owners control it, and GitHub’s terms apply to it.</li>
      </ul>

      <h2>5. Acceptable use</h2>
      <p>Don’t use the Service to:</p>
      <ul>
        <li>send spam, repeated or automated submissions, or try to get around the rate limits;</li>
        <li>post content that is illegal, harassing, hateful, sexually explicit or infringes someone else’s rights;</li>
        <li>share malware or links meant to deceive or harm people;</li>
        <li>impersonate others, or verify a GitHub account that isn’t yours;</li>
        <li>probe, attack or disrupt the Service, or access data you aren’t authorized to see.</li>
      </ul>
      <p>Server administrators can close tickets and revoke contributor roles, and we may block use of the Service that breaks these rules.</p>

      <h2>6. Server administrators</h2>
      <p>If you set up the Service for a Discord server, you decide which repositories receive tickets, who can access the console and what moderators may do. You are responsible for that configuration, for telling your members how their tickets are handled, and for following Discord’s and GitHub’s terms in your server and repositories.</p>

      <h2>7. Discord and GitHub</h2>
      <p>The Service relies on Discord and GitHub, and your use of them is governed by the <a href="https://discord.com/terms" rel="noopener noreferrer">Discord Terms of Service</a> and the <a href="https://docs.github.com/site-policy/github-terms/github-terms-of-service" rel="noopener noreferrer">GitHub Terms of Service</a>. ${service} is not made, endorsed or sponsored by Discord or GitHub.</p>

      <h2>8. Availability and changes</h2>
      <p>We try to keep the Service running and to file every ticket exactly once, but we don’t guarantee that it will always be available or free of errors. We may change, suspend or discontinue features at any time.</p>

      <h2>9. Ending your use</h2>
      <p>You can stop using the Service at any time: members can simply stop using the bot, and administrators can remove the bot from their server and uninstall the GitHub App. We may suspend or end access for anyone who breaks these terms or puts the Service or its users at risk.</p>

      <h2>10. Disclaimers and liability</h2>
      <p>The Service is provided “as is” and “as available”, without warranties of any kind, to the extent the law allows. To the extent the law allows, we are not liable for indirect, incidental or consequential damages, or for lost data, content or profits, arising from your use of the Service. Nothing in these terms limits rights you have under laws that can’t be waived.</p>

      <h2>11. Changes to these terms</h2>
      <p>We may update these terms. When we do, we change the date at the top of this page. If you keep using the Service after a change, you accept the updated terms.</p>

      <h2>12. Contact</h2>
      <p>Questions about these terms: ${contact}.</p>`;
    return reply.type('text/html').send(legalPage({
      title: 'Terms of Service',
      updated: LAST_UPDATED,
      intro: html`<p>These terms apply to ${service}, including ${theBot}.</p>`,
      body,
    }));
  });

  app.get('/privacy', async (_req, reply) => {
    const { service, theBot } = await names();
    const body = html`
      <h2>1. Who we are</h2>
      <p>${service} (the “Service”), including ${theBot} and the web console at <a href="${deps.config.publicUrl}">${host}</a>, is run by ${operator} (“we”, “us”). This policy explains what we collect, why, who it is shared with and how long we keep it. Contact: ${contact}.</p>

      <h2>2. What we collect</h2>
      <h3>When you open a ticket</h3>
      <ul>
        <li>Your Discord user ID, username and display name.</li>
        <li>The Discord server’s ID and name and the channel ID where you opened the ticket.</li>
        <li>What you submit: the app and ticket type you pick, the title and the description.</li>
        <li>The time of the submission, its status, the GitHub issue it became, and a keyed fingerprint of the text used to spot duplicate submissions.</li>
        <li>A short-lived token from Discord that lets the bot update your private confirmation message.</li>
      </ul>
      <h3>When you verify as a contributor</h3>
      <ul>
        <li>Your GitHub account ID and username, from the GitHub sign-in you start.</li>
        <li>The number of merged pull requests or commits you have in the server’s repositories, and the role you were given.</li>
        <li>Your Discord user ID and name, linked to that GitHub account for this server.</li>
      </ul>
      <p>We use the GitHub sign-in only to confirm which account is yours. We don’t keep your GitHub access token, and we never post or change anything on GitHub on your behalf.</p>
      <h3>When you use the console</h3>
      <ul>
        <li>Your Discord user ID, username, display name and avatar, and your role in each workspace.</li>
        <li>A session cookie that keeps you signed in, and an encrypted Discord access token used to list the servers you manage.</li>
        <li>Actions you take, for example who closed or retried a ticket or revoked a role.</li>
        <li>Workspace settings: the connected GitHub account and repositories, the Discord server, channels and roles, and the panel text.</li>
      </ul>
      <h3>When a server uses AI triage</h3>
      <ul>
        <li>The model’s assessment of each ticket: its priority, possible duplicates, spam, a short reason and the tokens used.</li>
        <li>The server’s triage settings and its Claude API key, stored encrypted and never shown again after it’s saved.</li>
      </ul>
      <h3>What we don’t collect</h3>
      <p>The bot doesn’t read messages in your server. It only receives the panel interactions you start. We don’t use analytics, advertising or tracking cookies. The only cookies are the ones needed to sign in and keep forms secure.</p>

      <h2>3. How we use it</h2>
      <ul>
        <li>To file your ticket as a GitHub issue, send you a private confirmation and retry if GitHub is unavailable, without filing the same ticket twice.</li>
        <li>To limit spam and duplicate submissions.</li>
        <li>To check contributions and give or remove contributor roles.</li>
        <li>If the server turned on AI triage, to suggest a priority and spot duplicates or spam.</li>
        <li>To let server administrators and moderators manage tickets and settings.</li>
        <li>To keep the Service secure and fix problems.</li>
      </ul>

      <h2>4. Who we share it with</h2>
      <ul>
        <li><strong>GitHub.</strong> The issue contains your ticket’s title and description, the app and type, your Discord display name and username, your Discord user ID, the server’s name and ID, the channel ID, the submission time and a reference number. <strong>If the repository is public, the issue is public.</strong> The form tells you which before you submit.</li>
        <li><strong>Discord.</strong> To show panels, send your confirmation and add or remove roles.</li>
        <li><strong>The server’s administrators and moderators</strong> can see the tickets and contributor verifications for their server in the console.</li>
        <li><strong>Anthropic</strong>, only if the server’s administrators turn on AI triage. The ticket’s app, type, title and description, plus the titles and short excerpts of open issues in the same repository, are sent to Anthropic’s Claude API to assess the ticket. Anthropic processes them under its commercial terms and <a href="https://www.anthropic.com/legal/privacy" rel="noopener noreferrer">privacy policy</a>.</li>
        <li><strong>Our hosting provider</strong> stores the data on our behalf.</li>
        <li><strong>Authorities</strong>, if the law requires it.</li>
      </ul>
      <p>We don’t sell your personal information or use it for advertising.</p>

      <h2>5. How long we keep it</h2>
      <ul>
        <li><strong>Ticket text</strong> is stored encrypted. Once the GitHub issue is created, we delete the description from our database; it lives on in the issue. The remaining text (the title) is deleted after the retention period the server sets (30 days by default). Text of tickets that couldn’t be filed is kept for at least 90 days so administrators can retry them.</li>
        <li><strong>Ticket records</strong> (reporter, status, issue link and reference) are kept as the server’s ticket history until the workspace is deleted, or until you ask us to delete them.</li>
        <li><strong>Confirmation tokens</strong> from Discord expire after 15 minutes. <strong>Console sessions</strong> expire after 7 days.</li>
        <li><strong>Contributor verifications</strong> and the link to your GitHub account are kept until an administrator revokes them or the workspace is deleted.</li>
        <li><strong>Triage results</strong> are kept with the ticket record. We don’t store the ticket text for triage; it’s read from the GitHub issue when the ticket is assessed.</li>
        <li><strong>Server logs</strong> record technical events such as request paths and errors, but not cookies, tokens, OAuth codes or what you submit. Our web server may keep standard access logs, including IP addresses, for a limited time for security.</li>
      </ul>
      <p>Deleting data here doesn’t delete GitHub issues or Discord messages. Those are controlled by the repository owners and by Discord.</p>

      <h2>6. Security</h2>
      <p>Ticket text and access tokens are encrypted at rest (AES-256-GCM), all traffic uses HTTPS, and console access is limited to people the server’s owner invites, with roles and permissions. No system is perfectly secure, but we work to protect your information and only keep what the Service needs.</p>

      <h2>7. Your choices and rights</h2>
      <ul>
        <li>You can ask us for a copy of your information, or ask us to correct or delete it, by contacting ${contact}. We may ask you to confirm that the Discord account is yours.</li>
        <li>You can ask a server’s administrators to close your ticket, or to revoke your contributor role and unlink your GitHub account.</li>
        <li>To remove a GitHub issue, contact the repository’s owners. To revoke the Service’s access to your GitHub account, go to GitHub › Settings › Applications.</li>
        <li>Depending on where you live, you may have more rights, such as objecting to processing or complaining to a data protection authority.</li>
      </ul>

      <h2>8. Children</h2>
      <p>The Service is not meant for anyone below Discord’s minimum age in their country. If you believe a child has given us personal information, contact us and we will delete it.</p>

      <h2>9. Where data is processed</h2>
      <p>The Service runs on servers that may be in a different country from yours. Discord and GitHub process data under their own privacy policies: <a href="https://discord.com/privacy" rel="noopener noreferrer">Discord Privacy Policy</a> and <a href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement" rel="noopener noreferrer">GitHub Privacy Statement</a>.</p>

      <h2>10. Changes to this policy</h2>
      <p>We may update this policy. When we do, we change the date at the top of this page.</p>

      <h2>11. Contact</h2>
      <p>Questions or requests about your information: ${contact}.</p>`;
    return reply.type('text/html').send(legalPage({
      title: 'Privacy Policy',
      updated: LAST_UPDATED,
      intro: html`<p>This policy explains how ${service}, including ${theBot}, handles your information.</p>`,
      body,
    }));
  });
}
