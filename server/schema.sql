-- VOID Client presence stats — schema for server/stats.php
-- MySQL 5.7+ / MariaDB 10.2+. Run once in phpMyAdmin or `mysql < schema.sql`.

CREATE TABLE IF NOT EXISTS mod_stats_presence (
  uuid       CHAR(32)     NOT NULL,
  name       VARCHAR(32)  NOT NULL DEFAULT '',
  server     VARCHAR(128) NOT NULL DEFAULT '',
  version    VARCHAR(32)  NOT NULL DEFAULT '',
  client     VARCHAR(32)  NOT NULL DEFAULT '',
  first_seen INT UNSIGNED NOT NULL,
  last_seen  INT UNSIGNED NOT NULL,
  PRIMARY KEY (uuid),
  KEY idx_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per player per UTC day. COUNT(DISTINCT uuid) here is a real
-- unique-player count; it never double-counts restarts or alt sessions.
CREATE TABLE IF NOT EXISTS mod_stats_daily (
  uuid CHAR(32) NOT NULL,
  day  DATE     NOT NULL,
  PRIMARY KEY (uuid, day),
  KEY idx_day (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mod_stats_sessions (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid       CHAR(32)        NOT NULL,
  started_at INT UNSIGNED    NOT NULL,
  last_seen  INT UNSIGNED    NOT NULL,
  PRIMARY KEY (id),
  KEY idx_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
