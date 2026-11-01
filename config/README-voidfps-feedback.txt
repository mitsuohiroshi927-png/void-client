VOID FPS feedback webhook
=========================

Mod membaca file ini dari CONFIG DIR MINECRAFT, bukan dari folder launcher:
  <gameDir>/config/voidfps-feedback.url

Untuk launcher VOID Client (default):
  %APPDATA%\.voidclient\config\voidfps-feedback.url

Untuk Minecraft vanilla / launcher lain:
  %APPDATA%\.minecraft\config\voidfps-feedback.url

Isi file: satu baris berisi webhook URL, tanpa tanda kutip.

Kalau file tidak ada, mod tetap jalan normal - fitur kirim feedback saja
yang nonaktif, dan log menampilkan:
  [VOID FPS] Feedback webhook belum dikonfigurasi (voidfps-feedback.url).


Cara launcher menyediakannya (JANGAN taruh URL di source code)
--------------------------------------------------------------
Launch engine menyalin webhook ke config Minecraft saat pertama kali launch,
dan HANYA kalau file-nya belum ada - file buatanmu selalu menang.

Sumber URL, urutan prioritas:

  1. Env var VOIDFPS_FEEDBACK_URL
     Dipakai saat build/CI supaya URL tidak pernah masuk ke file yang
     di-commit. Contoh build:

       VOIDFPS_FEEDBACK_URL='https://discord.com/api/webhooks/<id>/<token>' \
         npx electron-builder --win --x64

  2. File override di sisi operator (tanpa perlu rebuild):
       %APPDATA%\void-client\voidfps-feedback.url
     Ini jalur normal kalau exe sudah keburu dibuild.

  3. Tidak ada keduanya -> seeding dilewati, mod jalan tanpa feedback online.

KENAPA TIDAK DI-HARDCODE: launch.js ikut dibundel ke dalam asar installer.
Apa pun yang ditulis di sana bisa dibaca siapa saja yang download .exe-nya
lewat `asar extract`. Jadi URL webhook tidak boleh jadi konstanta di source.
File README ini pun sengaja tidak memuat URL asli.
