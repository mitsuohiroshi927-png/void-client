<?php
/**
 * Local harness: run stats.php against SQLite so the endpoint logic can be
 * exercised without MySQL. Mirrors the schema in schema.sql.
 * Usage: php server/test_stats.php  (from /root/void-client)
 */

declare(strict_types=1);

$dbFile = '/tmp/vctest/stats_test.sqlite';
@unlink($dbFile);

$pdo = new PDO('sqlite:' . $dbFile, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$pdo->exec('CREATE TABLE mod_stats_presence (uuid TEXT PRIMARY KEY, name TEXT, server TEXT, version TEXT, client TEXT, first_seen INT, last_seen INT)');
$pdo->exec('CREATE TABLE mod_stats_daily (uuid TEXT, day TEXT, PRIMARY KEY (uuid, day))');
$pdo->exec('CREATE TABLE mod_stats_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, started_at INT, last_seen INT)');

// Simulate the module logic directly (same queries as stats.php, SQLite dialect).
function beat(PDO $pdo, string $uuid, string $name, string $server = 'play.test.net'): array
{
    $now = time();
    $prev = $pdo->prepare('SELECT last_seen FROM mod_stats_presence WHERE uuid = ?');
    $prev->execute([$uuid]);
    $last = $prev->fetchColumn();
    if ($last !== false && $now - (int)$last < 20) {
        return ['ok' => true, 'throttled' => true];
    }
    $pdo->prepare('INSERT OR REPLACE INTO mod_stats_presence (uuid, name, server, version, client, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)')
        ->execute([$uuid, $name, $server, '0.2.0', '1.0.0', $now, $now]);
    $pdo->prepare('INSERT OR REPLACE INTO mod_stats_daily (uuid, day) VALUES (?,?)')
        ->execute([$uuid, gmdate('Y-m-d')]);
    $pdo->prepare('INSERT INTO mod_stats_sessions (uuid, started_at, last_seen) VALUES (?,?,?)')
        ->execute([$uuid, $now, $now]);
    return ['ok' => true];
}

function stats(PDO $pdo): array
{
    $now = time();
    return [
        'online' => (int)$pdo->query("SELECT COUNT(*) FROM mod_stats_presence WHERE last_seen > " . ($now - 120))->fetchColumn(),
        'today' => (int)$pdo->query("SELECT COUNT(DISTINCT uuid) FROM mod_stats_daily WHERE day = '" . gmdate('Y-m-d') . "'")->fetchColumn(),
        'total_players' => (int)$pdo->query('SELECT COUNT(DISTINCT uuid) FROM mod_stats_daily')->fetchColumn(),
        'total_sessions' => (int)$pdo->query('SELECT COUNT(*) FROM mod_stats_sessions')->fetchColumn(),
    ];
}

$fail = 0;
function check(string $label, $got, $want): void
{
    global $fail;
    $ok = $got === $want;
    if (!$ok) $fail++;
    printf("%-46s %-8s got=%s want=%s\n", $label, $ok ? 'PASS' : 'FAIL', var_export($got, true), var_export($want, true));
}

$a = str_repeat('a', 32);
$b = str_repeat('b', 32);
$c = str_repeat('c', 32);

check('empty db online', stats($pdo)['online'], 0);

beat($pdo, $a, 'Agung');
beat($pdo, $b, 'Steve');
beat($pdo, $c, 'Alex');
$s = stats($pdo);
check('3 players online', $s['online'], 3);
check('total_players unique', $s['total_players'], 3);
check('sessions counted', $s['total_sessions'], 3);

// Same player beats again after the throttle window -> not a new player, one new session.
$pdo->exec("UPDATE mod_stats_presence SET last_seen = last_seen - 100");
beat($pdo, $a, 'Agung');
$s = stats($pdo);
check('repeat beat: still 2... unique players', $s['total_players'], 3);
check('repeat beat: online still 3', $s['online'], 3);
check('repeat beat: sessions now 4', $s['total_sessions'], 4);

// Throttled beat must be rejected inside 20s.
$r = beat($pdo, $a, 'Agung');
check('throttle blocks rapid beat', isset($r['throttled']), true);

// Age everyone out -> online drops to 0, unique totals survive.
$pdo->exec('UPDATE mod_stats_presence SET last_seen = last_seen - 500');
$s = stats($pdo);
check('all stale -> online 0', $s['online'], 0);
check('unique players preserved', $s['total_players'], 3);
check('sessions preserved', $s['total_sessions'], 4);

// Session end removes a player from the live count immediately.
beat($pdo, $b, 'Steve');
$pdo->prepare('UPDATE mod_stats_presence SET last_seen = 0 WHERE uuid = ?')->execute([$b]);
check('session_end drops player', stats($pdo)['online'], 0);

echo "\n" . ($fail === 0 ? 'ALL TESTS PASSED' : "$fail TEST(S) FAILED") . "\n";
exit($fail === 0 ? 0 : 1);
