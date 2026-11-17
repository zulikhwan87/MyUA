/*************************************************************
 * MyUA — Backend Google Apps Script
 * (RAMAI GURU + LOG MASUK + PENYELARAS + IBU BAPA + MURAJAAH RUMAH)
 *
 * Satu Google Sheet dikongsi semua guru. Data setiap guru
 * disimpan dalam BARIS sendiri (dikunci ikut guruId + kata laluan).
 * Penyelaras (dengan Kod Penyelaras) boleh lihat data semua guru.
 * Ibu bapa (action 'parentLogin') hanya menerima data anak sendiri,
 * dan boleh menghantar murajaah di rumah (action 'parentSubmit').
 *
 * Tab automatik: _data (tersembunyi), Guru, Pelajar, Rekod, Murajaah Rumah.
 *
 * SELEPAS TAMPAL: Deploy -> Manage deployments -> Edit (pensel)
 *   -> Version: "New version" -> Deploy.  (Save sahaja TIDAK cukup.)
 *   Pautan /exec kekal sama.
 *************************************************************/

var ADMIN_KEY = 'TUKAR-KOD-INI';   // <-- WAJIB TUKAR sebelum deploy. Nilai sama = "Kod Penyelaras" dalam app.

var DATA_SHEET = '_data';
var COL_ID = 1, COL_NAME = 2, COL_KELAS = 3, COL_UPDATED = 4, COL_PIN = 5, COL_JSON = 6;
var HEADER = ['guruId', 'guruName', 'namaKelas', 'updatedAt', 'pinHash', 'jsonData'];
var CHUNK = 45000;

var RUMAH_SHEET = 'Murajaah Rumah';
var RUMAH_HEADER = ['Tarikh', 'Dihantar', 'Guru', 'Pelajar', 'Kod Ibu Bapa', 'Muka Surat Dibaca',
  'Dibaca', 'Dijadual', 'Penilaian', 'Catatan', 'guruId', 'studentId', 'itemsJson'];
var R_DATE = 1, R_TS = 2, R_GURU = 3, R_NAME = 4, R_USER = 5, R_PAGES = 6, R_DONE = 7, R_TOTAL = 8,
    R_RATE = 9, R_NOTE = 10, R_GID = 11, R_SID = 12, R_ITEMS = 13;
var RUMAH_DAYS = 60;   // berapa hari sejarah dihantar ke app

var PHASE_ORDER = ['talaqqi', 'hafazan', 'tasmik', 'murajaah', 'tahriri'];
var PHASE_LABEL = {
  talaqqi: 'Talaqqi', hafazan: 'Hafazan', tasmik: 'Tasmik',
  murajaah: "Muraja'ah", tahriri: 'Tahriri'
};

