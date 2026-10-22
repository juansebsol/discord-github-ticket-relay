-- Analytics: each repository's star total (GitHub's own count) every 30 minutes, with the download
-- snapshot. The star history (repo_stars) says when each star was given; these totals are exact
-- even when someone takes a star back.
CREATE TABLE repo_star_counts (
  repo_id  INTEGER NOT NULL,
  slot_at  INTEGER NOT NULL,
  total    INTEGER NOT NULL,
  PRIMARY KEY (repo_id, slot_at)
);
ALTER TABLE download_sync ADD COLUMN stars_total INTEGER;
