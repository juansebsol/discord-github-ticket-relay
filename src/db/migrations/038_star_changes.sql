-- Analytics stars: GitHub won't list who starred a repository for the app (that needs more than
-- its permissions), so the star history (repo_stars) never filled and its reads were marked done.
-- Stars now come from the repository's star total, read every 30 minutes with the downloads: each
-- read keeps how much the total changed since the read before, per 30-minute slot (a star taken
-- back counts -1). Nothing is known from before this starts.
DROP TABLE IF EXISTS repo_stars;
DROP TABLE IF EXISTS repo_star_counts;
CREATE TABLE repo_star_changes (
  repo_id  INTEGER NOT NULL,
  slot_at  INTEGER NOT NULL,
  change   INTEGER NOT NULL,
  PRIMARY KEY (repo_id, slot_at)
);
ALTER TABLE download_sync RENAME COLUMN stars_loaded_at TO stars_started_at;  -- the first star count read
ALTER TABLE download_sync RENAME COLUMN stars_until_at TO stars_slot_at;      -- the slot of the last one
ALTER TABLE download_sync ADD COLUMN stars_error TEXT;
UPDATE download_sync SET stars_started_at = NULL, stars_slot_at = NULL, stars_total = NULL;
