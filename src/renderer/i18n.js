'use strict';
/**
 * i18n — launcher translations, all in one file.
 *
 * English is the DEFAULT and the fallback: a key missing from another language
 * renders English rather than an empty string. Languages ship as complete maps
 * (verify_launcher.js asserts every language has exactly the EN key set), so a
 * typo shows up in tests, not in front of the player.
 *
 * Applies to anything with data-i18n (textContent), data-i18n-html (innerHTML,
 * for composite headings) or data-i18n-ph (placeholder). Dynamic strings go
 * through t(key).
 */
(() => {
  const en = {
    /* rail */
    'nav.play': 'Play',
    'nav.mods': 'Mods',
    'nav.profiles': 'Profiles',
    'nav.settings': 'Settings',
    'nav.console': 'Console',
    /* home */
    'home.title': 'Launch <span class="accent">Minecraft</span>',
    'home.not_signed_in': 'Not signed in',
    'home.click_sign_in': 'Click to sign in',
    'home.tag_mod': 'VOID Client — bundled',
    'home.play': 'PLAY',
    'home.stop': 'STOP GAME',
    'home.ready': 'Ready',
    'home.profiles': 'PROFILES',
    'home.profiles_sub': 'Each profile has its own mods, RAM and resolution',
    'home.new_profile': '+ New profile',
    'home.ram': 'RAM',
    'home.res': 'Resolution',
    'home.jvm_boost': 'JVM boost',
    'home.recommended': 'Recommended: —',
    'home.recommended_ram': "Recommended:",
    'home.recommended_res': "Recommended:",
    'home.preset': "preset…",
    'home.custom': "Custom",
    'home.use_recommended': 'Use recommended',
    'home.refresh': 'Refresh',
    'home.tab_mods': 'Mods',
    'home.tab_rp': 'Resource packs',
    'home.tab_sh': 'Shaders',
    'home.playtime': 'Playtime this week',
    'home.playtime_k': "this week",
    'mods.sub': "Install from Modrinth or CurseForge, or drop your own .jar files in.",
    'console.sub': "Live output from the launcher and the Minecraft process.",
    'del.confirm': "Delete anyway",
    /* mods */
    'mods.title': 'Mods',
    'mods.open_folder': 'Open folder',
    'mods.add_jar': '+ Add .jar',
    'mods.installed': 'Installed',
    'mods.browse': 'Browse',
    'mods.install': 'Install',
    'mods.select_all': 'Select all',
    'mods.clear': 'Clear',
    'mods.update': 'Update',
    'mods.search_ph': 'Search — sodium, lithium, iris, jei…',
    'mods.search': 'Search',
    'mods.type_mod': 'Mods',
    'mods.type_modpack': 'Modpacks',
    'mods.type_rp': 'Resource packs',
    'mods.type_shader': 'Shaders',
    /* profiles */
    'profiles.title': 'Profiles',
    'profiles.new': '+ New profile',
    'home.profiles_empty': "No profiles yet — press + to create your first one.",
    'profiles.empty_big': "No profiles yet.",
    'profiles.empty_hint': "Press + to create one — pick the performance mod set or start empty.",
    'profiles.sub': 'Each profile keeps its own mods, resource packs, shaders, RAM and resolution. Nothing leaks between them.',
    /* settings */
    'settings.title': 'Settings',
    'settings.reprobe': 'Re-detect hardware',
    'settings.mc_version': 'Minecraft version',
    'settings.fabric': 'Fabric loader',
    'settings.ram': 'RAM allocation (MB)',
    'settings.res': 'Resolution',
    'settings.inst_dir': 'Installation directory',
    'settings.game_dir': 'Game directory',
    'settings.java': 'Java executable',
    'settings.java_hint': 'empty = managed / PATH',
    'settings.browse': 'Browse',
    'settings.jvm_args': 'Extra JVM arguments',
    'settings.tg_updates': 'Check for launcher updates on start',
    'settings.tg_install': 'Install launcher updates automatically',
    'settings.tg_keepopen': 'Keep launcher open after Minecraft closes',
    'settings.check_updates': 'Check for updates',
    'settings.integrity': 'Integrity &amp; repair',
    'settings.integrity_sub': 'Re-downloads only the files that fail their published hash: the client jar, libraries and assets. Worlds, settings and mods are never touched.',
    'settings.scan': 'Scan for corrupted files',
    'settings.repair': 'Repair',
    'settings.lang': 'Language',
    'settings.save': 'Save settings',
    'settings.saved': 'Saved.',
    'settings.install_files': 'Install / repair game files',
    /* console */
    'console.title': 'Console',
    'console.clear': 'Clear',
    'console.search_ph': 'Search the log…',
    'console.all': 'All',
    'console.info': 'Normal',
    'console.warn': 'Warning',
    'console.error': 'Danger',
    /* update modal */
    'upd.title': 'Update available',
    'upd.now': 'Update now',
    'upd.later': 'Later',
    'upd.current': 'Current',
    'upd.available': 'Available',
    'upd.whats_new': "What's new in this version",
    /* account modal */
    'acc.title': 'Account',
    'acc.sign_in': 'Sign in',
    'acc.sign_out': 'Sign out',
    'acc.refresh': 'Refresh',
    'acc.sub': 'Sign in to play online and keep your skins.',
    'acc.list': 'Accounts',
    'acc.privacy': "VOID Client never sees your password. Enter the code below on Microsoft's website.",
    'acc.open_link': 'Open microsoft.com/link',
    'acc.copy_code': 'Copy code',
    'acc.waiting': 'Waiting for code…',
    'acc.add': '+ Add account',
    /* delete modal */
    'del.keep': 'Keep it',
    /* crash modal */
    'crash.title': 'Minecraft crashed',
    'crash.relaunch': 'Relaunch',
    'crash.open_report': 'Open crash report',
    'crash.copy': 'Copy details',
    'crash.next': 'What to do next',
    /* onboarding (first run) */
    'onb.welcome': 'Welcome to VOID Client',
    'onb.lang_h': 'Choose your language',
    'onb.lang_sub': 'You can change this any time in Settings.',
    'onb.cont': 'Continue',
    'onb.acc_h': 'Sign in to Minecraft',
    'onb.acc_sub': "Sign in with your Microsoft account to play online and keep your skins. You can also skip and do it later from the top-right corner.",
    'onb.signin': 'Sign in with Microsoft',
    'onb.skip': 'Skip for now',
    'onb.done': 'Start playing',
  };

  const id = {
    'nav.play': 'Main',
    'nav.mods': 'Mod',
    'nav.profiles': 'Profil',
    'nav.settings': 'Pengaturan',
    'nav.console': 'Konsol',
    'home.title': 'Jalankan <span class="accent">Minecraft</span>',
    'home.not_signed_in': 'Belum masuk akun',
    'home.click_sign_in': 'Klik untuk masuk',
    'home.tag_mod': 'VOID Client — bawaan',
    'home.play': 'MULAI',
    'home.stop': 'HENTIKAN',
    'home.ready': 'Siap',
    'home.profiles': 'PROFIL',
    'home.profiles_sub': 'Setiap profil punya mod, RAM, dan resolusinya sendiri',
    'home.new_profile': '+ Profil baru',
    'home.ram': 'RAM',
    'home.res': 'Resolusi',
    'home.jvm_boost': 'JVM boost',
    'home.recommended': 'Rekomendasi: —',
    'home.recommended_ram': "Rekomendasi:",
    'home.recommended_res': "Rekomendasi:",
    'home.preset': "bawaan…",
    'home.custom': "Kustom",
    'home.use_recommended': 'Pakai rekomendasi',
    'home.refresh': 'Segarkan',
    'home.tab_mods': 'Mod',
    'home.tab_rp': 'Pak sumber daya',
    'home.tab_sh': 'Shader',
    'home.playtime': 'Waktu main minggu ini',
    'home.playtime_k': "minggu ini",
    'mods.sub': "Pasang dari Modrinth atau CurseForge, atau taruh file .jar milikmu sendiri.",
    'console.sub': "Keluaran langsung dari launcher dan proses Minecraft.",
    'del.confirm': "Tetap hapus",
    'mods.title': 'Mod',
    'mods.open_folder': 'Buka folder',
    'mods.add_jar': '+ Tambah .jar',
    'mods.installed': 'Terpasang',
    'mods.browse': 'Jelajah',
    'mods.install': 'Pasang',
    'mods.select_all': 'Pilih semua',
    'mods.clear': 'Kosongkan',
    'mods.update': 'Perbarui',
    'mods.search_ph': 'Cari — sodium, lithium, iris, jei…',
    'mods.search': 'Cari',
    'mods.type_mod': 'Mod',
    'mods.type_modpack': 'Modpack',
    'mods.type_rp': 'Pak sumber daya',
    'mods.type_shader': 'Shader',
    'profiles.title': 'Profil',
    'profiles.new': '+ Profil baru',
    'home.profiles_empty': "Belum ada profil — tekan + untuk buat yang pertama.",
    'profiles.empty_big': "Belum ada profil.",
    'profiles.empty_hint': "Tekan + untuk membuat — pilih set mod performa atau mulai kosong.",
    'profiles.sub': 'Setiap profil menyimpan mod, pak sumber daya, shader, RAM, dan resolusinya sendiri. Tidak ada yang bocor antar-profil.',
    'settings.title': 'Pengaturan',
    'settings.reprobe': 'Deteksi ulang perangkat keras',
    'settings.mc_version': 'Versi Minecraft',
    'settings.fabric': 'Loader Fabric',
    'settings.ram': 'Alokasi RAM (MB)',
    'settings.res': 'Resolusi',
    'settings.inst_dir': 'Folder instalasi',
    'settings.game_dir': 'Folder game',
    'settings.java': 'Lokasi Java',
    'settings.java_hint': 'kosong = dikelola / PATH',
    'settings.browse': 'Telusuri',
    'settings.jvm_args': 'Argumen JVM tambahan',
    'settings.tg_updates': 'Cek pembaruan launcher saat mulai',
    'settings.tg_install': 'Pasang pembaruan launcher otomatis',
    'settings.tg_keepopen': 'Biarkan launcher terbuka setelah Minecraft ditutup',
    'settings.check_updates': 'Cek pembaruan',
    'settings.integrity': 'Integritas &amp; perbaikan',
    'settings.integrity_sub': 'Mengunduh ulang hanya file yang gagal cek hash: jar klien, library, dan aset. World, pengaturan, dan mod tidak pernah disentuh.',
    'settings.scan': 'Pindai file rusak',
    'settings.repair': 'Perbaiki',
    'settings.lang': 'Bahasa',
    'settings.save': 'Simpan pengaturan',
    'settings.saved': 'Tersimpan.',
    'settings.install_files': 'Pasang / perbaiki file game',
    'console.title': 'Konsol',
    'console.clear': 'Bersihkan',
    'console.search_ph': 'Cari di log…',
    'console.all': 'Semua',
    'console.info': 'Normal',
    'console.warn': 'Peringatan',
    'console.error': 'Bahaya',
    'upd.title': 'Pembaruan tersedia',
    'upd.now': 'Perbarui sekarang',
    'upd.later': 'Nanti',
    'upd.current': 'Saat ini',
    'upd.available': 'Tersedia',
    'upd.whats_new': 'Yang baru di versi ini',
    'acc.title': 'Akun',
    'acc.sign_in': 'Masuk',
    'acc.sign_out': 'Keluar',
    'acc.refresh': 'Segarkan',
    'acc.sub': 'Masuk agar bisa main online dan kulitmu tersimpan.',
    'acc.list': 'Akun',
    'acc.privacy': 'VOID Client tidak pernah melihat kata sandimu. Masukkan kode di bawah ke situs Microsoft.',
    'acc.open_link': 'Buka microsoft.com/link',
    'acc.copy_code': 'Salin kode',
    'acc.waiting': 'Menunggu kode…',
    'acc.add': '+ Tambah akun',
    'del.keep': 'Biarkan',
    'crash.title': 'Minecraft crash',
    'crash.relaunch': 'Jalankan ulang',
    'crash.open_report': 'Buka laporan crash',
    'crash.copy': 'Salin detail',
    'crash.next': 'Langkah selanjutnya',
    'onb.welcome': 'Selamat datang di VOID Client',
    'onb.lang_h': 'Pilih bahasamu',
    'onb.lang_sub': 'Bisa diubah kapan saja di Pengaturan.',
    'onb.cont': 'Lanjut',
    'onb.acc_h': 'Masuk ke Minecraft',
    'onb.acc_sub': 'Masuk dengan akun Microsoft untuk main online dan menyimpan kulitmu. Bisa juga dilewati dan dilakukan nanti dari pojok kanan atas.',
    'onb.signin': 'Masuk dengan Microsoft',
    'onb.skip': 'Lewati dulu',
    'onb.done': 'Mulai main',
  };



  /** Native names shown in the picker; `en` first = the default. */
  const LANGS = [
    { code: 'en', name: 'English' },
    { code: 'id', name: 'Bahasa Indonesia' },
  ];

  const DICTS = { en, id };

  let current = 'en';

  function t(key) {
    const dict = DICTS[current] || DICTS.en;
    const v = dict[key];
    if (v !== undefined) return v;
    return en[key] !== undefined ? en[key] : key;
  }

  /** Repaint every marked element. Call after any language change. */
  function applyI18n() {
    // A bare VM/test environment has no DOM — t() still works there.
    if (typeof document === 'undefined' || !document || !document.querySelectorAll) return;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
      el.setAttribute('placeholder', t(el.dataset.i18nPh));
    });
    document.documentElement.lang = current;
    // Dynamic zones (lists, hints drawn from JS) repaint on their own hook.
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('void:lang', { detail: { lang: current } }));
    }
  }

  function setLang(code) {
    if (!DICTS[code]) return false;
    current = code;
    applyI18n();
    return true;
  }

  window.I18N = { LANGS, DICTS, t, setLang, applyI18n, defaultLang: () => 'en' };
})();