/* ---------------- Titik masuk ---------------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || 'load';
  // KESELAMATAN: 'load' & 'loadAll' kini melalui POST sahaja (perlu kata laluan / kod dalam body).
  if (action === 'load' || action === 'loadAll') return out({ ok: false, error: 'use-post' });
  if (action === 'version') return out({ ok: true, parentLogin: true, rumah: true, rumahAll: true, secureLoad: true });   // semakan pantas versi deploy
  return out({ ok: false, error: 'unknown action' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    /* ----- IBU BAPA ----- */
    if (body.action === 'parentLogin') return out(parentLogin_(body));
    if (body.action === 'parentSubmit') return out(parentSubmit_(body));

    /* ----- GURU: baca murajaah rumah kelas sendiri ----- */
    if (body.action === 'rumahLoad') return out(rumahLoad_(body));

    /* ----- PENYELARAS: baca murajaah rumah semua guru (kod dalam body, bukan URL) ----- */
    if (body.action === 'rumahLoadAll') {
      if (String(body.key || '') !== ADMIN_KEY) return out({ ok: false, error: 'unauthorized' });
      var sinceAll = daysAgoKey_(RUMAH_DAYS);
      return out({ ok: true, entries: rumahRead_(function (e) { return e.d >= sinceAll; }, true) });
    }

    /* ----- GURU: muat data sendiri (perlu kata laluan) ----- */
    if (body.action === 'load') {
      var gl = slug(body.guruId || '');
      if (!gl) return out({ ok: false, error: 'no-id' });
      var rl = findRow(gl);
      if (!rl) return out({ ok: true, data: null });
      var spl = getPin(rl);
      if (!spl || spl !== sha(body.pin || '')) return out({ ok: false, error: 'wrong-pin' });
      return out({ ok: true, data: readRowJson(rl) });
    }

    /* ----- PENYELARAS: muat data semua guru (kod dalam body, bukan URL) ----- */
    if (body.action === 'loadAll') {
      if (String(body.key || '') !== ADMIN_KEY) return out({ ok: false, error: 'unauthorized' });
      return out({ ok: true, rows: stripParentHash_(readAllRows()) });
    }

    /* ----- LOG MASUK / DAFTAR (GURU) ----- */
    if (body.action === 'login') {
      var gid = slug(body.guruId || body.guruName || '');
      if (!gid) return out({ ok: false, error: 'no-id' });
      if (!String(body.pin || '')) return out({ ok: false, error: 'no-pin' });
      var h = sha(body.pin || '');
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(25000)) return out({ ok: false, error: 'busy' });
      try {
        var row = findRow(gid);
        if (!row) {                       // pengguna baharu -> daftar
          registerRow(gid, body.guruName || gid, h);
          return out({ ok: true, data: null, registered: true });
        }
        var stored = getPin(row);
        if (stored === '') {              // baris lama tanpa kata laluan -> tetapkan
          setPin(row, h);
          if (body.guruName) setName(row, body.guruName);
          return out({ ok: true, data: readRowJson(row), adopted: true });
        }
        if (stored !== h) return out({ ok: false, error: 'wrong-pin' });
        if (body.guruName) setName(row, body.guruName);
        return out({ ok: true, data: readRowJson(row) });
      } finally { lock.releaseLock(); }
    }

    /* ----- SIMPAN ----- */
    if (body.action === 'save') {
      var g2 = slug(body.guruId || body.guruName || '');
      if (!g2) return out({ ok: false, error: 'no-id' });
      if (!String(body.pin || '')) return out({ ok: false, error: 'no-pin' });
      var lock2 = LockService.getScriptLock();
      if (!lock2.tryLock(25000)) return out({ ok: false, error: 'busy' });
      try {
        var row2 = findRow(g2);
        var h2 = sha(body.pin || '');
        var keepPin;
        if (row2) {
          var sp = getPin(row2);
          if (sp !== '' && sp !== h2) return out({ ok: false, error: 'wrong-pin' });
          keepPin = (sp !== '') ? sp : h2;
        } else {
          keepPin = h2;
        }
        upsert(g2, body.guruName || g2, body.namaKelas || '', body.data || {}, keepPin);
        rebuildCombined();
        return out({ ok: true, saved: true, at: new Date().toISOString() });
      } finally { lock2.releaseLock(); }
    }

    return out({ ok: false, error: 'unknown action' });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

/* ---------------- IBU BAPA ---------------- */
// Semak kod + kata laluan ibu bapa. Pulangkan senarai anak yang sepadan, atau ralat.
function parentMatch_(body) {
  var user = String(body.user || '').trim().toLowerCase();
  var pin  = String(body.pin || '');
  if (!user || !pin) return { error: 'no-match' };

  // Had percubaan: 10 kali gagal -> kunci 15 minit
  var cache = CacheService.getScriptCache(), ck = 'pf_' + user.replace(/[^a-z0-9]/g, '').slice(0, 40);
  var tries = Number(cache.get(ck) || 0);
  if (tries >= 10) return { error: 'locked' };

  var ph = sha(user + ':' + pin);          // sama dengan SHA-256 di app
  var found = [];
  readAllRows().forEach(function (r) {
    var d = r.data || {};
    (d.students || []).forEach(function (s) {
      if (s.parent && s.parent.user === user && s.parent.ph === ph) found.push({ r: r, d: d, s: s });
    });
  });
  if (!found.length) { cache.put(ck, String(tries + 1), 900); return { error: 'no-match' }; }
  cache.remove(ck);
  return { user: user, found: found };
}

