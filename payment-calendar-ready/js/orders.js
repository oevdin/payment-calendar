/* =========================================================
   orders.js — раздел «Поставки» (заказы поставщикам)
   Данные: коллекция Firestore «orders». Каждый заказ хранит
   свои оплаты (безнал / нал) внутри себя в поле payments.
   Права: админ — всё; менеджер — создаёт и правит заказы,
   но не отмечает оплаты; просмотр — только смотрит.
   ========================================================= */
(function () {
  'use strict';

  const STATUSES = ['Новый', 'В процессе', 'Отгружен', 'Оприходован', 'Завершён'];
  const PAY_PILL = {
    paid: ['Оплачен', 'pill-ok'], over: ['Переплата', 'pill-info'], overdue: ['Просрочен', 'pill-bad'],
    partial: ['Частично', 'pill-acc'], none: ['Не оплачен', 'pill-warn'],
  };
  const ST_PILL = { 'Новый': 'pill-warn', 'В процессе': 'pill-acc', 'Отгружен': 'pill-info', 'Оприходован': 'pill-info', 'Завершён': 'pill-ok' };

  let orders = [];
  let unsub = null;
  let bound = false;
  const open = new Set();
  let editId = null;
  let payId = null;

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

  function calc(o) {
    const pays = o.payments || [];
    const bank = pays.filter((p) => p.type === 'bank').reduce((a, p) => a + Number(p.amount || 0), 0);
    const cash = pays.filter((p) => p.type === 'cash').reduce((a, p) => a + Number(p.amount || 0), 0);
    const official = Number(o.official || 0), actual = Number(o.actual || 0);
    const cashPart = actual - official;
    const remBank = r2(official - bank), remCash = r2(cashPart - cash), remTotal = r2(actual - bank - cash);
    let pay;
    if (remTotal < 0) pay = 'over';
    else if (remTotal === 0) pay = 'paid';
    else if (o.payDate && o.payDate < A().todayStr()) pay = 'overdue';
    else if (bank + cash > 0) pay = 'partial';
    else pay = 'none';
    return { bank, cash, cashPart, remBank, remCash, remTotal, pay };
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
    const today = A().todayStr();
    const wk = new Date(Date.now() + 7 * 864e5);
    const wkStr = `${wk.getFullYear()}-${String(wk.getMonth() + 1).padStart(2, '0')}-${String(wk.getDate()).padStart(2, '0')}`;

    // поставщики для фильтра и подсказок
    const sups = [...new Set(orders.map((o) => o.supplier).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    const fs = $('of-supplier'), curSup = fs.value;
    fs.innerHTML = '<option value="">Все поставщики</option>' + sups.map((s) => `<option${s === curSup ? ' selected' : ''}>${esc(s)}</option>`).join('');
    const hints = [...new Set(sups.concat(A().contragentNames()))];
    $('o-sup-list').innerHTML = hints.map((s) => `<option value="${esc(s)}">`).join('');

    // карточки
    let dBank = 0, dCash = 0, overdue = 0, week = 0, active = 0;
    orders.forEach((o) => {
      const c = calc(o);
      if (c.remBank > 0) dBank += c.remBank;
      if (c.remCash > 0) dCash += c.remCash;
      if (c.pay === 'overdue') overdue += c.remTotal;
      if (c.remTotal > 0 && o.payDate && o.payDate >= today && o.payDate <= wkStr) week += c.remTotal;
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
      const c = calc(o);
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
        const c = calc(o), pp = PAY_PILL[c.pay];
        let h = `<tr class="o-row" data-id="${o.id}">
          <td><span class="o-num">№${esc(o.num)}</span> ${esc(o.supplier)}<div class="o-sub">${esc(o.manager || '—')}${o.ship ? ' · отгр. ' + dRu(o.ship) : ''}</div></td>
          <td>${o.invoice ? 'счёт ' + esc(o.invoice) : '<span class="o-sub">без счёта</span>'}<div class="o-sub">${dRu(o.date)}</div></td>
          <td class="n">${fmt(o.official)}</td>
          <td class="n">${fmt(o.actual)}<div class="o-sub">нал часть ${fmt(c.cashPart)}</div></td>
          <td class="n">${fmt(c.bank)}</td>
          <td class="n">${fmt(c.cash)}</td>
          <td class="n">${remCell(c.remBank)}</td>
          <td class="n">${remCell(c.remCash)}</td>
          <td class="n"><b>${remCell(c.remTotal)}</b></td>
          <td>${dRu(o.payDate)}</td>
          <td><span class="pill ${ST_PILL[o.status] || 'pill-warn'}">${esc(o.status || '—')}</span><br><span class="pill ${pp[1]}">${pp[0]}</span></td>
          <td><div class="o-btns">
            ${canPay() ? `<button type="button" class="btn btn-sm btn-primary" data-act="pay" data-id="${o.id}">Оплата</button>` : ''}
            ${canEdit() ? `<button type="button" class="btn btn-sm" data-act="edit" data-id="${o.id}">Изменить</button>` : ''}
          </div></td></tr>`;
        if (open.has(o.id)) {
          const pays = (o.payments || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
          h += `<tr class="o-pays"><td colspan="12"><b>Платежи по заказу №${esc(o.num)}</b>${o.comment ? ` · <span class="o-sub">${esc(o.comment)}</span>` : ''}
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

    // долг по поставщикам
    const agg = {};
    orders.forEach((o) => {
      const c = calc(o);
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
    $('o-paydate').value = o ? o.payDate || '' : '';
    $('o-comment').value = o ? o.comment || '' : '';
    $('btn-order-delete').style.visibility = o && A().isAdmin() ? 'visible' : 'hidden';
    $('o-err').textContent = '';
    orderCalc();
    document.getElementById('modal-order').classList.add('open');
  }
  function orderCalc() {
    const a = num($('o-official').value), b = num($('o-actual').value);
    $('o-calc').innerHTML = (!isNaN(a) && !isNaN(b))
      ? `Безнал к оплате: <b>${fmt(a)}</b> · Нал к оплате: <b>${fmt(b - a)}</b> · Всего: <b>${fmt(b)}</b>`
      : 'Введите официальную и фактическую стоимость — нал посчитается сам.';
  }
  async function saveOrder() {
    const err = $('o-err');
    const sup = $('o-supplier').value.trim(), a = num($('o-official').value), b = num($('o-actual').value);
    if (!sup) { err.textContent = 'Укажите поставщика'; return; }
    if (isNaN(a) || a < 0) { err.textContent = 'Введите официальную стоимость числом'; return; }
    if (isNaN(b) || b < 0) { err.textContent = 'Введите фактическую стоимость числом'; return; }
    if (b < a) { err.textContent = 'Фактическая стоимость не может быть меньше официальной'; return; }
    const data = {
      supplier: sup, manager: $('o-manager').value.trim(), status: $('o-status').value,
      invoice: $('o-invoice').value.trim(), date: $('o-date').value, official: r2(a), actual: r2(b),
      ship: $('o-ship').value, payDate: $('o-paydate').value, comment: $('o-comment').value.trim(),
      updatedAt: new Date().toISOString(),
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
  function showPay(id) {
    payId = id;
    const o = orders.find((x) => x.id === id);
    if (!o) return;
    const c = calc(o);
    $('opay-title').textContent = `Оплата по заказу №${o.num}`;
    $('opay-sub').textContent = o.supplier + (o.invoice ? ', счёт ' + o.invoice : '');
    $('opay-info').innerHTML = `Остаток безнал: <b>${fmt(c.remBank)}</b> · Остаток нал: <b>${fmt(c.remCash)}</b>`;
    $('opay-type').value = c.remBank > 0 ? 'bank' : 'cash';
    $('opay-date').value = A().todayStr();
    $('opay-note').value = '';
    $('opay-err').textContent = '';
    fillAmount();
    document.getElementById('modal-opay').classList.add('open');
  }
  function fillAmount() {
    const o = orders.find((x) => x.id === payId);
    if (!o) return;
    const c = calc(o);
    const v = $('opay-type').value === 'bank' ? c.remBank : c.remCash;
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
    const head = ['№', 'Поставщик', 'Менеджер', 'Счёт №', 'Дата', 'Официальная стоимость', 'Фактическая стоимость', 'Безнал оплачено', 'Нал оплачено', 'Остаток безнал', 'Остаток нал', 'Итого к оплате', 'Срок оплаты', 'Дата отгрузки', 'Статус заказа', 'Статус оплаты', 'Комментарий'];
    const rows = orders.slice().sort((a, b) => (a.num || 0) - (b.num || 0)).map((o) => {
      const c = calc(o);
      return [o.num, o.supplier, o.manager, o.invoice, dRu(o.date), n(o.official), n(o.actual), n(c.bank), n(c.cash), n(c.remBank), n(c.remCash), n(c.remTotal), dRu(o.payDate), dRu(o.ship), o.status, PAY_PILL[c.pay][0], o.comment];
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
    ['o-official', 'o-actual'].forEach((i) => $(i).addEventListener('input', () => { orderCalc(); $('o-err').textContent = ''; }));
    $('o-supplier').addEventListener('input', () => { $('o-err').textContent = ''; });
    $('opay-type').addEventListener('change', fillAmount);
    $('opay-amount').addEventListener('input', () => { $('opay-err').textContent = ''; });
    $('btn-opay-save').addEventListener('click', savePay);
    $('btn-orders-csv').addEventListener('click', exportCsv);
    ['of-search', 'of-supplier', 'of-status', 'of-pay'].forEach((i) => $(i).addEventListener('input', render));
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
