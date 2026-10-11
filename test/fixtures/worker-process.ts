/**
 * A separate OS process that drains the shared SQLite queue, used by the multi-process
 * test. Prints the submission refs this process filed as JSON.
 * Args: <dbPath> <installationId> <repoJson> <startAtMs>
 */
import { openDatabase } from '../../src/db/database.js';
import { FakeGitHub } from '../fakes.js';
import { makeApp } from '../helpers.js';

const [dbPath, installationId, repoJson, startAt] = process.argv.slice(2);
const github = new FakeGitHub();
github.createDelayMs = 15;
const repo = JSON.parse(repoJson!);
github.addInstallation(Number(installationId), repo.owner, [repo]);
const db = openDatabase(dbPath!);
const env = await makeApp({ db, github, instanceId: `proc-${process.pid}` });

// Start together so the processes actually compete for the same rows.
await new Promise((r) => setTimeout(r, Math.max(0, Number(startAt) - Date.now())));
await Promise.all([env.worker.drain(), env.worker.drain()]);
process.stdout.write(JSON.stringify(github.allIssues().map((i) => /submission=(TR-\w+)/.exec(i.body)![1])));
await db.end();