function parentLogin_(body) {
  var m = parentMatch_(body);
  if (m.error) return { ok: false, error: m.error };
  var since = daysAgoKey_(RUMAH_DAYS);
  var children = m.found.map(function (x) {
    var d = x.d, s = x.s, cm = {};
    if (d.comments && d.comments[s.id]) cm[s.id] = d.comments[s.id];   // ulasan anak ini sahaja
    return {
      guruName: x.r.guruName,
      klass: d.klass || {},
      points: d.points || {},
      target: d.target,
      mur: d.mur || {},
      annual: d.annual || {},
      comments: cm,
      // pelajar lain & maklumat akaun ibu bapa sengaja TIDAK dihantar
      student: { id: s.id, no: s.no, name: s.name, tingkatan: s.tingkatan,
                 records: s.records || [], attendance: s.attendance || [],
                 khatam: s.khatam || null, lamaJuz: s.lamaJuz || null },
      rumah: rumahRead_(function (e) { return e.guruId === x.r.guruId && e.sid === s.id && e.d >= since; })
    };
  });
  return { ok: true, children: children };
}

// Ibu bapa hantar / kemas kini murajaah di rumah untuk satu hari
function parentSubmit_(body) {
  var m = parentMatch_(body);
  if (m.error) return { ok: false, error: m.error };
  var sid = String(body.sid || '');
  var hit = null;
  m.found.forEach(function (x) { if (x.s.id === sid) hit = x; });
  if (!hit) return { ok: false, error: 'no-child' };

  var d = String(body.d || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'bad-date' };
  if (d < daysAgoKey_(2) || d > daysAgoKey_(-1)) return { ok: false, error: 'bad-date' };   // hanya semalam/hari ini

  var items = [];
  (Array.isArray(body.items) ? body.items : []).slice(0, 40).forEach(function (it) {
    var a = Math.round(Number(it && it[0])), b = Math.round(Number(it && it[1]));
    if (!(a >= 1 && b >= a && b <= 604)) return;
    items.push([a, b, it[2] ? 1 : 0]);
  });
  if (!items.length) return { ok: false, error: 'no-items' };
  var rating = ['lancar', 'sederhana', 'lemah'].indexOf(body.rating) >= 0 ? body.rating : '';
  var note = String(body.note || '').slice(0, 300);

  var done = 0, total = 0, read = [];
  items.forEach(function (it) {
    var n = it[1] - it[0] + 1; total += n;
    if (it[2]) { done += n; read.push(it[0] === it[1] ? String(it[0]) : (it[0] + '-' + it[1])); }
  });
  var ts = new Date().getTime();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'busy' };
  try {
    var sh = rumahSheet_();
    var row = 0, last = sh.getLastRow();
    if (last >= 2) {
      var keys = sh.getRange(2, 1, last - 1, R_ITEMS).getValues();
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i][R_DATE - 1]) === d && String(keys[i][R_SID - 1]) === sid && String(keys[i][R_GID - 1]) === hit.r.guruId) { row = i + 2; break; }
      }
    }
    if (!row) row = Math.max(2, last + 1);
    sh.getRange(row, 1, 1, R_ITEMS).setValues([[
      "'" + d, new Date(ts), hit.r.guruName || hit.r.guruId, hit.s.name || '', m.user,
      read.join(', '), done, total, rating, note, hit.r.guruId, sid, JSON.stringify(items)
    ]]);
    sh.getRange(row, R_TS).setNumberFormat('dd/mm/yyyy hh:mm');
  } finally { lock.releaseLock(); }

  return { ok: true, entry: { d: d, ts: ts, sid: sid, items: items, done: done, total: total, rating: rating, note: note } };
}

