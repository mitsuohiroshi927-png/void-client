<?php
/**
 * VOID Client — player presence endpoint.
 *
 * Deploy on any host that can run PHP, then set Settings → statsUrl to its URL
 * (the launcher appends "?action=stats"). Nothing points here by default: settings.js
 * ships statsUrl: '' and the UI then shows honest local numbers only.
 *
 * NOTE: this endpoint CANNOT live on GitHub Pages or Cloudflare Pages — both serve
 * static files only, so the community-presence feature needs a PHP host or stays off.
 * That is why it is deliberately not wired into the repo's own deploy step.
 *
 * Contract
 *   POST  ?action=heartbeat   body: {"uuid":"...","name":"...","server":"play.example.net","version":"0.2.0","client":"1.0.0"}
 *   POST  ?action=session_end  body: {"uuid":"..."}
 *   GET   ?action=stats       -> {"ok":true,"online":N,"today":N,"total_players":N,"total_sessions":N}
 *
 * A player counts as ONLINE while their last heartbeat is under 120s old, which
 * is why the mod beats every 60s: one dropped beat never drops them from the count.
 */

declare(strict_types=1);

const ONLINE_WINDOW_SEC = 120;
const HEARTBEAT_FLOOR_SEC = 20; // per-UUID write throttle, anti-spam

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

const DB_HOST = 'localhost';
const DB_NAME = 'voidclient';
const DB_USER = 'voidclient';
const DB_PASS = 'CHANGE_ME';

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $pdo = new PDO(
            'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
            DB_USER,
            DB_PASS,
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false]
        );
    }
    return $pdo;
}

function body(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $j = json_decode($raw, true);
    return is_array($j) ? $j : [];
}

function out(array $payload, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/** Cheap abuse control: 60 requests / minute / IP. */
function rateLimit(): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    $key = sys_get_temp_dir() . '/voidstats_' . md5($ip);
    $now = time();
    $hits = [];
    if (is_file($key)) {
        $hits = array_filter(
            (array)json_decode((string)file_get_contents($key), true),
            static fn($t) => is_int($t) && $t > $now - 60
        );
    }
    if (count($hits) >= 60) {
        out(['ok' => false, 'error' => 'rate limited'], 429);
    }
    $hits[] = $now;
    @file_put_contents($key, json_encode(array_values($hits)), LOCK_EX);
}

try {
    $action = $_GET['action'] ?? '';

    if ($action === 'heartbeat') {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
            out(['ok' => false, 'error' => 'POST required'], 405);
        }
        rateLimit();
        $b = body();
        $uuid = strtolower(trim((string)($b['uuid'] ?? '')));
        if (!preg_match('/^[0-9a-f]{32}$/', $uuid)) {
            out(['ok' => false, 'error' => 'uuid must be 32 hex chars'], 400);
        }
        $name = substr(preg_replace('/[^\w .\-]/u', '', (string)($b['name'] ?? '')) ?? '', 0, 32);
        $server = substr(trim((string)($b['server'] ?? '')), 0, 128);
        $version = substr(trim((string)($b['version'] ?? '')), 0, 32);
        $client = substr(trim((string)($b['client'] ?? '')), 0, 32);
        $now = time();

        $pdo = db();

        // Anti-spam: ignore repeats inside the throttle window.
        $prev = $pdo->prepare('SELECT last_seen FROM mod_stats_presence WHERE uuid = ?');
        $prev->execute([$uuid]);
        $lastSeen = $prev->fetchColumn();
        if ($lastSeen !== false && $now - (int)$lastSeen < HEARTBEAT_FLOOR_SEC) {
            out(['ok' => true, 'throttled' => true]);
        }

        $pdo->prepare(
            'INSERT INTO mod_stats_presence (uuid, name, server, version, client, last_seen, first_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               name = VALUES(name), server = VALUES(server), version = VALUES(version),
               client = VALUES(client), last_seen = VALUES(last_seen)'
        )->execute([$uuid, $name, $server, $version, $client, $now, $now]);

        // One row per (uuid, day) — total_players is unique, not inflated by restarts.
        $pdo->prepare(
            'INSERT INTO mod_stats_daily (uuid, day) VALUES (?, ?)
             ON DUPLICATE KEY UPDATE day = VALUES(day)'
        )->execute([$uuid, gmdate('Y-m-d')]);

        // Raw session log, capped by pruning in `stats`.
        $pdo->prepare('INSERT INTO mod_stats_sessions (uuid, started_at, last_seen) VALUES (?, ?, ?)')
            ->execute([$uuid, $now, $now]);

        out(['ok' => true]);
    }

    if ($action === 'session_end') {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
            out(['ok' => false, 'error' => 'POST required'], 405);
        }
        $uuid = strtolower(trim((string)(body()['uuid'] ?? '')));
        if (!preg_match('/^[0-9a-f]{32}$/', $uuid)) {
            out(['ok' => false, 'error' => 'bad uuid'], 400);
        }
        $pdo = db();
        // Drop them from the live count immediately instead of waiting out the window.
        $pdo->prepare('UPDATE mod_stats_presence SET last_seen = 0 WHERE uuid = ?')->execute([$uuid]);
        out(['ok' => true]);
    }

    if ($action === 'stats') {
        $pdo = db();
        $now = time();
        $online = (int)$pdo->query(
            'SELECT COUNT(*) FROM mod_stats_presence WHERE last_seen > ' . ($now - ONLINE_WINDOW_SEC)
        )->fetchColumn();
        $today = (int)$pdo->query(
            'SELECT COUNT(DISTINCT uuid) FROM mod_stats_daily WHERE day = ' . $pdo->quote(gmdate('Y-m-d'))
        )->fetchColumn();
        $totalPlayers = (int)$pdo->query('SELECT COUNT(DISTINCT uuid) FROM mod_stats_daily')->fetchColumn();
        $totalSessions = (int)$pdo->query('SELECT COUNT(*) FROM mod_stats_sessions')->fetchColumn();

        // Keep the table from growing without bound.
        if (mt_rand(1, 20) === 1) {
            $pdo->exec('DELETE FROM mod_stats_sessions WHERE last_seen < ' . ($now - 86400 * 90));
        }

        out([
            'ok' => true,
            'online' => $online,
            'today' => $today,
            'total_players' => $totalPlayers,
            'total_sessions' => $totalSessions,
            'window' => ONLINE_WINDOW_SEC,
        ]);
    }

    out(['ok' => false, 'error' => 'unknown action'], 404);
} catch (Throwable $e) {
    error_log('voidstats: ' . $e->getMessage());
    out(['ok' => false, 'error' => 'server error'], 500);
}
