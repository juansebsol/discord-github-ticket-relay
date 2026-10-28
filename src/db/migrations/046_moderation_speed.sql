-- Ticket management's lists find each open issue's ticket by its issue: without this index that
-- read every ticket in the workspace for every open issue.
CREATE INDEX submissions_issue_filed_idx ON submissions(repo_id, issue_number, created_at) WHERE status = 'created';

-- GitHub's side of the issues opened in Ticket management (the issue and its timeline), so a ticket
-- shows at once and is brought up to date in the background. Removed after 30 days unopened.
CREATE TABLE issue_live (
  repo_id      INTEGER NOT NULL,
  number       INTEGER NOT NULL,
  missing      INTEGER NOT NULL DEFAULT 0,          -- deleted or moved on GitHub
  issue_enc    TEXT,                                -- the issue (title, body, state, labels), encrypted
  events_enc   TEXT,                                -- its timeline (comments, labels, closes, mentions), encrypted
  more         INTEGER NOT NULL DEFAULT 0,          -- GitHub has more events than were read
  fetched_at   INTEGER NOT NULL,
  forgot_at    INTEGER,                             -- a moderator changed it: reads started before are dropped
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX issue_live_fetched_idx ON issue_live(fetched_at);