/* ---------------- GURU: murajaah rumah ---------------- */
function rumahLoad_(body) {
  var gid = slug(body.guruId || '');
  if (!gid) return { ok: false, error: 'no-id' };
  var row = findRow(gid);
  if (!row) return { ok: false, error: 'no-id' };
  var stored = getPin(row);
  if (!stored || stored !== sha(body.pin || '')) return { ok: false, error: 'wrong-pin' };
  var since = daysAgoKey_(RUMAH_DAYS);
  return { ok: true, entries: rumahRead_(function (e) { return e.guruId === gid && e.d >= since; }) };
}

function rumahSheet_() {
  var sh = ss().getSheetByName(RUMAH_SHEET);
  if (!sh) {
    sh = ss().insertSheet(RUMAH_SHEET);
    sh.getRange(1, 1, 1, RUMAH_HEADER.length).setValues([RUMAH_HEADER]);
    styleHeader(sh, RUMAH_HEADER.length);
    try { sh.hideColumns(R_GID, 3); } catch (e) {}
  }
  return sh;
}
function rumahRead_(filterFn, keepGuruId) {
  var sh = ss().getSheetByName(RUMAH_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  var tz = ss().getSpreadsheetTimeZone();
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, R_ITEMS).getValues(), res = [];
  vals.forEach(function (v) {
    var dv = v[R_DATE - 1];
    var d = (dv instanceof Date) ? Utilities.formatDate(dv, tz, 'yyyy-MM-dd') : String(dv || '');
    var tsv = v[R_TS - 1];
    var e = {
      d: d,
      ts: (tsv instanceof Date) ? tsv.getTime() : Number(tsv || 0),
      guruId: String(v[R_GID - 1] || ''),
      sid: String(v[R_SID - 1] || ''),
      done: Number(v[R_DONE - 1] || 0),
      total: Number(v[R_TOTAL - 1] || 0),
      rating: String(v[R_RATE - 1] || ''),
      note: String(v[R_NOTE - 1] || ''),
      items: []
    };
    try { e.items = JSON.parse(v[R_ITEMS - 1] || '[]'); } catch (err) {}
    if (e.sid && filterFn(e)) { if (!keepGuruId) delete e.guruId; res.push(e); }
  });
  return res;
}
function daysAgoKey_(n) {
  var t = new Date(new Date().getTime() - n * 86400000);
  return Utilities.formatDate(t, ss().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

/* ---------------- Utiliti ---------------- */
function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }
function slug(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '');
}
function sha(s) {
  s = String(s || '');
  if (!s) return '';
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < raw.length; i++) {
    var b = (raw[i] < 0 ? raw[i] + 256 : raw[i]).toString(16);
    hex += (b.length === 1 ? '0' : '') + b;
  }
  return hex;
}
function getOrCreate(name) {
  var s = ss().getSheetByName(name);
  if (!s) s = ss().insertSheet(name);
  return s;
}

/* ---------------- Simpanan mentah (_data) ---------------- */
function dataSheet() {
  var sh = ss().getSheetByName(DATA_SHEET);
  if (!sh) {
    sh = ss().insertSheet(DATA_SHEET);
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    try { sh.hideSheet(); } catch (e) {}
  } else if (sh.getRange(1, COL_PIN).getValue() !== 'pinHash') {
    // KESELAMATAN DATA: JANGAN sekali-kali padam. Jika helaian kosong, tulis tajuk;
    // jika ada data tetapi tajuk terusik (cth disusun/sort), hentikan supaya tiada data ditimpa.
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
    else throw new Error('Tajuk helaian _data telah berubah (sel E1 bukan "pinHash"). Pulihkan melalui File > Version history. Tiada data dipadam.');
  }
  try {   // amaran jika sesiapa cuba menyunting helaian ini secara manual
    if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length)
      sh.protect().setDescription('MyUA: jangan sunting/susun secara manual').setWarningOnly(true);
  } catch (e) {}
  return sh;
}
// Hash kata laluan ibu bapa tidak perlu dihantar kepada penyelaras.
function stripParentHash_(rows) {
  rows.forEach(function (r) {
    ((r.data && r.data.students) || []).forEach(function (s) {
      if (s.parent) s.parent = { user: s.parent.user, hasPin: !!s.parent.ph };
    });
  });
  return rows;
}
function findRow(gid) {
  var sh = dataSheet();
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var ids = sh.getRange(2, COL_ID, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === gid) return i + 2;
  return 0;
}
function getPin(row) { return String(dataSheet().getRange(row, COL_PIN).getValue() || ''); }
function setPin(row, h) { dataSheet().getRange(row, COL_PIN).setValue(h); }
function setName(row, name) { dataSheet().getRange(row, COL_NAME).setValue(name); }

