/* =========================================================
   orders.js — раздел «Поставки» (заказы поставщикам)
   Данные: коллекция Firestore «orders». Каждый заказ хранит
   свои оплаты (payments) и график оплат (schedule) внутри себя.
   Условия оплаты поставщиков: settings/app → payTerms.
   Права: админ — всё; менеджер — создаёт и правит заказы,
   но не отмечает оплаты; просмотр — только смотрит.
   ========================================================= */
(function () {
  'use strict';

  const PAY_PILL = {
    paid: ['Оплачен', 'pill-ok'], over: ['Переплата', 'pill-info'], overdue: ['Просрочен', 'pill-bad'],
    partial: ['Частично', 'pill-acc'], none: ['Не оплачен', 'pill-warn'],
  };
  const ST_PILL = { 'Новый': 'pill-warn', 'В процессе': 'pill-acc', 'Отгружен': 'pill-info', 'Оприходован': 'pill-info', 'Завершён': 'pill-ok' };
  const STAGE_PILL = {
    paid: ['Оплачен', 'pill-ok'], partial: ['Частично', 'pill-acc'], overdue: ['Просрочен', 'pill-bad'],
    soon: ['Скоро', 'pill-warn'], wait: ['Ожидает', 'pill-info'], nodate: ['Нет даты', 'pill-info'],
  };

  // этап: { label, kind: 'pct'|'sum'|'rest', value, base: 'order'|'ship'|'date', days, date }
  const PRESETS = [
    { name: '100% предоплата', stages: [{ label: 'Предоплата', kind: 'rest', base: 'order', days: 0 }] },
    { name: '30% депозит, остаток перед отгрузкой', stages: [
      { label: 'Депозит', kind: 'pct', value: 30, base: 'order', days: 0 },
      { label: 'Остаток перед отгрузкой', kind: 'rest', base: 'ship', days: 0 }] },
    { name: '50% при отгрузке, 50% через 30 дней', stages: [
      { label: 'При отгрузке', kind: 'pct', value: 50, base: 'ship', days: 0 },
      { label: 'Остаток', kind: 'rest', base: 'ship', days: 30 }] },
    { name: '20% до отгрузки, 50% через месяц, 30% через 2 месяца', stages: [
      { label: 'Перед отгрузкой', kind: 'pct', value: 20, base: 'ship', days: 0 },
      { label: 'Через месяц', kind: 'pct', value: 50, base: 'ship', days: 30 },
      { label: 'Через 2 месяца', kind: 'rest', base: 'ship', days: 60 }] },
    { name: 'Отсрочка 30 дней после отгрузки', stages: [{ label: 'Оплата (отсрочка 30 дн)', kind: 'rest', base: 'ship', days: 30 }] },
    { name: 'Отсрочка 60 дней после отгрузки', stages: [{ label: 'Оплата (отсрочка 60 дн)', kind: 'rest', base: 'ship', days: 60 }] },
  ];
  // условия «по умолчанию» для известных поставщиков (можно переопределить галочкой «Запомнить»)
  const DEFAULT_TERMS = [
    { test: (k) => k === 'про' || k.includes('проэкспорт'), preset: 3 },
    { test: (k) => k.includes('anhua') || k.includes('анхуа'), preset: 2 },
    { test: (k) => k.includes('yijia') || k.includes('yjia') || k.includes('йиджиа'), preset: 1 },
  ];

  let orders = [];
  let unsub = null;
  let bound = false;
  const open = new Set();
  let editId = null;
  let payId = null;
  let payStageIdx = null;
  let stages = [];          // редактируемые этапы в окне заказа
  let stagesTouched = false;

  const A = () => window.PCApp;
  const $ = (id) => document.getElementById(id);
  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const fmt = (n) => r2(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (s) => {
    if (s === null || s === undefined) return NaN;
    const v = String(s).replace(/[\s ]/g, '').replace(',', '.');
    return v === '' ? NaN : Number(v);
  };
  const dRu = (d) => (d ? String(d).split('-').reverse().join('.') : '—');
  const esc = (s) => A().esc(s);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const canEdit = () => A().isAdmin() || A().isManager();
  const canPay = () => A().isAdmin();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const supKey = (name) => String(name || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '');
  function addDays(dateStr, days) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + (Number(days) || 0));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ---------- условия поставщика ----------
  function termsFor(supplier) {
    const k = supKey(supplier);
    if (!k) return null;
    const saved = (A().settings().payTerms || {})[k];
    if (Array.isArray(saved) && saved.length) return clone(saved);
    const def = DEFAULT_TERMS.find((t) => t.test(k));
    return def ? clone(PRESETS[def.preset].stages) : null;
  }

  // ---------- расчёт графика ----------
  // stageList — этапы; ctx — { actual, date, ship } ; возвращает этапы с суммой и сроком
  function resolveStages(stageList, ctx) {
    const actual = Number(ctx.actual) || 0;
    const shipDate = ctx.ship || '';
    const fixed = stageList.reduce((s, st) => {
      if (st.kind === 'pct') return s + actual * (Number(st.value) || 0) / 100;
      if (st.kind === 'sum') return s + (Number(st.value) || 0);
      return s;
    }, 0);
    const restCount = stageList.filter((st) => st.kind === 'rest').length || 1;
    return stageList.map((st) => {
      let amount;
      if (st.kind === 'pct') amount = actual * (Number(st.value) || 0) / 100;
      else if (st.kind === 'sum') amount = Number(st.value) || 0;
      else amount = Math.max(0, actual - fixed) / restCount;
      let due = '';
      if (st.base === 'order') due = addDays(ctx.date, st.days);
      else if (st.base === 'ship') due = addDays(shipDate, st.days);
      else due = st.date || '';
      return Object.assign({}, st, { amount: r2(amount), due });
    });
  }
  function whenText(st) {
    const d = Number(st.days) || 0;
    if (st.base === 'date') return st.date ? 'до ' + dRu(st.date) : 'дата не указана';
    const base = st.base === 'order' ? 'заказа' : 'отгрузки';
    if (d === 0) return st.base === 'order' ? 'в день заказа' : 'к дате отгрузки';
    return d > 0 ? `через ${d} дн. после ${base}` : `за ${-d} дн. до ${base}`;
  }
  function scheduleOf(o) {
    let list = Array.isArray(o.schedule) && o.schedule.length ? o.schedule : null;
    if (!list) list = o.payDate ? [{ label: 'Полная оплата', kind: 'rest', base: 'date', date: o.payDate }]
      : [{ label: 'Полная оплата', kind: 'rest', base: 'ship', days: 0 }];
    return resolveStages(list, { actual: o.actual, date: o.date, ship: o.shipFact || o.ship });
  }

  function calc(o) {
    const pays = o.payments || [];
    const bank = pays.filter((p) => p.type === 'bank').reduce((a, p) => a + Number(p.amount || 0), 0);
    const cash = pays.filter((p) => p.type === 'cash').reduce((a, p) => a + Number(p.amount || 0), 0);
    const official = Number(o.official || 0), actual = Number(o.actual || 0);
    const cashPart = actual - official;
    const remBank = r2(official - bank), remCash = r2(cashPart - cash), remTotal = r2(actual - bank - cash);
    const today = A().todayStr();
    const soon = addDays(today, 7);
    // распределяем все оплаты по этапам по порядку
    let left = bank + cash;
    const sched = scheduleOf(o).map((st) => {
      const paid = r2(Math.min(st.amount, Math.max(0, left)));
      left -= paid;
      const rest = r2(st.amount - paid);
      let status;
      if (rest <= 0) status = 'paid';
      else if (!st.due) status = paid > 0 ? 'partial' : 'nodate';
      else if (st.due < today) status = 'overdue';
      else if (st.due <= soon) status = 'soon';
      else status = paid > 0 ? 'partial' : 'wait';
      return Object.assign(st, { paid, rest, status });
    });
    const overdueSum = r2(sched.filter((s) => s.status === 'overdue').reduce((a, s) => a + s.rest, 0));
    const next = sched.find((s) => s.rest > 0) || null;
    let pay;
    if (remTotal < 0) pay = 'over';
    else if (remTotal === 0) pay = 'paid';
    else if (overdueSum > 0) pay = 'overdue';
    else if (bank + cash > 0) pay = 'partial';
    else pay = 'none';
    return { bank, cash, cashPart, remBank, remCash, remTotal, pay, sched, next, overdueSum };
  }
  const remCell = (v) => (v > 0 ? `<span class="o-debt">${fmt(v)}</span>` : v < 0 ? `<span class="o-over">${fmt(v)}</span>` : '<span class="o-zero">0,00</span>');

  // ---------- подключение ----------
  function mount() {
    bindOnce();
    unmount();
    unsub = Store.watchOrders((list) => {
      orders = list;
      render();
    }, (err) => A().toast('Ошибка загрузки поставок: ' + A().errText(err) + '. Проверьте правила Firestore (README, раздел «Поставки»).', 'err'));
    $('btn-order-new').classList.toggle('hidden', !canEdit());
  }
  function unmount() {
    if (unsub) { unsub(); unsub = null; }
    orders = [];
  }

  // ---------- отрисовка ----------
  function render() {
    if (!A() || !A().getUser()) return;
    const view = $('view-orders');
    if (!view || view.classList.contains('hidden')) return;
    const cur = A().currency();

    const sups = [...new Set(orders.map((o) => o.supplier).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    const fs = $('of-supplier'), curSup = fs.value;
    fs.innerHTML = '<option value="">Все поставщики</option>' + sups.map((s) => `<option${s === curSup ? ' selected' : ''}>${esc(s)}</option>`).join('');
    const hints = [...new Set(sups.concat(A().contragentNames()))];
    $('o-sup-list').innerHTML = hints.map((s) => `<option value="${esc(s)}">`).join('');

    const calcs = new Map(orders.map((o) => [o.id, calc(o)]));

    // карточки
    let dBank = 0, dCash = 0, overdue = 0, week = 0, active = 0;
    orders.forEach((o) => {
      const c = calcs.get(o.id);
      if (c.remBank > 0) dBank += c.remBank;
      if (c.remCash > 0) dCash += c.remCash;
      overdue += c.overdueSum;
      c.sched.forEach((s) => { if (s.status === 'soon') week += s.rest; });
      if (o.status !== 'Завершён') active++;
    });
    const card = (label, val, cls) => `<div class="card ${cls || ''}"><div class="label">${label}</div><div class="value">${val}</div></div>`;
    $('orders-cards').innerHTML =
      card('Долг безнал', fmt(dBank) + ' ' + esc(cur)) +
      card('Долг нал', fmt(dCash) + ' ' + esc(cur)) +
      card('Оплатить за 7 дней', fmt(week) + ' ' + esc(cur), 'accent') +
      card('Просрочено', fmt(overdue) + ' ' + esc(cur), overdue > 0 ? 'unpaid' : '') +
      card('Активных заказов', active);

    // таблица заказов
    const q = $('of-search').value.trim().toLowerCase();
    const fSt = $('of-status').value, fP = $('of-pay').value, fSup = fs.value;
    const list = orders.filter((o) => {
      const c = calcs.get(o.id);
      if (fSup && o.supplier !== fSup) return false;
      if (fSt && o.status !== fSt) return false;
      if (fP === 'debt' && !(c.remTotal > 0)) return false;
      if (fP && fP !== 'debt' && c.pay !== fP) return false;
      if (q && !(`${o.num} ${o.supplier} ${o.invoice} ${o.manager} ${o.comment}`.toLowerCase().includes(q))) return false;
      return true;
    }).sort((a, b) => (b.num || 0) - (a.num || 0));

    const body = $('orders-body');
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="12" class="orders-empty">${orders.length ? 'Заказов не найдено — измените фильтры' : 'Заказов пока нет' + (canEdit() ? '. Нажмите «+ Новый заказ».' : '')}</td></tr>`;
    } else {
      body.innerHTML = list.map((o) => {
        const c = calcs.get(o.id), pp = PAY_PILL[c.pay];
        const ship = o.shipFact ? 'отгружен ' + dRu(o.shipFact) : o.ship ? 'отгр. ' + dRu(o.ship) : '';
        const nx = c.next;
        const nextHtml = nx
          ? `<div class="o-next"><b class="${nx.status === 'overdue' ? 'o-debt' : ''}">${nx.due ? dRu(nx.due) : '—'}</b> · ${fmt(nx.rest)}</div><div class="o-sub">${esc(nx.label || '')}${nx.due ? '' : ' (' + esc(whenText(nx)) + ')'}</div>`
          : '<span class="o-zero">—</span>';
        let h = `<tr class="o-row" data-id="${o.id}">
          <td><span class="o-num">№${esc(o.num)}</span> ${esc(o.supplier)}<div class="o-sub">${esc(o.manager || '—')}${ship ? ' · ' + ship : ''}</div></td>
          <td>${o.invoice ? 'счёт ' + esc(o.invoice) : '<span class="o-sub">без счёта</span>'}<div class="o-sub">${dRu(o.date)}</div></td>
          <td class="n">${fmt(o.official)}</td>
          <td class="n">${fmt(o.actual)}<div class="o-sub">нал часть ${fmt(c.cashPart)}</div></td>
          <td class="n">${fmt(c.bank)}</td>
          <td class="n">${fmt(c.cash)}</td>
          <td class="n">${remCell(c.remBank)}</td>
          <td class="n">${remCell(c.remCash)}</td>
          <td class="n"><b>${remCell(c.remTotal)}</b></td>
          <td>${nextHtml}</td>
          <td><span class="pill ${ST_PILL[o.status] || 'pill-warn'}">${esc(o.status || '—')}</span><br><span class="pill ${pp[1]}">${pp[0]}</span></td>
          <td><div class="o-btns">
            ${canPay() ? `<button type="button" class="btn btn-sm btn-primary" data-act="pay" data-id="${o.id}">Оплата</button>` : ''}
            ${canEdit() ? `<button type="button" class="btn btn-sm" data-act="edit" data-id="${o.id}">Изменить</button>` : ''}
          </div></td></tr>`;
        if (open.has(o.id)) {
          const pays = (o.payments || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
          h += `<tr class="o-pays"><td colspan="12"><b>График оплат по заказу №${esc(o.num)}</b>${o.comment ? ` · <span class="o-sub">${esc(o.comment)}</span>` : ''}
            <table class="o-sched"><tr><th>Этап</th><th>Условие</th><th>Срок</th><th class="n">Сумма</th><th class="n">Оплачено</th><th class="n">Осталось</th><th>Статус</th></tr>
            ${c.sched.map((s) => `<tr><td>${esc(s.label || '')}</td><td class="o-sub">${s.kind === 'pct' ? esc(s.value) + '% · ' : s.kind === 'rest' ? 'остаток · ' : ''}${esc(whenText(s))}</td>
              <td>${s.due ? dRu(s.due) : '—'}</td><td class="n">${fmt(s.amount)}</td><td class="n">${fmt(s.paid)}</td><td class="n">${remCell(s.rest)}</td>
              <td><span class="pill ${STAGE_PILL[s.status][1]}">${STAGE_PILL[s.status][0]}</span></td></tr>`).join('')}
            </table>
            <div style="margin-top:12px"><b>Оплаты</b></div>
            ${pays.length ? '<table><tr><th>Дата</th><th>Вид</th><th class="n">Сумма</th><th>Комментарий</th><th>Внёс</th><th></th></tr>' +
              pays.map((p) => `<tr><td>${dRu(p.date)}</td><td>${p.type === 'bank' ? 'Безнал' : 'Нал'}</td><td class="n">${fmt(p.amount)}</td>
                <td>${esc(p.note || '')}</td><td class="o-sub">${esc(p.by || '')}</td>
                <td>${canPay() ? `<button type="button" class="btn btn-sm btn-danger" data-act="delpay" data-id="${o.id}" data-pid="${esc(p.id)}">Удалить</button>` : ''}</td></tr>`).join('') +
              '</table>' : '<div class="o-sub" style="padding:6px 0">Оплат пока нет</div>'}
          </td></tr>`;
        }
        return h;
      }).join('');
    }

    // график платежей: все неоплаченные этапы
    const plan = [];
    orders.forEach((o) => {
      if (fSup && o.supplier !== fSup) return;
      calcs.get(o.id).sched.forEach((s, i) => { if (s.rest > 0) plan.push({ o, s, i }); });
    });
    plan.sort((a, b) => (a.s.due || '9999') < (b.s.due || '9999') ? -1 : (a.s.due || '9999') > (b.s.due || '9999') ? 1 : (a.o.num || 0) - (b.o.num || 0));
    $('orders-plan-body').innerHTML = plan.length ? plan.map(({ o, s, i }) => `<tr>
        <td><b class="${s.status === 'overdue' ? 'o-debt' : ''}">${s.due ? dRu(s.due) : '—'}</b>${s.due ? '' : `<div class="o-sub">${esc(whenText(s))}</div>`}</td>
        <td><span class="o-num">№${esc(o.num)}</span> ${esc(o.supplier)}</td>
        <td>${esc(s.label || '')}<div class="o-sub">${s.kind === 'pct' ? esc(s.value) + '% · ' : ''}${esc(whenText(s))}</div></td>
        <td class="n"><b>${fmt(s.rest)}</b>${s.paid > 0 ? `<div class="o-sub">из ${fmt(s.amount)}</div>` : ''}</td>
        <td><span class="pill ${STAGE_PILL[s.status][1]}">${STAGE_PILL[s.status][0]}</span></td>
        <td>${canPay() ? `<button type="button" class="btn btn-sm" data-act="paystage" data-id="${o.id}" data-idx="${i}">Оплатить</button>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="orders-empty">Предстоящих платежей нет</td></tr>';

    // долг по поставщикам
    const agg = {};
    orders.forEach((o) => {
      const c = calcs.get(o.id);
      const a = agg[o.supplier] || (agg[o.supplier] = { n: 0, act: 0, paid: 0, rb: 0, rc: 0, rt: 0 });
      a.n++; a.act += Number(o.actual || 0); a.paid += c.bank + c.cash; a.rb += c.remBank; a.rc += c.remCash; a.rt += c.remTotal;
    });
    $('orders-sup-body').innerHTML = Object.keys(agg).sort((a, b) => a.localeCompare(b, 'ru')).map((s) => {
      const a = agg[s];
      return `<tr><td>${esc(s)}</td><td class="n">${a.n}</td><td class="n">${fmt(a.act)}</td><td class="n">${fmt(a.paid)}</td>
        <td class="n">${remCell(r2(a.rb))}</td><td class="n">${remCell(r2(a.rc))}</td><td class="n"><b>${remCell(r2(a.rt))}</b></td></tr>`;
    }).join('') || '<tr><td colspan="7" class="orders-empty">Нет данных</td></tr>';

    $('btn-order-new').classList.toggle('hidden', !canEdit());
  }

  // ---------- окно заказа ----------
  function fillPresetSelect() {
    const sup = $('o-supplier').value.trim();
    const own = sup && termsFor(sup);
    $('o-terms-preset').innerHTML = '<option value="">Шаблон условий…</option>' +
      (own ? `<option value="own">Условия поставщика «${esc(sup)}»</option>` : '') +
      PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  }
  function showOrder(id) {
    editId = id;
    const o = id ? orders.find((x) => x.id === id) : null;
    const nextNum = orders.reduce((m, x) => Math.max(m, Number(x.num) || 0), 0) + 1;
    $('order-modal-title').textContent = o ? `Заказ №${o.num}` : `Новый заказ №${nextNum}`;
    $('o-supplier').value = o ? o.supplier || '' : '';
    $('o-manager').value = o ? o.manager || '' : (A().getUser().displayName || '');
    $('o-status').value = o ? o.status || 'Новый' : 'Новый';
    $('o-invoice').value = o ? o.invoice || '' : '';
    $('o-date').value = o ? o.date || '' : A().todayStr();
    $('o-official').value = o ? fmt(o.official) : '';
    $('o-actual').value = o ? fmt(o.actual) : '';
    $('o-ship').value = o ? o.ship || '' : '';
    $('o-shipfact').value = o ? o.shipFact || '' : '';
    $('o-comment').value = o ? o.comment || '' : '';
    $('btn-order-delete').style.visibility = o && A().isAdmin() ? 'visible' : 'hidden';
    $('o-terms-save-wrap').classList.toggle('hidden', !A().isAdmin());
    $('o-terms-save').checked = false;
    $('o-err').textContent = '';
    if (o && Array.isArray(o.schedule) && o.schedule.length) stages = clone(o.schedule);
    else if (o && o.payDate) stages = [{ label: 'Полная оплата', kind: 'rest', base: 'date', date: o.payDate }];
    else stages = (o && termsFor(o.supplier)) || [{ label: 'Оплата', kind: 'rest', base: 'ship', days: 0 }];
    stagesTouched = !!o;
    fillPresetSelect();
    orderCalc();
    renderStages();
    document.getElementById('modal-order').classList.add('open');
  }
  function orderCalc() {
    const a = num($('o-official').value), b = num($('o-actual').value);
    $('o-calc').innerHTML = (!isNaN(a) && !isNaN(b))
      ? `Безнал к оплате: <b>${fmt(a)}</b> · Нал к оплате: <b>${fmt(b - a)}</b> · Всего: <b>${fmt(b)}</b>`
      : 'Введите официальную и фактическую стоимость — нал посчитается сам.';
  }
  function stageCtx() {
    const b = num($('o-actual').value);
    return { actual: isNaN(b) ? 0 : b, date: $('o-date').value, ship: $('o-shipfact').value || $('o-ship').value };
  }
  function renderStages() {
    const wrap = $('o-stages');
    wrap.innerHTML = stages.map((st, i) => `
      <div class="stage-row" data-i="${i}">
        <input class="st-label" data-f="label" value="${esc(st.label || '')}" placeholder="Название этапа">
        <select data-f="kind">
          <option value="pct"${st.kind === 'pct' ? ' selected' : ''}>%</option>
          <option value="sum"${st.kind === 'sum' ? ' selected' : ''}>Сумма</option>
          <option value="rest"${st.kind === 'rest' ? ' selected' : ''}>Остаток</option>
        </select>
        <input data-f="value" inputmode="decimal" value="${st.kind === 'rest' ? '' : esc(st.kind === 'sum' ? fmt(st.value) : (st.value ?? ''))}" placeholder="${st.kind === 'pct' ? '30' : st.kind === 'sum' ? '1 000 000' : 'авто'}"${st.kind === 'rest' ? ' disabled' : ''}>
        <select data-f="base">
          <option value="order"${st.base === 'order' ? ' selected' : ''}>от заказа</option>
          <option value="ship"${st.base === 'ship' ? ' selected' : ''}>от отгрузки</option>
          <option value="date"${st.base === 'date' ? ' selected' : ''}>точная дата</option>
        </select>
        ${st.base === 'date'
          ? `<input type="date" data-f="date" value="${esc(st.date || '')}">`
          : `<div class="stage-when"><input data-f="days" inputmode="numeric" value="${esc(st.days ?? 0)}"><span>дн.</span></div>`}
        <button type="button" class="stage-del" data-del="${i}" title="Удалить этап">✕</button>
        <div class="stage-prev" id="st-prev-${i}"></div>
      </div>`).join('');
    updateStagePreview();
  }
  function updateStagePreview() {
    const res = resolveStages(stages, stageCtx());
    res.forEach((s, i) => {
      const el = $('st-prev-' + i);
      if (el) el.innerHTML = `${esc(whenText(s))} → <b>${s.due ? dRu(s.due) : 'дата появится после ввода даты отгрузки'}</b> · <b>${fmt(s.amount)}</b>`;
    });
    const ctx = stageCtx();
    const total = r2(res.reduce((a, s) => a + s.amount, 0));
    const diff = r2(ctx.actual - total);
    const el = $('o-stages-sum');
    if (!stages.length) el.innerHTML = '<span class="o-debt">Добавьте хотя бы один этап оплаты</span>';
    else if (Math.abs(diff) < 0.01) el.innerHTML = `Этапы покрывают всю сумму: <b>${fmt(total)}</b>`;
    else el.innerHTML = `<span class="o-debt">Этапы дают ${fmt(total)}, а сумма заказа ${fmt(ctx.actual)} (разница ${fmt(diff)}). Добавьте этап «Остаток» или поправьте суммы.</span>`;
    return diff;
  }
  function readStageInput(e) {
    const row = e.target.closest('.stage-row');
    if (!row) return;
    const i = Number(row.getAttribute('data-i'));
    const f = e.target.getAttribute('data-f');
    if (!f || !stages[i]) return;
    const st = stages[i];
    let v = e.target.value;
    stagesTouched = true;
    if (f === 'value') st.value = isNaN(num(v)) ? '' : num(v);
    else if (f === 'days') st.days = isNaN(num(v)) ? 0 : Math.round(num(v));
    else st[f] = v;
    if (f === 'kind' || f === 'base') {
      if (f === 'kind' && v === 'rest') delete st.value;
      if (f === 'base' && v === 'date') { st.date = st.date || ''; delete st.days; }
      if (f === 'base' && v !== 'date') { st.days = st.days || 0; delete st.date; }
      renderStages();
    } else updateStagePreview();
    $('o-err').textContent = '';
  }
  function applyTerms(list) {
    stages = clone(list);
    renderStages();
  }
  async function saveOrder() {
    const err = $('o-err');
    const sup = $('o-supplier').value.trim(), a = num($('o-official').value), b = num($('o-actual').value);
    if (!sup) { err.textContent = 'Укажите поставщика'; return; }
    if (isNaN(a) || a < 0) { err.textContent = 'Введите официальную стоимость числом'; return; }
    if (isNaN(b) || b < 0) { err.textContent = 'Введите фактическую стоимость числом'; return; }
    if (b < a) { err.textContent = 'Фактическая стоимость не может быть меньше официальной'; return; }
    if (!stages.length) { err.textContent = 'Добавьте хотя бы один этап оплаты'; return; }
    for (const st of stages) {
      if (st.kind !== 'rest' && !(Number(st.value) > 0)) { err.textContent = `Укажите ${st.kind === 'pct' ? 'процент' : 'сумму'} для этапа «${st.label || 'без названия'}»`; return; }
      if (st.base === 'date' && !st.date) { err.textContent = `Укажите дату для этапа «${st.label || 'без названия'}»`; return; }
    }
    if (Math.abs(updateStagePreview()) >= 0.01) { err.textContent = 'Сумма этапов не совпадает с фактической стоимостью'; return; }
    const schedule = stages.map((st) => {
      const s = { label: (st.label || '').trim() || 'Оплата', kind: st.kind, base: st.base };
      if (st.kind !== 'rest') s.value = Number(st.value);
      if (st.base === 'date') s.date = st.date; else s.days = Number(st.days) || 0;
      return s;
    });
    const resolved = resolveStages(schedule, stageCtx());
    const lastDue = resolved.map((s) => s.due).filter(Boolean).sort().pop() || '';
    const data = {
      supplier: sup, manager: $('o-manager').value.trim(), status: $('o-status').value,
      invoice: $('o-invoice').value.trim(), date: $('o-date').value, official: r2(a), actual: r2(b),
      ship: $('o-ship').value, shipFact: $('o-shipfact').value, payDate: lastDue, schedule,
      comment: $('o-comment').value.trim(), updatedAt: new Date().toISOString(),
    };
    const btn = $('btn-order-save');
    btn.disabled = true;
    try {
      if (editId) {
        await Store.updateOrder(editId, data);
        A().toast('Заказ сохранён', 'ok');
      } else {
        data.num = orders.reduce((m, x) => Math.max(m, Number(x.num) || 0), 0) + 1;
        data.createdBy = A().getUser().displayName || A().getUser().email || '';
        await Store.addOrder(data);
        A().toast(`Заказ №${data.num} создан`, 'ok');
      }
      if (A().isAdmin() && $('o-terms-save').checked) {
        try { await Store.saveSettings({ payTerms: { [supKey(sup)]: schedule.map((s) => { const c = clone(s); if (c.base === 'date') { c.base = 'order'; c.days = 0; delete c.date; } return c; }) } }); }
        catch (e) { A().toast('Заказ сохранён, но условия поставщика не запомнились: ' + A().errText(e), 'err'); }
      }
      document.getElementById('modal-order').classList.remove('open');
    } catch (e) {
      err.textContent = 'Не удалось сохранить: ' + A().errText(e);
    } finally { btn.disabled = false; }
  }
  async function deleteOrder() {
    const o = orders.find((x) => x.id === editId);
    if (!o || !confirm(`Удалить заказ №${o.num} вместе со всеми его оплатами?`)) return;
    try {
      await Store.deleteOrder(o.id);
      document.getElementById('modal-order').classList.remove('open');
      A().toast('Заказ удалён', 'ok');
    } catch (e) { A().toast('Не удалось удалить: ' + A().errText(e), 'err'); }
  }

  // ---------- окно оплаты ----------
  function showPay(id, stageIdx) {
    payId = id;
    const o = orders.find((x) => x.id === id);
    if (!o) return;
    const c = calc(o);
    const st = stageIdx != null ? c.sched[stageIdx] : c.next;
    payStageIdx = st ? c.sched.indexOf(st) : null;
    $('opay-title').textContent = `Оплата по заказу №${o.num}`;
    $('opay-sub').textContent = o.supplier + (o.invoice ? ', счёт ' + o.invoice : '');
    $('opay-info').innerHTML = (st ? `Этап: <b>${esc(st.label || '')}</b>${st.due ? ' до ' + dRu(st.due) : ''} — к оплате <b>${fmt(st.rest)}</b><br>` : '') +
      `Остаток безнал: <b>${fmt(c.remBank)}</b> · Остаток нал: <b>${fmt(c.remCash)}</b>`;
    $('opay-type').value = c.remBank > 0 ? 'bank' : 'cash';
    $('opay-date').value = A().todayStr();
    $('opay-note').value = st ? st.label || '' : '';
    $('opay-err').textContent = '';
    fillAmount();
    document.getElementById('modal-opay').classList.add('open');
  }
  function fillAmount() {
    const o = orders.find((x) => x.id === payId);
    if (!o) return;
    const c = calc(o);
    const typeRest = $('opay-type').value === 'bank' ? c.remBank : c.remCash;
    const st = payStageIdx != null ? c.sched[payStageIdx] : null;
    const v = st && st.rest > 0 ? Math.min(st.rest, typeRest > 0 ? typeRest : st.rest) : typeRest;
    $('opay-amount').value = v > 0 ? fmt(v) : '';
  }
  async function savePay() {
    const v = num($('opay-amount').value);
    const err = $('opay-err');
    if (isNaN(v) || v <= 0) { err.textContent = 'Введите сумму больше нуля'; return; }
    if (!$('opay-date').value) { err.textContent = 'Укажите дату оплаты'; return; }
    const pay = {
      id: uid(), type: $('opay-type').value, amount: r2(v), date: $('opay-date').value,
      note: $('opay-note').value.trim(), by: A().getUser().displayName || '',
    };
    const btn = $('btn-opay-save');
    btn.disabled = true;
    try {
      await Store.addOrderPayment(payId, pay);
      open.add(payId);
      document.getElementById('modal-opay').classList.remove('open');
      render();
      A().toast('Оплата сохранена', 'ok');
    } catch (e) { err.textContent = 'Не удалось сохранить: ' + A().errText(e); }
    finally { btn.disabled = false; }
  }
  async function deletePay(orderId, pid) {
    const o = orders.find((x) => x.id === orderId);
    const p = o && (o.payments || []).find((x) => x.id === pid);
    if (!p || !confirm(`Удалить оплату ${fmt(p.amount)} от ${dRu(p.date)}?`)) return;
    try { await Store.removeOrderPayment(orderId, p); A().toast('Оплата удалена', 'ok'); }
    catch (e) { A().toast('Не удалось удалить: ' + A().errText(e), 'err'); }
  }

  // ---------- выгрузка в Excel ----------
  function exportCsv() {
    const n = (x) => String(r2(x)).replace('.', ',');
    const head = ['№', 'Поставщик', 'Менеджер', 'Счёт №', 'Дата', 'Официальная стоимость', 'Фактическая стоимость', 'Безнал оплачено', 'Нал оплачено', 'Остаток безнал', 'Остаток нал', 'Итого к оплате', 'Следующий платёж (дата)', 'Следующий платёж (сумма)', 'Просрочено', 'Условия оплаты', 'Дата отгрузки (план)', 'Дата отгрузки (факт)', 'Статус заказа', 'Статус оплаты', 'Комментарий'];
    const rows = orders.slice().sort((a, b) => (a.num || 0) - (b.num || 0)).map((o) => {
      const c = calc(o);
      const terms = c.sched.map((s) => `${s.label}: ${fmt(s.amount)} ${whenText(s)}`).join('; ');
      return [o.num, o.supplier, o.manager, o.invoice, dRu(o.date), n(o.official), n(o.actual), n(c.bank), n(c.cash), n(c.remBank), n(c.remCash), n(c.remTotal),
        c.next && c.next.due ? dRu(c.next.due) : '', c.next ? n(c.next.rest) : '', n(c.overdueSum), terms, dRu(o.ship), dRu(o.shipFact), o.status, PAY_PILL[c.pay][0], o.comment];
    });
    const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `postavki_${A().todayStr()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- события (один раз) ----------
  function bindOnce() {
    if (bound) return;
    bound = true;
    $('btn-order-new').addEventListener('click', () => showOrder(null));
    $('btn-order-save').addEventListener('click', saveOrder);
    $('btn-order-delete').addEventListener('click', deleteOrder);
    ['o-official', 'o-actual'].forEach((i) => $(i).addEventListener('input', () => { orderCalc(); updateStagePreview(); $('o-err').textContent = ''; }));
    ['o-date', 'o-ship', 'o-shipfact'].forEach((i) => $(i).addEventListener('input', updateStagePreview));
    $('o-supplier').addEventListener('input', () => {
      $('o-err').textContent = '';
      fillPresetSelect();
      if (!stagesTouched && !editId) {
        const t = termsFor($('o-supplier').value);
        if (t) applyTerms(t);
      }
    });
    $('o-terms-preset').addEventListener('change', (e) => {
      const v = e.target.value;
      if (v === 'own') applyTerms(termsFor($('o-supplier').value) || []);
      else if (v !== '') applyTerms(PRESETS[Number(v)].stages);
      stagesTouched = true;
      e.target.value = '';
    });
    $('btn-stage-add').addEventListener('click', () => {
      stages.push({ label: '', kind: stages.some((s) => s.kind === 'rest') ? 'pct' : 'rest', base: 'ship', days: 0 });
      stagesTouched = true;
      renderStages();
    });
    $('o-stages').addEventListener('input', (e) => { if (e.target.tagName !== 'SELECT') readStageInput(e); });
    $('o-stages').addEventListener('change', (e) => { if (e.target.tagName === 'SELECT' || e.target.type === 'date') readStageInput(e); });
    $('o-stages').addEventListener('click', (e) => {
      const d = e.target.closest('[data-del]');
      if (!d) return;
      stages.splice(Number(d.getAttribute('data-del')), 1);
      stagesTouched = true;
      renderStages();
    });
    $('opay-type').addEventListener('change', fillAmount);
    $('opay-amount').addEventListener('input', () => { $('opay-err').textContent = ''; });
    $('btn-opay-save').addEventListener('click', savePay);
    $('btn-orders-csv').addEventListener('click', exportCsv);
    ['of-search', 'of-supplier', 'of-status', 'of-pay'].forEach((i) => $(i).addEventListener('input', render));
    $('orders-plan-body').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act="paystage"]');
      if (b) showPay(b.getAttribute('data-id'), Number(b.getAttribute('data-idx')));
    });
    $('orders-body').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) {
        e.stopPropagation();
        const act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
        if (act === 'pay') showPay(id);
        else if (act === 'edit') showOrder(id);
        else if (act === 'delpay') deletePay(id, b.getAttribute('data-pid'));
        return;
      }
      const tr = e.target.closest('tr.o-row');
      if (tr) {
        const id = tr.getAttribute('data-id');
        if (open.has(id)) open.delete(id); else open.add(id);
        render();
      }
    });
  }

  window.Orders = { mount, unmount, render };
})();
