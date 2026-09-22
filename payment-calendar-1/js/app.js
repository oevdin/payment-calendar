/* =========================================================
   app.js — логика «Платёжного календаря» (облачная версия)
   ========================================================= */
(function () {
  'use strict';

  const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  const WEEKDAYS = ['вс','пн','вт','ср','чт','пт','сб'];

  let state = {
    user: null,          // { uid, email, displayName, role }
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    viewMode: 'month',    // 'month' | 'week'
    weekStart: getMonday(new Date()),
    showOnlyUnpaid: false,
    contragents: [],     // [{id, name, order}]
    payments: [],        // [{id, contragent, amount, note, dueDate, paid, paidDate, rolled, originalDueDate}]
    users: [],           // [{uid, displayName, email, role}] — только для админа
    settingsDoc: { currency: 'сом' },
    theme: 'dark',
    unsub: { contragents: null, payments: null, settings: null, users: null },
    seeded: false,
  };

  function getMonday(d) {
    const date = new Date(d);
    const day = date.getDay(); // 0=вс..6=сб
    const diff = day === 0 ? -6 : 1 - day; // сдвиг до понедельника
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  // ---------- helpers ----------
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fmtMoney(n) {
    const num = Number(n) || 0;
    return num.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast'; }, 3200);
  }
  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }
  function isAdmin() { return state.user && state.user.role === 'admin'; }

  function authErrorMessage(err) {
    const map = {
      'auth/invalid-email': 'Некорректный email',
      'auth/user-disabled': 'Учётная запись отключена',
      'auth/user-not-found': 'Пользователь с таким email не найден',
      'auth/wrong-password': 'Неверный пароль',
      'auth/invalid-login-credentials': 'Неверный email или пароль',
      'auth/invalid-credential': 'Неверный email или пароль',
      'auth/too-many-requests': 'Слишком много попыток. Попробуйте позже',
      'auth/email-already-in-use': 'Такой email уже зарегистрирован',
      'auth/weak-password': 'Пароль слишком простой (минимум 6 символов)',
      'auth/network-request-failed': 'Нет соединения с сервером',
    };
    return map[err && err.code] || (err && err.message) || 'Произошла ошибка';
  }

  // ---------- boot ----------
  function boot() {
    if (!Store.isConfigured()) {
      showSetupScreen();
      return;
    }
    Store.init();
    state.theme = Store.getTheme();
    applyColors();

    document.getElementById('login-form').addEventListener('submit', onLogin);
    document.getElementById('btn-logout').addEventListener('click', onLogout);
    document.getElementById('btn-forgot').addEventListener('click', onForgotPassword);

    Store.onAuthChange(onAuthStateChanged);
  }

  function showSetupScreen() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('setup-screen').classList.remove('hidden');
  }

  async function onAuthStateChanged(fbUser) {
    if (!fbUser) {
      teardownWatchers();
      state.user = null;
      showLogin();
      return;
    }
    let profile;
    try {
      profile = await Store.getMyProfile(fbUser.uid);
    } catch (e) {
      toast('Ошибка доступа к базе данных: ' + authErrorMessage(e), 'err');
      return;
    }
    if (!profile) {
      toast('У вашей учётной записи нет доступа к этому приложению. Обратитесь к администратору.', 'err');
      Store.logout();
      return;
    }
    state.user = { uid: fbUser.uid, email: profile.email || fbUser.email, displayName: profile.displayName || fbUser.email, role: profile.role };
    showApp();
  }

  function showLogin() {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('login-error').textContent = '';
  }

  async function onLogin(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    const btn = e.target.querySelector('button[type=submit]');
    errEl.textContent = '';
    btn.disabled = true; btn.textContent = 'Входим…';
    try {
      await Store.login(email, password);
      document.getElementById('login-form').reset();
    } catch (err) {
      errEl.textContent = authErrorMessage(err);
    } finally {
      btn.disabled = false; btn.textContent = 'Войти';
    }
  }

  function onLogout() {
    Store.logout();
  }

  function onForgotPassword() {
    const email = document.getElementById('login-email').value.trim();
    if (!email) { toast('Сначала введите email в поле выше', 'err'); return; }
    Store.sendPasswordReset(email)
      .then(() => toast('Письмо для сброса пароля отправлено на ' + email, 'ok'))
      .catch((err) => toast(authErrorMessage(err), 'err'));
  }

  // ---------- app shell ----------
  function showApp() {
    document.getElementById('setup-screen').classList.add('hidden');
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    document.getElementById('user-name').textContent = state.user.displayName;
    const roleEl = document.getElementById('user-role');
    roleEl.textContent = isAdmin() ? 'Админ' : 'Просмотр';
    roleEl.className = 'role-badge' + (isAdmin() ? ' admin' : '');
    document.getElementById('sidebar-admin').style.display = isAdmin() ? 'block' : 'none';

    buildPeriodSelectors();
    bindGlobalEvents();
    startWatchers();
  }

  function teardownWatchers() {
    Object.keys(state.unsub).forEach((k) => { if (state.unsub[k]) { state.unsub[k](); state.unsub[k] = null; } });
    state.seeded = false;
  }

  function startWatchers() {
    teardownWatchers();

    state.unsub.contragents = Store.watchContragents(async (list) => {
      state.contragents = list;
      if (isAdmin() && !state.seeded && list.length === 0) {
        state.seeded = true;
        try { await Store.seedContragentsIfEmpty(); } catch (e) { toast('Не удалось создать список контрагентов: ' + authErrorMessage(e), 'err'); }
      }
      renderAll();
    }, (err) => toast('Ошибка загрузки контрагентов: ' + authErrorMessage(err), 'err'));

    state.unsub.payments = Store.watchPayments(async (list) => {
      state.payments = list;
      if (isAdmin()) await rolloverOverduePayments();
      renderAll();
    }, (err) => toast('Ошибка загрузки платежей: ' + authErrorMessage(err), 'err'));

    state.unsub.settings = Store.watchSettings((s) => {
      state.settingsDoc = s || { currency: 'сом' };
      renderAll();
    }, (err) => toast('Ошибка загрузки настроек: ' + authErrorMessage(err), 'err'));

    if (isAdmin()) {
      state.unsub.users = Store.watchUsers((list) => {
        state.users = list;
        if (document.getElementById('modal-users').classList.contains('open')) renderUsersList();
      }, (err) => toast('Ошибка загрузки пользователей: ' + authErrorMessage(err), 'err'));
    }
  }

  // ---------- rollover ----------
  async function rolloverOverduePayments() {
    const today = todayStr();
    const updates = [];
    state.payments.forEach((p) => {
      if (!p.paid && p.dueDate < today) {
        updates.push({
          id: p.id,
          dueDate: today,
          originalDueDate: p.originalDueDate || p.dueDate,
        });
      }
    });
    if (updates.length === 0) return;
    try { await Store.rolloverBatch(updates); } catch (e) { /* тихо: попробуем при следующем обновлении */ }
  }

  // ---------- period selectors ----------
  function buildPeriodSelectors() {
    const mSel = document.getElementById('select-month');
    mSel.innerHTML = MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('');
    mSel.value = state.month;

    const ySel = document.getElementById('select-year');
    const curY = new Date().getFullYear();
    const years = [];
    for (let y = curY - 3; y <= curY + 3; y++) years.push(y);
    if (!years.includes(state.year)) years.push(state.year);
    years.sort((a, b) => a - b);
    ySel.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
    ySel.value = state.year;

    mSel.onchange = () => { state.month = Number(mSel.value); renderAll(); };
    ySel.onchange = () => { state.year = Number(ySel.value); renderAll(); };
    document.getElementById('btn-prev-month').onclick = () => shiftMonth(-1);
    document.getElementById('btn-next-month').onclick = () => shiftMonth(1);

    document.getElementById('btn-prev-week').onclick = () => shiftWeek(-1);
    document.getElementById('btn-next-week').onclick = () => shiftWeek(1);

    document.querySelectorAll('#mode-toggle .seg-btn').forEach((btn) => {
      btn.onclick = () => setViewMode(btn.getAttribute('data-mode'));
    });

    updateWeekLabel();
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    document.querySelectorAll('#mode-toggle .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    document.getElementById('month-controls').classList.toggle('hidden', mode !== 'month');
    document.getElementById('week-controls').classList.toggle('hidden', mode !== 'week');
    renderAll();
  }

  function shiftMonth(delta) {
    let m = state.month + delta, y = state.year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    state.month = m; state.year = y;
    buildPeriodSelectors();
    renderAll();
  }

  function shiftWeek(delta) {
    const d = new Date(state.weekStart);
    d.setDate(d.getDate() + delta * 7);
    state.weekStart = d;
    updateWeekLabel();
    renderAll();
  }

  function updateWeekLabel() {
    const start = state.weekStart;
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const label = sameMonth
      ? `${start.getDate()}–${end.getDate()} ${MONTHS[start.getMonth()].toLowerCase()}`
      : `${start.getDate()} ${MONTHS[start.getMonth()].toLowerCase().slice(0, 3)} – ${end.getDate()} ${MONTHS[end.getMonth()].toLowerCase().slice(0, 3)}`;
    document.getElementById('week-label').textContent = `${label} ${end.getFullYear()}`;
  }

  // ---------- period dates (месяц или неделя) ----------
  function getPeriodDates() {
    if (state.viewMode === 'week') {
      const dates = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(state.weekStart);
        d.setDate(d.getDate() + i);
        dates.push(d);
      }
      return dates;
    }
    const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
    const dates = [];
    for (let day = 1; day <= daysInMonth; day++) dates.push(new Date(state.year, state.month, day));
    return dates;
  }

  // ---------- render ----------
  function renderAll() {
    if (!state.user) return;
    renderOverdueBanner();
    renderSummary();
    renderTable();
  }

  function renderOverdueBanner() {
    const today = todayStr();
    const overdue = state.payments.filter((p) => !p.paid && p.rolled && p.dueDate === today);
    const banner = document.getElementById('overdue-banner');
    const inner = document.getElementById('overdue-banner-inner');
    if (overdue.length === 0) { banner.classList.add('hidden'); return; }
    const sum = overdue.reduce((s, p) => s + Number(p.amount || 0), 0);
    inner.innerHTML = `⚠️ Просрочено платежей: <b>${overdue.length}</b> на сумму <b>${fmtMoney(sum)} ${esc(state.settingsDoc.currency || '')}</b> — перенесены на сегодня, нажмите, чтобы перейти к текущему месяцу`;
    inner.onclick = () => {
      const d = new Date();
      state.year = d.getFullYear(); state.month = d.getMonth();
      state.weekStart = getMonday(d);
      setViewMode('month');
      buildPeriodSelectors();
    };
    banner.classList.remove('hidden');
  }

  function visiblePayments() {
    return state.showOnlyUnpaid ? state.payments.filter((p) => !p.paid) : state.payments;
  }

  function paymentsInPeriod() {
    const dates = getPeriodDates();
    const startStr = dateStr(dates[0]);
    const endStr = dateStr(dates[dates.length - 1]);
    return visiblePayments().filter((p) => p.dueDate && p.dueDate >= startStr && p.dueDate <= endStr);
  }

  function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

  function renderSummary() {
    const cur = state.settingsDoc.currency || '';
    const periodLabel = state.viewMode === 'week' ? 'за неделю' : 'за месяц';
    document.getElementById('label-total').textContent = 'Начислено ' + periodLabel;
    document.getElementById('label-paid').textContent = 'Оплачено ' + periodLabel;
    document.getElementById('label-unpaid').textContent = 'К оплате ' + periodLabel;

    const periodPayments = paymentsInPeriod();
    const total = periodPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const paid = periodPayments.filter((p) => p.paid).reduce((s, p) => s + Number(p.amount || 0), 0);
    const unpaid = total - paid;
    const unpaidTotal = state.payments.filter((p) => !p.paid).reduce((s, p) => s + Number(p.amount || 0), 0);

    document.getElementById('sum-total').textContent = fmtMoney(total) + ' ' + cur;
    document.getElementById('sum-paid').textContent = fmtMoney(paid) + ' ' + cur;
    document.getElementById('sum-unpaid').textContent = fmtMoney(unpaid) + ' ' + cur;
    document.getElementById('sum-unpaid-total').textContent = fmtMoney(unpaidTotal) + ' ' + cur;
  }

  function renderTable() {
    const contragents = state.contragents;
    const names = contragents.map((c) => c.name);
    const periodDates = getPeriodDates();
    const today = todayStr();
    const cur = state.settingsDoc.currency || '';
    const payments = visiblePayments();

    document.getElementById('table-colgroup').innerHTML =
      '<col class="col-date-w">' + names.map(() => '<col class="col-data-w">').join('') + '<col class="col-total-w">';

    const head = document.getElementById('table-head-row');
    head.innerHTML = '<th>Дата</th>' + names.map((n) => `<th>${esc(n)}</th>`).join('') + '<th class="col-total">Всего</th>';

    const body = document.getElementById('table-body');
    const colTotals = new Array(names.length).fill(0);
    let grandTotal = 0;
    let rowsHtml = '';

    periodDates.forEach((dObj) => {
      const dateStr2 = dateStr(dObj);
      const wd = WEEKDAYS[dObj.getDay()];
      const isWeekend = dObj.getDay() === 0 || dObj.getDay() === 6;
      const isToday = dateStr2 === today;

      let rowTotal = 0;
      let cellsHtml = '';
      names.forEach((name, ci) => {
        const cellPayments = payments.filter((p) => p.dueDate === dateStr2 && p.contragent === name);
        const sum = cellPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
        rowTotal += sum;
        colTotals[ci] += sum;

        if (cellPayments.length === 0) {
          const editable = isAdmin() ? ' has-editor' : '';
          cellsHtml += `<td class="cell${editable}" data-date="${dateStr2}" data-c="${esc(name)}"><span class="empty-dot">·</span></td>`;
        } else {
          const hasUnpaid = cellPayments.some((p) => !p.paid);
          const hasRolled = cellPayments.some((p) => p.rolled && !p.paid);
          const statusClass = hasUnpaid ? 'unpaid' : 'paid';
          const rolledClass = hasRolled ? ' rolled' : '';
          const editable = isAdmin() ? ' has-editor' : '';
          const title = `${name}: ${fmtMoney(sum)} ${cur}`;
          cellsHtml += `<td class="cell ${statusClass}${rolledClass}${editable}" title="${esc(title)}" data-date="${dateStr2}" data-c="${esc(name)}"><span class="amt">${fmtMoney(sum)}</span></td>`;
        }
      });

      grandTotal += rowTotal;
      const rowClasses = ['', isWeekend ? 'weekend' : '', isToday ? 'today' : ''].join(' ').trim();
      rowsHtml += `<tr class="${rowClasses}">
        <td class="col-date">${pad(dObj.getDate())}.${pad(dObj.getMonth() + 1)} ${wd}</td>
        ${cellsHtml}
        <td class="col-total-cell">${rowTotal ? fmtMoney(rowTotal) : '<span class="empty-dot">·</span>'}</td>
      </tr>`;
    });
    body.innerHTML = rowsHtml;

    const foot = document.getElementById('table-foot-row');
    foot.innerHTML = '<td class="col-date">Итого</td>' +
      colTotals.map((t) => `<td>${t ? fmtMoney(t) : '—'}</td>`).join('') +
      `<td class="col-total-cell">${fmtMoney(grandTotal)}</td>`;

    body.querySelectorAll('td.cell').forEach((td) => {
      td.addEventListener('click', () => {
        const date = td.getAttribute('data-date');
        const c = td.getAttribute('data-c');
        const hasData = !td.querySelector('.empty-dot');
        if (isAdmin()) openCellModal(c, date);
        else if (hasData) openCellModal(c, date, true);
      });
    });
  }

  // ---------- cell modal ----------
  let cellCtx = { contragent: null, date: null, readonly: false };

  function openCellModal(contragent, date, readonly) {
    cellCtx = { contragent, date, readonly: !!readonly };
    const d = new Date(date + 'T00:00:00');
    document.getElementById('cell-modal-title').textContent = contragent;
    document.getElementById('cell-modal-sub').textContent = `${pad(d.getDate())} ${MONTHS[d.getMonth()].toLowerCase()} ${d.getFullYear()}`;
    document.getElementById('cell-add-form-wrap').style.display = readonly ? 'none' : 'block';
    document.getElementById('cell-add-amount').value = '';
    document.getElementById('cell-add-note').value = '';
    document.getElementById('cell-add-paid').checked = false;
    renderCellPaymentsList();
    openModal('modal-cell');
  }

  function renderCellPaymentsList() {
    const list = state.payments.filter((p) => p.contragent === cellCtx.contragent && p.dueDate === cellCtx.date);
    const wrap = document.getElementById('cell-payments-list');
    const cur = state.settingsDoc.currency || '';
    if (list.length === 0) { wrap.innerHTML = '<div class="empty-note">Платежей пока нет</div>'; return; }
    wrap.innerHTML = list.map((p) => {
      const overdueTag = p.rolled && !p.paid ? ' · перенесено с ' + p.originalDueDate : '';
      const noteTag = p.note ? ' · ' + esc(p.note) : '';
      const btns = cellCtx.readonly ? '' : `
        <div class="row-btns">
          <button class="check-toggle${p.paid ? ' is-paid' : ''}" data-act="toggle" data-id="${p.id}" title="${p.paid ? 'Отметить неоплаченным' : 'Отметить оплаченным'}">${p.paid ? '✓' : ''}</button>
          <button class="btn btn-sm btn-danger" data-act="delete" data-id="${p.id}">Удалить</button>
        </div>`;
      return `<div class="list-row">
        <div class="grow">
          <div class="name">${fmtMoney(p.amount)} ${esc(cur)}</div>
          <div class="meta">${p.paid ? 'Оплачено' : 'Не оплачено'}${overdueTag}${noteTag}</div>
        </div>
        ${btns}
      </div>`;
    }).join('');

    if (!cellCtx.readonly) {
      wrap.querySelectorAll('[data-act="toggle"]').forEach((btn) => btn.addEventListener('click', () => togglePaid(btn.getAttribute('data-id'))));
      wrap.querySelectorAll('[data-act="delete"]').forEach((btn) => btn.addEventListener('click', () => deletePaymentRow(btn.getAttribute('data-id'))));
    }
  }

  async function togglePaid(id) {
    const p = state.payments.find((x) => x.id === id);
    if (!p) return;
    const paid = !p.paid;
    try {
      await Store.updatePayment(id, { paid, paidDate: paid ? todayStr() : null, rolled: paid ? false : p.rolled });
    } catch (e) { toast('Не удалось сохранить: ' + authErrorMessage(e), 'err'); }
  }

  async function deletePaymentRow(id) {
    if (!confirm('Удалить этот платёж?')) return;
    try { await Store.deletePayment(id); } catch (e) { toast('Не удалось удалить: ' + authErrorMessage(e), 'err'); }
  }

  async function addPaymentFromCell() {
    const amountInput = document.getElementById('cell-add-amount');
    const amount = parseFloat(amountInput.value);
    if (!amount || amount <= 0) { toast('Укажите сумму больше нуля', 'err'); return; }
    const note = document.getElementById('cell-add-note').value.trim();
    const paidNow = document.getElementById('cell-add-paid').checked;
    try {
      await Store.addPayment({
        contragent: cellCtx.contragent, amount, note,
        dueDate: cellCtx.date, paid: paidNow, paidDate: paidNow ? todayStr() : null,
        rolled: false, originalDueDate: null,
      });
      document.getElementById('cell-add-amount').value = '';
      document.getElementById('cell-add-note').value = '';
      document.getElementById('cell-add-paid').checked = false;
      toast('Платёж добавлен', 'ok');
    } catch (e) { toast('Не удалось добавить: ' + authErrorMessage(e), 'err'); }
  }

  // ---------- contragents management ----------
  function renderContragentsList() {
    const wrap = document.getElementById('contragents-list');
    if (state.contragents.length === 0) { wrap.innerHTML = '<div class="empty-note">Список пуст</div>'; return; }
    wrap.innerHTML = state.contragents.map((c) => {
      const count = state.payments.filter((p) => p.contragent === c.name).length;
      return `<div class="list-row">
        <div class="grow"><div class="name">${esc(c.name)}</div><div class="meta">${count ? count + ' платеж(ей) в истории' : 'нет платежей'}</div></div>
        <div class="row-btns">
          <button class="btn btn-sm" data-act="rename" data-id="${c.id}" data-name="${esc(c.name)}">Переименовать</button>
          <button class="btn btn-sm btn-danger" data-act="delete" data-id="${c.id}" data-name="${esc(c.name)}">Удалить</button>
        </div>
      </div>`;
    }).join('');
    wrap.querySelectorAll('[data-act="delete"]').forEach((btn) => {
      btn.addEventListener('click', () => deleteContragentRow(btn.getAttribute('data-id'), btn.getAttribute('data-name')));
    });
    wrap.querySelectorAll('[data-act="rename"]').forEach((btn) => {
      btn.addEventListener('click', () => renameContragentRow(btn.getAttribute('data-id'), btn.getAttribute('data-name')));
    });
  }

  async function renameContragentRow(id, oldName) {
    const newName = prompt('Новое название контрагента:', oldName);
    if (newName === null) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    if (state.contragents.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) { toast('Такой контрагент уже есть', 'err'); return; }
    try {
      await Store.renameContragent(id, oldName, trimmed);
      toast('Контрагент переименован', 'ok');
    } catch (e) { toast('Не удалось переименовать: ' + authErrorMessage(e), 'err'); }
  }

  async function addContragentRow() {
    const input = document.getElementById('new-contragent-name');
    const name = input.value.trim();
    if (!name) return;
    if (state.contragents.some((c) => c.name.toLowerCase() === name.toLowerCase())) { toast('Такой контрагент уже есть', 'err'); return; }
    try {
      await Store.addContragent(name);
      input.value = '';
      toast('Контрагент добавлен', 'ok');
    } catch (e) { toast('Не удалось добавить: ' + authErrorMessage(e), 'err'); }
  }

  async function deleteContragentRow(id, name) {
    const count = state.payments.filter((p) => p.contragent === name).length;
    const msg = count > 0
      ? `У контрагента «${name}» есть ${count} платеж(ей). Удалить контрагента вместе со всеми его платежами?`
      : `Удалить контрагента «${name}»?`;
    if (!confirm(msg)) return;
    try {
      await Store.deleteContragent(id, name);
      toast('Контрагент удалён', 'ok');
    } catch (e) { toast('Не удалось удалить: ' + authErrorMessage(e), 'err'); }
  }

  // ---------- users management ----------
  function renderUsersList() {
    const wrap = document.getElementById('users-list');
    wrap.innerHTML = state.users.map((u) => `
      <div class="list-row">
        <div class="grow">
          <div class="name">${esc(u.displayName || u.email)} <span class="meta">${u.role === 'admin' ? '· Админ' : '· Просмотр'}</span></div>
          <div class="meta">${esc(u.email)}</div>
        </div>
        <div class="row-btns">
          <button class="btn btn-sm" data-act="reset" data-uid="${u.uid}" data-email="${esc(u.email)}">Сбросить пароль</button>
          <button class="btn btn-sm btn-danger" data-act="revoke" data-uid="${u.uid}">Отозвать доступ</button>
        </div>
      </div>`).join('');

    wrap.querySelectorAll('[data-act="reset"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        Store.sendPasswordReset(btn.getAttribute('data-email'))
          .then(() => toast('Ссылка для сброса пароля отправлена на ' + btn.getAttribute('data-email'), 'ok'))
          .catch((err) => toast(authErrorMessage(err), 'err'));
      });
    });
    wrap.querySelectorAll('[data-act="revoke"]').forEach((btn) => {
      btn.addEventListener('click', () => revokeUserRow(btn.getAttribute('data-uid')));
    });
  }

  async function revokeUserRow(uid) {
    const admins = state.users.filter((u) => u.role === 'admin');
    const target = state.users.find((u) => u.uid === uid);
    if (target && target.role === 'admin' && admins.length <= 1) { toast('Нельзя отозвать доступ у единственного администратора', 'err'); return; }
    if (state.user && state.user.uid === uid) { toast('Нельзя отозвать доступ у самого себя во время работы в системе', 'err'); return; }
    if (!confirm(`Отозвать доступ пользователю «${target ? (target.displayName || target.email) : uid}»? Он больше не сможет входить в приложение.`)) return;
    try { await Store.revokeUser(uid); toast('Доступ отозван', 'ok'); }
    catch (e) { toast('Не удалось отозвать доступ: ' + authErrorMessage(e), 'err'); }
  }

  async function addUserRow() {
    const displayName = document.getElementById('new-user-name').value.trim();
    const email = document.getElementById('new-user-login').value.trim();
    const pass = document.getElementById('new-user-password').value;
    const role = document.getElementById('new-user-role').value;
    if (!displayName || !email || !pass) { toast('Заполните имя, email и пароль', 'err'); return; }
    if (pass.length < 6) { toast('Пароль должен быть не короче 6 символов', 'err'); return; }
    try {
      await Store.createUser(displayName, email, pass, role);
      document.getElementById('new-user-name').value = '';
      document.getElementById('new-user-login').value = '';
      document.getElementById('new-user-password').value = '';
      toast('Пользователь создан', 'ok');
    } catch (e) { toast('Не удалось создать пользователя: ' + authErrorMessage(e), 'err'); }
  }

  // ---------- theme (dark / light, локально) ----------
  function applyColors() {
    const theme = state.theme === 'light' ? 'light' : 'dark';
    const colors = Store.THEMES[theme];
    const root = document.documentElement;
    for (const k in colors) root.style.setProperty(k, colors[k]);
    root.setAttribute('data-theme', theme);
    updateThemeButton();
  }
  function updateThemeButton() {
    const btn = document.getElementById('btn-theme-toggle');
    if (!btn) return;
    const isLight = state.theme === 'light';
    btn.textContent = isLight ? '🌙' : '☀️';
    btn.title = isLight ? 'Включить тёмную тему' : 'Включить светлую тему';
  }
  function toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    Store.setTheme(state.theme);
    applyColors();
  }

  // ---------- global events ----------
  function bindGlobalEvents() {
    document.querySelectorAll('[data-close]').forEach((btn) => { btn.onclick = () => closeModal(btn.getAttribute('data-close')); });
    document.querySelectorAll('.modal-overlay').forEach((ov) => {
      ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('open'); });
    });

    document.getElementById('btn-theme-toggle').onclick = toggleTheme;

    // боковая панель на телефоне
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    const openSidebar = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); };
    const closeSidebar = () => { sidebar.classList.remove('open'); backdrop.classList.remove('open'); };
    document.getElementById('btn-sidebar-open').onclick = openSidebar;
    document.getElementById('btn-sidebar-close').onclick = closeSidebar;
    backdrop.onclick = closeSidebar;

    // фильтр «только неоплаченные»
    const filterCb = document.getElementById('filter-unpaid');
    filterCb.checked = state.showOnlyUnpaid;
    filterCb.onchange = () => { state.showOnlyUnpaid = filterCb.checked; renderAll(); };

    if (isAdmin()) {
      document.getElementById('btn-contragents').onclick = () => { renderContragentsList(); openModal('modal-contragents'); closeSidebar(); };
      document.getElementById('btn-users').onclick = () => { renderUsersList(); openModal('modal-users'); closeSidebar(); };
      document.getElementById('btn-add-contragent').onclick = addContragentRow;
      document.getElementById('new-contragent-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addContragentRow(); });
      document.getElementById('btn-add-user').onclick = addUserRow;
      document.getElementById('btn-cell-add').onclick = addPaymentFromCell;
      document.getElementById('cell-add-amount').addEventListener('keydown', (e) => { if (e.key === 'Enter') addPaymentFromCell(); });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
