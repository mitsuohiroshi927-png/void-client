#!/usr/bin/env python3
"""Translate every remaining Indonesian string in the web copy to English.

site/ and docs/ are the same pages in two places and MUST stay in sync, so each
replacement is applied to both and asserted on each. Anything that fails to match is
reported and makes the script exit non-zero — a silent miss here is how the two copies
drift apart.
"""
import pathlib
import sys

ROOT = pathlib.Path('/root/void-client')

# ---------------------------------------------------------------- download.html
DOWNLOAD = [
    ("<h2>Launcher Minecraft yang cepat, ringan, siap main.</h2>",
     "<h2>A Minecraft launcher that is fast, light, and ready to play.</h2>"),
    ("Jalan di semua versi Minecraft 1.21.x. Fabric sudah terpasang, VOID Client sudah termasuk\n    di dalamnya, dan mod bisa dipasang langsung dari launcher tanpa nyari file manual.",
     "Runs every Minecraft 1.21.x version. Fabric is already installed, VOID Client is bundled\n    in, and mods install straight from the launcher \u2014 no hunting for files."),
    ("&#11015; Download untuk Windows", "&#11015; Download for Windows"),
    ("Versi 1.2.5 &middot; 122 MB", "Version 1.2.5 &middot; 122 MB"),
    ("<h3>&#9888; Windows akan menampilkan peringatan</h3>",
     "<h3>&#9888; Windows will show a warning</h3>"),
    ("Saat menjalankan installer, Windows mungkin menampilkan",
     "When you run the installer, Windows may show"),
    ("Ini karena installer-nya belum punya sertifikat digital berbayar &mdash;",
     "That is because the installer carries no paid digital certificate &mdash;"),
    ("<b>bukan karena ada virus.</b>",
     "<b>not because anything is wrong with the file.</b>"),
    ("<b>Cara mengatasinya:</b> klik", "<b>How to get past it:</b> click"),
    ("Kalau kamu ragu, kode sumbernya bisa dibaca bebas di",
     "If you would rather check first, the source is public at the"),
    ("repository GitHub</a> &mdash; jadi kamu bisa lihat sendiri\n      apa yang dijalankan sebelum kamu pasang.",
     "GitHub repository</a> &mdash; you can read exactly\n      what runs before you install anything."),
    ("<h3>Cara install</h3>", "<h3>How to install</h3>"),
    ("<li>Klik tombol Download di atas.</li>", "<li>Click Download above.</li>"),
    ("<li>Buka file <code>", "<li>Open <code>"),
    ("<li>Kalau muncul peringatan Windows &rarr;",
     "<li>If Windows warns you &rarr;"),
    ("<li>Klik Next sampai selesai, lalu buka VOID Client dari Start Menu.</li>",
     "<li>Click Next through the installer, then open VOID Client from the Start Menu.</li>"),
    ("<li>Pilih versi Minecraft, buat profil, tekan PLAY. Java 21 diurus otomatis.</li>",
     "<li>Pick a Minecraft version, make a profile, press PLAY. Java 21 is handled for you.</li>"),
    ("<h3>Yang kamu dapat</h3>", "<h3>What you get</h3>"),
    ("Semua versi Minecraft 1.21.x, Fabric Loader sudah terpasang",
     "Every Minecraft 1.21.x version, with Fabric Loader ready to go"),
    ("VOID Client tertanam &mdash; boost performa tanpa install mod manual",
     "VOID Client bundled in &mdash; the performance boost without manual mod installs"),
    ("Mod dari Modrinth bisa dipasang langsung dari launcher, terpisah per profil",
     "Mods install from Modrinth inside the launcher, isolated per profile"),
    ("Resolusi Auto (ikut hardware) atau Custom, tinggal pilih",
     "Resolution on Auto (follows your hardware) or Custom, your choice"),
    ("Java 21 diunduh &amp; diverifikasi otomatis, RAM diatur sendiri",
     "Java 21 downloaded and checksum-verified, RAM tuned to your hardware"),
    ("Discord Rich Presence, statistik komunitas, notifikasi toast",
     "Discord Rich Presence, community stats, toast notifications"),
    ("<h3>Kebutuhan sistem</h3>", "<h3>System requirements</h3>"),
    ("<td>Sistem operasi</td>", "<td>Operating system</td>"),
    ("<td>Minimal 4 GB, disarankan 8 GB</td>", "<td>4 GB minimum, 8 GB recommended</td>"),
    ("<td>Mendukung OpenGL 3.2</td>", "<td>OpenGL 3.2 support</td>"),
    ("<td>Tidak perlu install manual</td>", "<td>Nothing to install &mdash; handled</td>"),
    ("<h3>Verifikasi file unduhan</h3>", "<h3>Verify your download</h3>"),
    ("Kalau mau memastikan file-nya utuh dan tidak diubah siapa pun, bandingkan SHA-256:",
     "To confirm the file is intact and unmodified, compare the SHA-256:"),
    ("Di Windows, buka PowerShell di folder unduhan lalu jalankan:",
     "On Windows, open PowerShell in your download folder and run:"),
    ("VOID Client adalah proyek independen dan tidak berafiliasi dengan Mojang atau Microsoft.",
     "VOID Client is an independent project, not affiliated with Mojang or Microsoft."),
]