function registerRow(gid, name, pinHash) {
  var sh = dataSheet();
  var row = sh.getLastRow() + 1; if (row < 2) row = 2;
  sh.getRange(row, COL_ID, 1, 5).setValues([[gid, name, '', new Date().getTime(), pinHash]]);
  sh.getRange(row, COL_JSON).setValue('');
  return row;
}
function readRowJson(rowIndex) {
  var sh = dataSheet();
  var lastCol = sh.getLastColumn();
  var n = lastCol - COL_JSON + 1;
  if (n < 1) return null;
  var vals = sh.getRange(rowIndex, COL_JSON, 1, n).getValues()[0];
  var str = vals.join('');
  if (!str) return null;
  try { return JSON.parse(str); } catch (e) { return null; }
}
function writeRowJson(rowIndex, jsonStr) {
  var sh = dataSheet();
  var chunks = [];
  for (var i = 0; i < jsonStr.length; i += CHUNK) chunks.push(jsonStr.substring(i, i + CHUNK));
  if (!chunks.length) chunks = [''];
  var lastCol = sh.getLastColumn();
  var oldN = Math.max(1, lastCol - COL_JSON + 1);
  sh.getRange(rowIndex, COL_JSON, 1, oldN).clearContent();
  sh.getRange(rowIndex, COL_JSON, 1, chunks.length).setValues([chunks]);
}
function upsert(gid, name, kelas, dataObj, pinHash) {
  var sh = dataSheet();
  var row = findRow(gid);
  if (!row) { row = sh.getLastRow() + 1; if (row < 2) row = 2; }
  var updated = (dataObj && dataObj.meta && dataObj.meta.updated) || new Date().getTime();
  sh.getRange(row, COL_ID, 1, 5).setValues([[gid, name, kelas, updated, pinHash || getPin(row)]]);
  writeRowJson(row, JSON.stringify(dataObj));
}
function readAllRows() {
  var sh = dataSheet();
  var last = sh.getLastRow();
  var res = [];
  for (var r = 2; r <= last; r++) {
    var gid = String(sh.getRange(r, COL_ID).getValue() || '');
    if (!gid) continue;
    res.push({
      guruId: gid,
      guruName: String(sh.getRange(r, COL_NAME).getValue() || ''),
      namaKelas: String(sh.getRange(r, COL_KELAS).getValue() || ''),
      updatedAt: Number(sh.getRange(r, COL_UPDATED).getValue() || 0),
      data: readRowJson(r)
    });
  }
  return res;
}

/* ---------------- Tab mesra-manusia (semua guru) ---------------- */
function ptsOf(map, phase) { var p = map && map[phase]; return (typeof p === 'number') ? p : 0; }
function blankRow(n) { var a = []; for (var i = 0; i < n; i++) a.push(''); return a; }

