-- AI triage › Knowledge: your team's answers to the questions Claude asked about an app, one per
-- question ({question, answer, by, byName, at}). Claude reads them with every ticket, as trusted.
ALTER TABLE app_knowledge ADD COLUMN team_answers TEXT NOT NULL DEFAULT '[]';