# ------------------------------------------------------------------- mods.html
MODS = [
    ("Ini daftar lengkap mod yang dipasang launcher saat kamu centang paket Performance di tab Mods.",
     "The full list of mods the launcher installs when you tick the Performance pack on the Mods tab."),
    ("Semuanya dari Modrinth, semuanya sisi klien &mdash; tidak ada yang perlu dipasang di server.",
     "All from Modrinth, all client-side &mdash; nothing needs installing on a server."),
    ("Klik nama mod untuk buka halaman Modrinth-nya.",
     "Click a mod name to open its Modrinth page."),
    ("&#8592; Kembali ke beranda", "&#8592; Back to home"),
    ("<b>Catatan.</b> Mod yang tidak punya rilis untuk versi Minecraft yang kamu pilih akan\n        dilewati, bukan dipaksa dipasang &mdash; itu cara paling aman supaya profil tidak gagal boot.",
     "<b>Note.</b> A mod with no release for the Minecraft version you picked is\n        skipped rather than forced in &mdash; that is the safe way to keep a profile booting."),
    ("Paket ini juga bukan syarat: kalau satu unduhan gagal, sisanya tetap terpasang dan\n        Minecraft tetap bisa dibuka.",
     "The pack is not all-or-nothing either: if one download fails, the rest still install\n        and Minecraft still opens."),
    ("proyek independen, tidak berafiliasi dengan Mojang atau Microsoft.",
     "independent project, not affiliated with Mojang or Microsoft."),
]

failures = []


def apply(rel, pairs):
    p = ROOT / rel
    if not p.exists():
        failures.append(f'{rel}: file missing')
        return 0
    s = p.read_text(encoding='utf-8')
    n = 0
    for old, new in pairs:
        c = s.count(old)
        if c == 0:
            failures.append(f'{rel}: NOT FOUND -> {old[:70]!r}')
            continue
        s = s.replace(old, new)
        n += c
    p.write_text(s, encoding='utf-8')
    return n


for rel in ('site/download.html', 'docs/download.html'):
    print(f'  {rel}: {apply(rel, DOWNLOAD)} replacements')
for rel in ('site/mods.html', 'docs/mods.html'):
    print(f'  {rel}: {apply(rel, MODS)} replacements')

# ------------------------------------------------- release notes (4 manifests)
NOTES = ('Update 1.2.5.\n'
         '\u2022 Discord Rich Presence now has a "Website" button \u2014 it opens the VOID Client site directly.\n'
         '\u2022 The button shows in every state: in the menu, while playing, and while installing.\n'
         '\u2022 The official site moved to GitHub Pages (the old address is no longer used).')
import json
for rel in ('site/launcher.json', 'site/launcher-site.json', 'docs/launcher.json', 'docs/launcher-site.json'):
    p = ROOT / rel
    d = json.loads(p.read_text(encoding='utf-8'))
    d['notes'] = NOTES
    p.write_text(json.dumps(d, indent=2) + '\n', encoding='utf-8')
    print(f'  {rel}: notes -> English')

print()
if failures:
    print('FAILURES:')
    for f in failures:
        print('  ' + f)
    sys.exit(1)
print('all translations applied')