function rebuildCombined() {
  var rows = readAllRows();
  var tz = ss().getSpreadsheetTimeZone();

  /* GURU */
  var gs = getOrCreate('Guru'); gs.clear();
  var gh = ['Nama Guru', 'Kelas', 'Jumlah Pelajar', 'Jumlah Rekod', 'Jumlah Mata', 'Muka Surat', 'Kemaskini'];
  var grows = [gh];
  rows.forEach(function (e) {
    var d = e.data || {}, studs = d.students || [], map = d.points || {}, mata = 0, pages = 0, recs = 0;
    studs.forEach(function (s) {
      (s.records || []).forEach(function (r) {
        mata += ptsOf(map, r.phase); pages += Math.max(1, (r.end - r.start + 1)); recs++;
      });
    });
    grows.push([e.guruName || e.guruId, e.namaKelas || '', studs.length, recs, mata, pages,
      e.updatedAt ? new Date(e.updatedAt) : '']);
  });
  gs.getRange(1, 1, grows.length, gh.length).setValues(grows);
  gs.getRange(2, 7, Math.max(1, grows.length - 1), 1).setNumberFormat('dd/mm/yyyy hh:mm');
  styleHeader(gs, gh.length);

  /* PELAJAR (semua) */
  var ps = getOrCreate('Pelajar'); ps.clear();
  var ph = ['Guru', 'Kelas', 'No', 'Nama', 'Jumlah Rekod', 'Jumlah Mata', 'Muka Surat']
    .concat(PHASE_ORDER.map(function (k) { return PHASE_LABEL[k]; }));
  var prows = [ph];
  rows.forEach(function (e) {
    var d = e.data || {}, map = d.points || {};
    (d.students || []).slice().sort(function (a, b) { return (a.no || 0) - (b.no || 0); })
      .forEach(function (s) {
        var mata = 0, pages = 0, by = {}; PHASE_ORDER.forEach(function (k) { by[k] = 0; });
        (s.records || []).forEach(function (r) {
          mata += ptsOf(map, r.phase); pages += Math.max(1, (r.end - r.start + 1));
          if (by[r.phase] != null) by[r.phase]++;
        });
        prows.push([e.guruName || e.guruId, e.namaKelas || '', s.no || '', s.name || '',
          (s.records || []).length, mata, pages].concat(PHASE_ORDER.map(function (k) { return by[k]; })));
      });
  });
  if (prows.length === 1) prows.push(blankRow(ph.length));
  ps.getRange(1, 1, prows.length, ph.length).setValues(prows);
  styleHeader(ps, ph.length);

  /* REKOD (semua) */
  var rs = getOrCreate('Rekod'); rs.clear();
  var rh = ['Guru', 'Kelas', 'No Pelajar', 'Nama', 'Fasa', 'Mula (m/s)', 'Tamat (m/s)',
    'Bil. M/S', 'Mata', 'Tarikh', 'Masa', 'Nota'];
  var rrows = [rh];
  rows.forEach(function (e) {
    var d = e.data || {}, map = d.points || {};
    (d.students || []).slice().sort(function (a, b) { return (a.no || 0) - (b.no || 0); })
      .forEach(function (s) {
        (s.records || []).slice().sort(function (a, b) { return a.ts - b.ts; })
          .forEach(function (r) {
            var dt = new Date(r.ts);
            rrows.push([e.guruName || e.guruId, e.namaKelas || '', s.no || '', s.name || '',
              PHASE_LABEL[r.phase] || r.phase, r.start, r.end, Math.max(1, (r.end - r.start + 1)),
              ptsOf(map, r.phase), dt, Utilities.formatDate(dt, tz, 'HH:mm'), r.note || '']);
          });
      });
  });
  if (rrows.length === 1) rrows.push(blankRow(rh.length));
  rs.getRange(1, 1, rrows.length, rh.length).setValues(rrows);
  rs.getRange(2, 10, Math.max(1, rrows.length - 1), 1).setNumberFormat('dd/mm/yyyy');
  styleHeader(rs, rh.length);

  try { ss().setActiveSheet(gs); } catch (e) {}
}
function styleHeader(sheet, ncol) {
  sheet.getRange(1, 1, 1, ncol)
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#6d1b30');
  sheet.setFrozenRows(1);
  try { sheet.autoResizeColumns(1, ncol); } catch (e) {}
}
