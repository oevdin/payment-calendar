/* =========================================================
   storage.js — слой данных «Платёжного календаря»
   Теперь данные хранятся в облаке (Firebase Firestore) и
   обновляются в реальном времени на всех устройствах.
   Настройка — см. README.txt.
   ========================================================= */
(function (global) {
  'use strict';

  const DEFAULT_CONTRAGENTS = [
    'РДА', 'РЭД', 'РДМ', 'ПРО', 'ТЕРЕМ', 'YIJIA', 'ANHUA', 'JINHUA',
    'ПРОМЕТ', 'NINGBO', 'ДАНЭЛИ', 'СЕЛЕНА', 'VETONIT', 'ДН', 'SOBSAN',
    'GMT', 'ОНУГУУ', 'НАЛОГИ', 'ГИНВ', 'АРЕНДА', 'ФОЛЬГА', 'МУРАБАХА',
    'ПРОЧЕЕ', 'ФУРА',
  ];

  const THEMES = {
    dark: {
      '--bg-primary': '#090c16', '--bg-secondary': '#111730',
      '--bg-elevated': '#161e3d', '--bg-elevated-2': '#1b2447',
      '--accent': '#ef277d', '--accent-2': '#3c3aa0',
      '--text-primary': '#f4f5fb', '--text-muted': '#8790ad',
      '--success': '#31d17b', '--danger': '#ff5069',
      '--border': 'rgba(255,255,255,0.09)',
    },
    light: {
      '--bg-primary': '#eef0f8', '--bg-secondary': '#ffffff',
      '--bg-elevated': '#f2f4fa', '--bg-elevated-2': '#e6e9f5',
      '--accent': '#ef277d', '--accent-2': '#3c3aa0',
      '--text-primary': '#161a33', '--text-muted': '#666f96',
      '--success': '#1a9c5b', '--danger': '#e0264d',
      '--border': 'rgba(22,26,51,0.10)',
    },
  };

  const LOCAL_THEME_KEY = 'pk_theme'; // тема — личная настройка устройства, не синхронизируется

  function isConfigured() {
    const c = global.FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.apiKey.indexOf('ВАШ_') !== 0 && c.projectId && c.projectId.indexOf('ВАШ_') !== 0);
  }

  let app, secondaryApp, auth, secondaryAuth, db;

  function init() {
    if (!isConfigured()) return false;
    app = firebase.initializeApp(global.FIREBASE_CONFIG);
    // отдельный "второй" экземпляр — нужен только чтобы создавать новых
    // пользователей, не выходя из своей же учётной записи администратора
    secondaryApp = firebase.initializeApp(global.FIREBASE_CONFIG, 'secondary');
    auth = app.auth();
    secondaryAuth = secondaryApp.auth();
    db = app.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    return true;
  }

  // ---------- auth ----------
  function normalizeEmail(input) {
    return String(input || '').trim().toLowerCase();
  }

  function login(email, password) {
    return auth.signInWithEmailAndPassword(normalizeEmail(email), password);
  }
  function logout() {
    return auth.signOut();
  }
  function sendPasswordReset(email) {
    return auth.sendPasswordResetEmail(normalizeEmail(email));
  }
  function onAuthChange(cb) {
    return auth.onAuthStateChanged(cb);
  }
  function currentUid() {
    return auth.currentUser ? auth.currentUser.uid : null;
  }

  async function getMyProfile(uid) {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return null;
    return Object.assign({ uid }, snap.data());
  }

  // ---------- realtime watchers ----------
  function watchContragents(cb, onError) {
    return db.collection('contragents').orderBy('order', 'asc').onSnapshot((qs) => {
      cb(qs.docs.map((d) => Object.assign({ id: d.id }, d.data())));
    }, onError);
  }
  function watchPayments(cb, onError) {
    return db.collection('payments').onSnapshot((qs) => {
      cb(qs.docs.map((d) => Object.assign({ id: d.id }, d.data())));
    }, onError);
  }
  function watchSettings(cb, onError) {
    return db.collection('settings').doc('app').onSnapshot((doc) => {
      cb(doc.exists ? doc.data() : { currency: 'сом' });
    }, onError);
  }
  function watchUsers(cb, onError) {
    return db.collection('users').onSnapshot((qs) => {
      cb(qs.docs.map((d) => Object.assign({ uid: d.id }, d.data())));
    }, onError);
  }

  // ---------- writes: contragents ----------
  async function addContragent(name) {
    const qs = await db.collection('contragents').orderBy('order', 'desc').limit(1).get();
    const nextOrder = qs.empty ? 1 : (qs.docs[0].data().order || 0) + 1;
    await db.collection('contragents').add({ name, order: nextOrder });
  }
  async function deleteContragent(id, name) {
    const batch = db.batch();
    batch.delete(db.collection('contragents').doc(id));
    const payQs = await db.collection('payments').where('contragent', '==', name).get();
    payQs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  async function renameContragent(id, oldName, newName) {
    const batch = db.batch();
    batch.update(db.collection('contragents').doc(id), { name: newName });
    const payQs = await db.collection('payments').where('contragent', '==', oldName).get();
    payQs.forEach((d) => batch.update(d.ref, { contragent: newName }));
    await batch.commit();
  }
  async function seedContragentsIfEmpty() {
    const qs = await db.collection('contragents').limit(1).get();
    if (!qs.empty) return;
    const batch = db.batch();
    DEFAULT_CONTRAGENTS.forEach((name, i) => {
      batch.set(db.collection('contragents').doc(), { name, order: i + 1 });
    });
    await batch.commit();
  }

  // ---------- writes: payments ----------
  async function addPayment(data) {
    await db.collection('payments').add(Object.assign({ createdAt: new Date().toISOString() }, data));
  }
  async function updatePayment(id, patch) {
    await db.collection('payments').doc(id).update(patch);
  }
  async function deletePayment(id) {
    await db.collection('payments').doc(id).delete();
  }
  async function rolloverBatch(updates) {
    // updates: [{id, dueDate, rolled, originalDueDate}]
    if (updates.length === 0) return;
    const batch = db.batch();
    updates.forEach((u) => {
      batch.update(db.collection('payments').doc(u.id), {
        dueDate: u.dueDate, rolled: true, originalDueDate: u.originalDueDate,
      });
    });
    await batch.commit();
  }

  // ---------- writes: settings ----------
  async function saveSettings(patch) {
    await db.collection('settings').doc('app').set(patch, { merge: true });
  }

  // ---------- writes: users ----------
  async function createUser(displayName, email, password, role) {
    const cred = await secondaryAuth.createUserWithEmailAndPassword(normalizeEmail(email), password);
    const uid = cred.user.uid;
    await db.collection('users').doc(uid).set({
      displayName, email: normalizeEmail(email), role,
    });
    await secondaryAuth.signOut();
    return uid;
  }
  async function setUserRole(uid, role) {
    await db.collection('users').doc(uid).update({ role });
  }
  async function revokeUser(uid) {
    await db.collection('users').doc(uid).delete();
  }

  // ---------- backup: export / import (миграция старых локальных копий) ----------
  async function exportAll(contragents, payments, settings) {
    return {
      app: 'payment-calendar',
      exportedAt: new Date().toISOString(),
      contragents: contragents.map((c) => c.name),
      payments: payments.map((p) => {
        const copy = Object.assign({}, p);
        delete copy.id;
        return copy;
      }),
      settings: settings || {},
    };
  }
  async function importAll(data, existingContragentNames) {
    if (!data || typeof data !== 'object') throw new Error('Файл повреждён или имеет неверный формат');
    const batch = db.batch();
    let opCount = 0;

    if (Array.isArray(data.contragents)) {
      const qs = await db.collection('contragents').orderBy('order', 'desc').limit(1).get();
      let nextOrder = qs.empty ? 1 : (qs.docs[0].data().order || 0) + 1;
      data.contragents.forEach((name) => {
        if (existingContragentNames.includes(name)) return;
        batch.set(db.collection('contragents').doc(), { name, order: nextOrder++ });
        opCount++;
      });
    }
    if (Array.isArray(data.payments)) {
      data.payments.forEach((p) => {
        const copy = Object.assign({}, p);
        delete copy.colors;
        batch.set(db.collection('payments').doc(), copy);
        opCount++;
      });
    }
    if (opCount > 0) await batch.commit();
    if (data.settings && data.settings.currency) {
      await saveSettings({ currency: data.settings.currency });
    }
  }

  // ---------- theme (личная настройка устройства, локально) ----------
  function getTheme() {
    try { return localStorage.getItem(LOCAL_THEME_KEY) || 'dark'; }
    catch (e) { return 'dark'; }
  }
  function setTheme(t) {
    try { localStorage.setItem(LOCAL_THEME_KEY, t); } catch (e) {}
  }

  global.Store = {
    DEFAULT_CONTRAGENTS, THEMES,
    isConfigured, init,
    login, logout, sendPasswordReset, onAuthChange, currentUid, getMyProfile,
    watchContragents, watchPayments, watchSettings, watchUsers,
    addContragent, deleteContragent, renameContragent, seedContragentsIfEmpty,
    addPayment, updatePayment, deletePayment, rolloverBatch,
    saveSettings,
    createUser, setUserRole, revokeUser,
    exportAll, importAll,
    getTheme, setTheme,
  };
})(window);
