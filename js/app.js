// UI: вкладки, состояние в localStorage, связь DOM с формулами из core.js.
(function () {
  'use strict';
  const C = window.Core;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (x, d = 2) => (Number.isFinite(x) ? (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('ru-RU') : '∞');
  // Число для TeX: запятая как десятичный разделитель, в фигурных скобках, чтобы KaTeX не ставил после неё пробел.
  const tn = (x, d = 3) => (Number.isFinite(x) ? String(Math.round(x * 10 ** d) / 10 ** d).replace('.', '{,}') : '\\infty');
  const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };

  // ---------- Формулы ----------
  function tex(el, src) {
    src = src ?? el.dataset.tex;
    if (!window.katex) { el.textContent = el.textContent || src; return; } // без CDN остаётся текстовая версия
    try { katex.render('\\displaystyle ' + src, el, { throwOnError: false, displayMode: false }); } catch (e) { el.textContent = src; }
  }
  const texHTML = (src) => {
    if (!window.katex) return `<code>${esc(src)}</code>`;
    try { return katex.renderToString(src, { throwOnError: false }); } catch (e) { return `<code>${esc(src)}</code>`; }
  };
  $$('.tex[data-tex]').forEach((el) => tex(el));

  // ---------- Состояние ----------
  const KEY = 'bps.state.v1';
  const DEFAULTS = {
    units: [], loot: [], skills: null,
    headers: { units: C.SCHEMAS.units.required.slice(), loot: ['id', 'group', 'item', 'rarity', 'chance'] },
    progression: { base: 100, power: 1.5, linear: 0, maxLevel: 20 },
    ttk: { attacker: null, target: null, minRatio: 0.1, mult: 1, own: true, cc: 0, cm: 1.5, aps: 1 },
    economy: {
      start: 1000, steps: 30,
      sources: [{ name: 'Квесты', amount: 300, growth: 3 }, { name: 'Дроп с мобов', amount: 150, growth: 2 }],
      sinks: [{ name: 'Ремонт', amount: 200, growth: 2 }, { name: 'Магазин', amount: 180, growth: 4 }],
    },
    tab: 'import', tableKind: 'units',
  };
  let state = load();

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && typeof s === 'object') return deepMerge(structuredClone(DEFAULTS), s);
    } catch (e) { /* пустое или битое хранилище — стартуем с дефолтов */ }
    return structuredClone(DEFAULTS);
  }
  function deepMerge(base, over) {
    Object.keys(over).forEach((k) => {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) deepMerge(base[k], over[k]);
      else base[k] = over[k];
    });
    return base;
  }
  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
        $('#save-status').textContent = 'Сохранено в ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch (e) {
        $('#save-status').textContent = 'Не сохранилось: ' + e.message;
        toast('Браузер не даёт писать в localStorage. После перезагрузки правки пропадут.');
      }
    }, 300);
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'text/plain;charset=utf-8' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const downloadCSV = (name, rows, headers) => download(name, '﻿' + C.toCSV(rows, headers), 'text/csv;charset=utf-8');
  const downloadJSON = (name, obj) => download(name, JSON.stringify(obj, null, 2), 'application/json');

  // Юниты, пригодные для расчётов (числовые статы, hp > 0).
  function validUnits() {
    return state.units.filter((u) => ['hp', 'attack', 'defense', 'cost'].every((k) => typeof u[k] === 'number' && Number.isFinite(u[k])) && u.hp > 0);
  }

  // ---------- Вкладки ----------
  const renderers = {};
  function moveInk() {
    const on = $('.tabs button.on'), ink = $('.tabs-ink');
    if (!on || !ink) return;
    ink.style.transform = `translateY(${on.offsetTop}px)`;
    ink.style.height = on.offsetHeight + 'px';
  }
  function showTab(name) {
    if (!$('#tab-' + name)) name = 'import';
    state.tab = name; save();
    $$('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
    $$('.tabs button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === name); b.setAttribute('aria-selected', b.dataset.tab === name); });
    const btn = $(`.tabs button[data-tab="${name}"]`);
    btn && btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    moveInk();
    renderers[name] && renderers[name]();
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  window.addEventListener('resize', moveInk);

  // ---------- Графики ----------
  const charts = {};
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function chart(id, config) {
    if (!window.Chart) { $('#' + id).replaceWith(Object.assign(document.createElement('p'), { className: 'muted small', textContent: 'График не загрузился (нет интернета). Те же числа есть в таблице.' })); return; }
    charts[id] && charts[id].destroy();
    Chart.defaults.color = css('--muted');
    Chart.defaults.borderColor = css('--rule');
    Chart.defaults.font.family = css('--mono');
    Chart.defaults.font.size = 11;
    Chart.defaults.font.weight = 300;
    charts[id] = new Chart($('#' + id), Object.assign({ options: {} }, config, {
      options: Object.assign({
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { boxWidth: 10, boxHeight: 10 } }, tooltip: { cornerRadius: 0, backgroundColor: css('--ink'), titleColor: css('--bg'), bodyColor: css('--bg') } },
      }, config.options),
    }));
  }

  // ================= 01 Импорт =================
  const dz = $('#dropzone'), fileInput = $('#file-input');
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
  // Файл, брошенный мимо зоны, иначе браузер откроет вместо приложения.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); if (e.target.closest && !e.target.closest('#dropzone')) { showTab('import'); handleFiles(e.dataTransfer.files); } });
  fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });
  $$('[data-sample]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await fetch('data/' + b.dataset.sample);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      importText(b.dataset.sample, await r.text());
    } catch (e) {
      report([{ cls: 'err', title: `Не получилось открыть ${b.dataset.sample}`, items: [`${e.message}. Если страница открыта как файл (file://), браузер не пускает к соседним файлам. Перетащите его из папки data вручную.`] }]);
    }
  }));

  async function handleFiles(files) {
    for (const f of files) {
      if (f.size > 5 * 1024 * 1024) { report([{ cls: 'err', title: f.name, items: ['Файл больше 5 МБ, такой не возьму.'] }]); continue; }
      importText(f.name, await f.text());
    }
  }

  function detectType(name, parsed, isJSON) {
    const forced = $('#import-type').value;
    if (forced !== 'auto') return forced;
    if (isJSON && parsed && !Array.isArray(parsed)) {
      if (parsed.app === 'balance-studio') return 'project';
      if (Array.isArray(parsed.nodes)) return 'skills';
      if (Array.isArray(parsed.loot)) return 'loot';
      if (Array.isArray(parsed.units)) return 'units';
    }
    const headers = isJSON ? C.collectHeaders(Array.isArray(parsed) ? parsed : []) : parsed.headers;
    if (headers.includes('requires')) return 'skills';
    return headers.includes('chance') ? 'loot' : 'units';
  }

  const errItem = (e) => ({ line: e.line, col: e.col, msg: e.msg });
  let pending = null; // валидные строки файла с ошибками, если пользователь решит импортировать частично
  function importText(name, text) {
    pending = null;
    const isJSON = /\.json$/i.test(name) || /^\s*[[{]/.test(text);
    let parsed, type;
    try {
      parsed = isJSON ? JSON.parse(text.replace(/^﻿/, '')) : C.parseCSV(text);
      type = detectType(name, parsed, isJSON);
    } catch (e) {
      return report([{ cls: 'err', title: `${name} не читается`, items: [e.message] }]);
    }
    try {
      if (type === 'project') return importProject(name, parsed);
      if (type === 'skills') {
        const t = C.layoutSkillTree(parsed);
        state.skills = Array.isArray(parsed) ? { nodes: parsed } : parsed; save();
        return report([{ cls: t.errors.length ? 'warn' : 'ok', title: `${name}: дерево из ${t.byId.size} навыков`, items: t.errors }], 'skills');
      }
      const table = isJSON ? C.parseJSON(text, type) : parsed;
      const append = $('#import-mode').value === 'append';
      const existing = append ? state[type] : [];
      const all = existing.map((r, i) => Object.assign({}, r, { __line: 'старая ' + (i + 1) })).concat(table.rows);
      const headers = mergeHeaders(append ? state.headers[type] : [], table.headers);
      const v = C.validate(all, type, headers);
      const msgs = [];
      if (v.warnings.length) msgs.push({ cls: 'warn', title: 'Обратите внимание', items: v.warnings.map(errItem) });
      if (!v.ok) {
        const badLines = new Set(v.errors.map((e) => e.line));
        const good = v.rows.filter((_, i) => !badLines.has(all[i].__line));
        pending = { type, headers, rows: good };
        const n = v.errors.length;
        msgs.unshift({ cls: 'err', title: `${name} не загружен: ${n} ${plural(n, 'ошибка', 'ошибки', 'ошибок')}`, items: v.errors.map(errItem), partial: good.length && !append ? good.length : 0 });
        return report(msgs);
      }
      commit(type, headers, v.rows);
      const n = table.rows.length;
      msgs.unshift({ cls: 'ok', title: `${name}: ${n} ${plural(n, 'строка', 'строки', 'строк')}, ${type === 'units' ? 'юниты' : 'лут'}${append ? `, теперь всего ${v.rows.length}` : ''}`, items: [] });
      report(msgs, 'table');
    } catch (e) {
      report([{ cls: 'err', title: `${name} не загружен`, items: [e.message] }]);
    }
  }
  function mergeHeaders(a, b) { const out = a.slice(); b.forEach((h) => { if (!out.includes(h)) out.push(h); }); return out; }
  function commit(type, headers, rows) {
    state[type] = rows;
    state.headers[type] = headers;
    state.tableKind = type;
    save();
  }
  function importProject(name, p) {
    ['units', 'loot'].forEach((t) => {
      if (!Array.isArray(p[t])) return;
      const v = C.validate(p[t], t, p.headers && p.headers[t]);
      if (!v.ok) throw new Error(`${t}: ${v.errors.slice(0, 3).map((e) => e.msg).join('; ')}`);
    });
    state = deepMerge(structuredClone(DEFAULTS), Object.assign({}, p, { app: undefined, version: undefined }));
    delete state.app; delete state.version;
    save();
    report([{ cls: 'ok', title: `Проект из ${name} восстановлен: ${state.units.length} юнитов, ${state.loot.length} строк лута`, items: [] }]);
  }
  function report(msgs, gotoTab) {
    const li = (x) => (typeof x === 'string' ? `<li>${esc(x)}</li>`
      : `<li><code>стр. ${esc(x.line)}${x.col ? ' · ' + esc(x.col) : ''}</code>${esc(x.msg)}</li>`);
    $('#import-report').innerHTML = msgs.map((m, i) => `<div class="msg ${m.cls}"><b>${esc(m.title)}</b>
      ${m.items.length ? `<ul>${m.items.map(li).join('')}</ul>` : ''}
      ${m.partial ? `<div class="row"><button data-partial>загрузить только целые строки (${m.partial})</button></div>` : ''}
      ${!i && gotoTab ? `<div class="row"><button data-goto="${gotoTab}">открыть</button></div>` : ''}</div>`).join('');
    const p = $('[data-partial]');
    p && p.addEventListener('click', () => { commit(pending.type, pending.headers, pending.rows); toast(`Загружено строк: ${pending.rows.length}`); showTab('table'); });
    const g = $('[data-goto]');
    g && g.addEventListener('click', () => showTab(g.dataset.goto));
  }

  $('#btn-export-project').addEventListener('click', exportProject);
  function exportProject() {
    downloadJSON('balance-project.json', Object.assign({ app: 'balance-studio', version: 1 }, state));
    toast('Скачан balance-project.json');
  }

  // ================= 02 Таблица =================
  $$('#table-kind button').forEach((b) => b.addEventListener('click', () => { state.tableKind = b.dataset.kind; save(); renderTable(); }));
  $('#table-filter').addEventListener('input', renderTable);
  $('#btn-add-row').addEventListener('click', addRow);
  function addRow() {
    const k = state.tableKind, rows = state[k];
    const ids = rows.map((r) => Number(r.id)).filter(Number.isFinite);
    const row = {};
    state.headers[k].forEach((h) => { row[h] = ''; });
    row.id = ids.length ? Math.max(...ids) + 1 : 1;
    if (k === 'units') Object.assign(row, { name: 'Новый юнит', hp: 100, attack: 10, defense: 0, cost: 100 });
    else Object.assign(row, { item: 'Новый предмет', chance: 0 });
    rows.push(row); save(); renderTable();
    const inputs = $$('#editor tbody tr:last-child input');
    inputs[1] && inputs[1].focus();
  }
  $('#btn-add-col').addEventListener('click', () => {
    const name = (prompt('Как назвать колонку? Латиницей, например crit_chance') || '').trim();
    if (!name) return;
    if (!/^[A-Za-z_][\w]*$/.test(name)) return toast('В названии только латиница, цифры и _');
    const k = state.tableKind;
    if (state.headers[k].includes(name)) return toast('Такая колонка уже есть');
    state.headers[k].push(name); save(); renderTable();
  });
  $('#btn-clear').addEventListener('click', () => {
    if (!confirm('Стереть все строки? Вернуть не получится, так что сначала лучше скачать csv.')) return;
    state[state.tableKind] = []; save(); renderTable();
  });
  $('#btn-export-csv').addEventListener('click', () => downloadCSV(state.tableKind + '.csv', state[state.tableKind], state.headers[state.tableKind]));
  $('#btn-export-json').addEventListener('click', () => downloadJSON(state.tableKind + '.json', { [state.tableKind]: state[state.tableKind] }));

  function tableErrors() {
    const k = state.tableKind;
    const v = C.validate(state[k], k, state.headers[k]);
    const map = new Map();
    v.errors.forEach((e) => map.set(e.line + ':' + (e.col || ''), e.msg));
    return { v, map };
  }
  function renderTable() {
    const k = state.tableKind, rows = state[k], headers = state.headers[k];
    $$('#table-kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === k));
    const q = $('#table-filter').value.trim().toLowerCase();
    const numeric = C.SCHEMAS[k].numeric;
    const { v, map } = tableErrors();
    const n = v.errors.length;
    $('#table-errors').innerHTML = rows.length && !v.ok
      ? `<div class="msg err"><b>${n} ${plural(n, 'ошибка', 'ошибки', 'ошибок')}. Пока не исправите, эти строки не участвуют в расчётах.</b><ul>${v.errors.slice(0, 50).map((e) => `<li><code>стр. ${e.line}${e.col ? ' · ' + esc(e.col) : ''}</code>${esc(e.msg)}</li>`).join('')}</ul></div>`
      : rows.length ? '' : '<div class="msg warn">Пусто. Загрузите файл во вкладке «импорт» или добавьте строку.</div>';
    const head = `<thead><tr>${headers.map((h) => `<th class="${numeric.includes(h) ? 'num' : ''}">${esc(h)}${C.SCHEMAS[k].required.includes(h) ? '' : ` <button class="del" data-delcol="${esc(h)}" title="Удалить колонку">×</button>`}</th>`).join('')}<th></th></tr></thead>`;
    const body = rows.map((r, i) => {
      if (q && !headers.some((h) => String(r[h] ?? '').toLowerCase().includes(q))) return '';
      const line = i + 1;
      return `<tr data-i="${i}">${headers.map((h) => {
        const err = map.get(line + ':' + h);
        return `<td class="${err ? 'bad' : ''}"${err ? ` title="${esc(err)}"` : ''}><input data-col="${esc(h)}" value="${esc(r[h])}" ${numeric.includes(h) ? 'inputmode="decimal" style="text-align:right;font-family:var(--mono)"' : ''} aria-label="${esc(h)}, строка ${line}"></td>`;
      }).join('')}<td><button class="del" data-del="${i}" title="Удалить строку" aria-label="Удалить строку ${line}">✕</button></td></tr>`;
    }).join('');
    $('#editor').innerHTML = head + `<tbody>${body}</tbody>`;
  }
  $('#editor').addEventListener('change', (e) => {
    const inp = e.target.closest('input[data-col]');
    if (!inp) return;
    const k = state.tableKind, i = +inp.closest('tr').dataset.i, col = inp.dataset.col;
    const raw = inp.value.trim();
    state[k][i][col] = (C.SCHEMAS[k].numeric.includes(col) || col === 'id') && C.isNumeric(raw) ? C.toNumber(raw) : raw;
    save(); renderTable();
  });
  $('#editor').addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]');
    if (d) { state[state.tableKind].splice(+d.dataset.del, 1); save(); renderTable(); return; }
    const c = e.target.closest('[data-delcol]');
    if (c && confirm(`Удалить колонку ${c.dataset.delcol} вместе со значениями?`)) {
      const k = state.tableKind, col = c.dataset.delcol;
      state.headers[k] = state.headers[k].filter((h) => h !== col);
      state[k].forEach((r) => delete r[col]);
      save(); renderTable();
    }
  });
  renderers.table = renderTable;

  // ================= 03 TTK =================
  const ttkInputs = { minRatio: '#ttk-minratio', mult: '#ttk-mult', cc: '#ttk-cc', cm: '#ttk-cm', aps: '#ttk-aps' };
  function ttkOpts() {
    const t = state.ttk;
    const o = { minRatio: t.minRatio, multiplier: t.mult };
    if (!t.own) Object.assign(o, { critChance: t.cc, critMult: t.cm, attackSpeed: t.aps });
    return o;
  }
  function renderTTK() {
    const units = validUnits(), t = state.ttk;
    Object.entries(ttkInputs).forEach(([k, s]) => { $(s).value = t[k]; });
    $('#ttk-own-crit').checked = t.own;
    $('#ttk-override').style.display = t.own ? 'none' : '';
    if (units.length < 2) {
      $('#ttk-result').innerHTML = '<div class="msg warn">Нужны хотя бы два юнита без ошибок. Загрузите <code>units.csv</code>.</div>';
      $('#ttk-matrix').innerHTML = '';
      return;
    }
    const opt = (sel) => units.map((u) => `<option value="${esc(u.id)}" ${String(u.id) === String(sel) ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
    if (!units.some((u) => String(u.id) === String(t.attacker))) t.attacker = units[0].id;
    if (!units.some((u) => String(u.id) === String(t.target))) t.target = units[1].id;
    $('#ttk-attacker').innerHTML = opt(t.attacker);
    $('#ttk-target').innerHTML = opt(t.target);
    const A = units.find((u) => String(u.id) === String(t.attacker)), T = units.find((u) => String(u.id) === String(t.target));
    const o = ttkOpts();
    const r = C.ttk(A, T, o), back = C.ttk(T, A, o);
    const d = r.damage;
    const verdict = r.ttk.expected < back.ttk.expected ? `${esc(A.name)} выигрывает дуэль` : r.ttk.expected > back.ttk.expected ? `${esc(T.name)} выигрывает дуэль` : 'Ничья: убивают друг друга за одно время';
    const lines = [
      `\\text{урон} = \\max(${A.attack} - ${T.defense},\\; ${A.attack} \\cdot ${tn(o.minRatio)}) \\cdot ${tn(o.multiplier)} = \\mathbf{${tn(d.base)}}`,
      `\\text{ожид.} = ${tn(d.base)} \\cdot (1 + ${tn(d.critChance)} \\cdot (${tn(d.critMult)} - 1)) = \\mathbf{${tn(d.expected)}}`,
      `n = \\left\\lceil \\dfrac{${T.hp}}{${tn(d.expected)}} \\right\\rceil = \\mathbf{${r.hits.expected}}, \\quad \\text{без критов } \\left\\lceil \\dfrac{${T.hp}}{${tn(d.base)}} \\right\\rceil = ${r.hits.worst}`,
      `TTK = \\dfrac{${r.hits.expected} - 1}{${tn(r.attackSpeed)}} = \\mathbf{${tn(r.ttk.expected, 2)}\\ \\text{с}}`,
    ];
    $('#ttk-result').innerHTML = `
      <div class="stats" style="margin-top:0">
        <div class="stat accent"><b>${fmt(r.ttk.expected)} с</b><span>в среднем</span></div>
        <div class="stat"><b>${fmt(r.ttk.worst)} с</b><span>без критов</span></div>
        <div class="stat"><b>${fmt(r.ttk.best)} с</b><span>все удары в крит</span></div>
      </div>
      <div class="calc">${lines.map((l) => `<div class="tex">${texHTML(l)}</div>`).join('')}</div>
      <p class="verdict">В ответ ${esc(T.name)} убивает за <b>${fmt(back.ttk.expected)} с</b> (${back.hits.expected} уд.). ${verdict}.</p>`;
    // Матрица: насыщенность ячейки по лог-шкале TTK
    const full = units.map((a) => units.map((b) => (a === b ? null : C.ttk(a, b, o))));
    const m = full.map((row) => row.map((x) => x && x.ttk.expected));
    const all = m.flat().filter((x) => x !== null && Number.isFinite(x));
    const lo = Math.log1p(Math.min(...all)), hi = Math.log1p(Math.max(...all));
    $('#ttk-matrix').innerHTML = `<thead><tr><th></th>${units.map((u) => `<th class="num">${esc(u.name)}</th>`).join('')}</tr></thead><tbody>${
      m.map((row, i) => `<tr><th>${esc(units[i].name)}</th>${row.map((x, j) => {
        if (x === null) return '<td class="self">·</td>';
        const k = hi > lo ? (Math.log1p(x) - lo) / (hi - lo) : 0;
        return `<td title="${esc(units[i].name)} против ${esc(units[j].name)}: ${full[i][j].hits.expected} уд." style="background:rgba(var(--heat),${(k * 0.32).toFixed(3)})">${fmt(x, 1)}</td>`;
      }).join('')}</tr>`).join('')}</tbody>`;
  }
  $('#ttk-attacker').addEventListener('change', (e) => { state.ttk.attacker = e.target.value; save(); renderTTK(); });
  $('#ttk-target').addEventListener('change', (e) => { state.ttk.target = e.target.value; save(); renderTTK(); });
  $('#ttk-swap').addEventListener('click', () => { [state.ttk.attacker, state.ttk.target] = [state.ttk.target, state.ttk.attacker]; save(); renderTTK(); });
  $('#ttk-own-crit').addEventListener('change', (e) => { state.ttk.own = e.target.checked; save(); renderTTK(); });
  Object.entries(ttkInputs).forEach(([k, s]) => $(s).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    state.ttk[k] = v; save(); renderTTK();
  }));
  renderers.ttk = renderTTK;

  // ================= 04 Прогрессия =================
  const prInputs = { base: '#pr-base', power: '#pr-power', linear: '#pr-linear', maxLevel: '#pr-max' };
  function prLevels() { return C.progression(state.progression); }
  function renderProgression() {
    Object.entries(prInputs).forEach(([k, s]) => { $(s).value = state.progression[k]; });
    const lv = prLevels();
    $('#pr-table').innerHTML = `<thead><tr><th class="num">ур.</th><th class="num">до следующего</th><th class="num">набрано к уровню</th><th class="num">прирост</th></tr></thead><tbody>${
      lv.map((l, i) => `<tr><td class="num">${l.level}</td><td class="num">${l.xpToNext ? l.xpToNext.toLocaleString('ru-RU') : '—'}</td><td class="num">${l.totalXp.toLocaleString('ru-RU')}</td><td class="num">${i && lv[i - 1].xpToNext && l.xpToNext ? '+' + fmt((l.xpToNext / lv[i - 1].xpToNext - 1) * 100, 1) + '%' : ''}</td></tr>`).join('')}</tbody>`;
    chart('pr-chart', {
      data: {
        labels: lv.map((l) => l.level),
        datasets: [
          { type: 'bar', label: 'опыт до следующего', data: lv.map((l) => l.xpToNext), backgroundColor: css('--faint'), hoverBackgroundColor: css('--ink'), yAxisID: 'y' },
          { type: 'line', label: 'всего набрано', data: lv.map((l) => l.totalXp), borderColor: css('--accent'), backgroundColor: css('--accent'), borderWidth: 2, pointRadius: 0, yAxisID: 'y2', tension: 0.25 },
        ],
      },
      options: { scales: { x: { grid: { display: false }, title: { display: true, text: 'уровень' } }, y: { beginAtZero: true }, y2: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false } } } },
    });
  }
  Object.entries(prInputs).forEach(([k, s]) => $(s).addEventListener('input', (e) => {
    let v = parseFloat(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    if (k === 'maxLevel') { v = Math.round(v); if (v < 2 || v > 200) return; }
    state.progression[k] = v; $('#pr-preset').value = ''; save(); renderProgression();
  }));
  $('#pr-preset').addEventListener('change', (e) => {
    if (!e.target.value) return;
    const [base, power, linear] = e.target.value.split(',').map(Number);
    Object.assign(state.progression, { base, power, linear }); save(); renderProgression();
  });
  $('#pr-export-csv').addEventListener('click', () => downloadCSV('progression.csv', prLevels()));
  $('#pr-export-json').addEventListener('click', () => downloadJSON('progression.json', { params: state.progression, levels: prLevels() }));
  renderers.progression = renderProgression;

  // ================= 05 Лут =================
  let lootSim = null;
  function lootResult() {
    const rows = state.loot.map((r) => Object.assign({}, r, { chance: C.isNumeric(r.chance) ? C.toNumber(r.chance) : r.chance }));
    return { rows, check: C.checkLoot(rows) };
  }
  function renderLoot() {
    if (!state.loot.length) {
      $('#loot-groups').innerHTML = '<div class="msg warn">Таблицы лута пока нет. Загрузите <code>loot.csv</code>.</div>';
      $('#loot-table').innerHTML = '';
      return;
    }
    const { rows, check } = lootResult();
    const bad = check.groups.filter((g) => !g.ok).length;
    $('#loot-groups').innerHTML = `<div class="stats">${
      check.groups.map((g) => `<div class="stat ${g.ok ? '' : 'accent'}"><b>${fmt(g.sum, 4)}%</b><span>${esc(g.group)} · ${g.count} шт. · ${g.ok ? '<span class="tag ok">ок</span>' : `<span class="tag err">${g.diff > 0 ? '+' : ''}${fmt(g.diff, 4)}%</span>`}</span></div>`).join('')}
      <div class="msg ${check.ok ? 'ok' : 'err'}">${check.ok ? 'Все группы сходятся в 100%.' : bad ? `Не сходится ${bad} ${plural(bad, 'группа', 'группы', 'групп')}. Поправьте шансы или нажмите «привести к 100%».` : 'Суммы в порядке, но в отдельных строках есть проблемы, они подсвечены.'}</div></div>`;
    const okGroups = new Set(check.groups.filter((g) => g.ok).map((g) => g.group));
    $('#loot-table').innerHTML = `<thead><tr><th>id</th><th>группа</th><th>предмет</th><th>редкость</th><th class="num">шанс</th><th class="num">сумма группы</th>${lootSim ? '<th class="num">выпало</th>' : ''}<th>статус</th></tr></thead><tbody>${
      rows.map((r, i) => {
        const g = r.group === undefined || r.group === '' ? '—' : String(r.group);
        const issues = check.rowIssues[i];
        const hard = issues.filter((x) => !x.startsWith('нулевая'));
        const groupBad = !okGroups.has(g);
        const cls = hard.length ? 'bad' : issues.length || groupBad ? 'warn' : '';
        const status = issues.length ? issues.join('; ') : groupBad ? 'группа не даёт 100%' : 'ок';
        const gs = check.groups.find((x) => x.group === g);
        return `<tr class="${cls}"><td>${esc(r.id)}</td><td>${esc(g)}</td><td>${esc(r.item)}</td><td class="muted">${esc(r.rarity)}</td><td class="num">${typeof r.chance === 'number' ? fmt(r.chance, 4) + '%' : esc(r.chance)}</td><td class="num">${fmt(gs.sum, 4)}%</td>${lootSim ? `<td class="num">${lootSim[i] === undefined ? '—' : fmt(lootSim[i], 2) + '%'}</td>` : ''}<td class="${status === 'ок' ? 'muted' : ''}">${esc(status)}</td></tr>`;
      }).join('')}</tbody>`;
  }
  function lootExportRows() {
    const { rows, check } = lootResult();
    return rows.map((r, i) => {
      const g = r.group === undefined || r.group === '' ? '—' : String(r.group);
      const gs = check.groups.find((x) => x.group === g);
      return Object.assign({}, r, { group_sum: gs.sum, group_ok: gs.ok, issues: check.rowIssues[i].join('; ') });
    });
  }
  $('#loot-normalize').addEventListener('click', () => {
    const { check } = lootResult();
    if (check.rowIssues.some((x) => x.includes('chance не число'))) return toast('Сначала исправьте шансы, которые не числа (вкладка «таблица»)');
    state.loot = C.normalizeLoot(state.loot); lootSim = null; save(); renderLoot(); toast('Шансы пересчитаны, каждая группа теперь 100%');
  });
  // Монте-Карло: в каждой группе N бросков, сравниваем наблюдаемую частоту с заявленной.
  $('#loot-simulate').addEventListener('click', () => {
    const N = Math.min(1e6, Math.max(100, parseInt($('#loot-rolls').value, 10) || 10000));
    const { rows } = lootResult();
    const groups = new Map();
    rows.forEach((r, i) => { if (typeof r.chance === 'number' && r.chance > 0) { const g = r.group ?? ''; (groups.get(g) || groups.set(g, []).get(g)).push(i); } });
    lootSim = {};
    groups.forEach((idx) => {
      const total = idx.reduce((s, i) => s + rows[i].chance, 0);
      const hits = new Map(idx.map((i) => [i, 0]));
      for (let n = 0; n < N; n++) {
        let x = Math.random() * total;
        for (const i of idx) { x -= rows[i].chance; if (x < 0) { hits.set(i, hits.get(i) + 1); break; } }
      }
      hits.forEach((h, i) => { lootSim[i] = (h / N) * 100; });
    });
    renderLoot(); toast(`Бросил ${N.toLocaleString('ru-RU')} раз в каждой группе`);
  });
  $('#loot-export-csv').addEventListener('click', () => downloadCSV('loot_check.csv', lootExportRows()));
  $('#loot-export-json').addEventListener('click', () => downloadJSON('loot_check.json', { ok: lootResult().check.ok, groups: lootResult().check.groups, rows: lootExportRows() }));
  renderers.loot = renderLoot;

  // ================= 06 Аудит =================
  function renderAudit() {
    const units = validUnits();
    if (units.length < 3) { $('#audit-table').innerHTML = '<tr><td><div class="msg warn">Для сравнения нужно хотя бы три юнита.</div></td></tr>'; return; }
    const a = C.audit(units, ttkOpts()).sort((x, y) => y.relative - x.relative);
    const label = { dominant: 'имба', useless: 'слабый', ok: 'норм' };
    $('#audit-table').innerHTML = `<thead><tr><th>юнит</th><th class="num">цена</th><th class="num">п / н / п</th><th class="num">побед</th><th class="num">сила / цена</th><th class="num">E отн.</th><th></th></tr></thead><tbody>${
      a.map((r) => { const u = units.find((x) => x.id === r.id); return `<tr><td>${esc(r.name)}</td><td class="num">${u.cost}</td><td class="num">${r.wins} / ${r.draws} / ${r.losses}</td><td class="num">${fmt(r.winRate * 100, 0)}%</td><td class="num">${fmt(r.powerPerCost, 1)}</td><td class="num">${fmt(r.relative, 2)}</td><td><span class="tag ${r.verdict === 'ok' ? 'good' : r.verdict}">${label[r.verdict]}</span></td></tr>`; }).join('')}</tbody>`;
    const col = { dominant: css('--warn'), useless: css('--err'), ok: css('--faint') };
    chart('audit-chart', {
      type: 'bar',
      data: { labels: a.map((r) => r.name), datasets: [{ label: 'E отн.', data: a.map((r) => Math.round(r.relative * 100) / 100), backgroundColor: a.map((r) => col[r.verdict]), barThickness: 14 }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true }, y: { grid: { display: false } } } },
    });
  }
  renderers.audit = renderAudit;

  // ================= 07 Экономика =================
  function renderEcoList(kind) {
    $('#eco-' + kind).innerHTML = state.economy[kind].map((x, i) => `<div class="eco-item" data-kind="${kind}" data-i="${i}">
      <label class="field grow">название <input type="text" data-f="name" value="${esc(x.name)}"></label>
      <label class="field">за шаг <input type="number" data-f="amount" value="${x.amount}" min="0"></label>
      <label class="field">рост, % <input type="number" data-f="growth" value="${x.growth}" step="0.5"></label>
      <button class="icon" data-eco-del aria-label="Удалить">✕</button></div>`).join('');
  }
  function renderEconomy() {
    const e = state.economy;
    $('#eco-start').value = e.start; $('#eco-steps').value = e.steps;
    renderEcoList('sources'); renderEcoList('sinks');
    renderEcoChart();
  }
  function renderEcoChart() {
    const e = state.economy;
    const sim = C.simulateEconomy(e.start, e.sources, e.sinks, e.steps);
    const last = sim[sim.length - 1];
    const ratio = last.spend ? last.income / last.spend : Infinity;
    const negAt = sim.find((s) => s.balance < 0);
    const note = ratio > 1.1 ? 'Валюта копится быстрее, чем тратится. Через пару десятков шагов цены в магазине перестанут что-то значить, нужен ещё один сток.'
      : ratio < 0.9 ? 'Тратить приходится больше, чем игрок получает' + (negAt ? `, на шаге ${negAt.step} баланс уходит в минус` : '') + '.'
      : 'Доход и расход примерно равны.';
    $('#eco-summary').innerHTML = `<div class="stat accent"><b>${fmt(last.balance, 0)}</b><span>баланс на шаге ${e.steps}</span></div>
      <div class="stat"><b>${fmt(ratio, 2)}</b><span>доход / расход на последнем шаге</span></div>
      <div class="stat"><b>${e.start ? (last.balance >= e.start ? '+' : '') + fmt(((last.balance - e.start) / Math.abs(e.start)) * 100, 0) + '%' : '—'}</b><span>к стартовому балансу</span></div>
      <div class="msg ${ratio > 1.1 ? 'warn' : ratio < 0.9 ? 'err' : 'ok'}">${note}</div>`;
    chart('eco-chart', {
      data: {
        labels: sim.map((s) => s.step),
        datasets: [
          { type: 'line', label: 'баланс', data: sim.map((s) => s.balance), borderColor: css('--accent'), backgroundColor: css('--accent'), borderWidth: 2, pointRadius: 0, yAxisID: 'y', tension: 0.2 },
          { type: 'line', label: 'доход за шаг', data: sim.map((s) => (s.step ? s.income : null)), borderColor: css('--ink'), backgroundColor: css('--ink'), borderWidth: 1, pointRadius: 0, yAxisID: 'y2' },
          { type: 'line', label: 'расход за шаг', data: sim.map((s) => (s.step ? s.spend : null)), borderColor: css('--muted'), backgroundColor: css('--muted'), borderWidth: 1, pointRadius: 0, yAxisID: 'y2', borderDash: [4, 3] },
        ],
      },
      options: { scales: { x: { grid: { display: false }, title: { display: true, text: 'шаг' } }, y: {}, y2: { position: 'right', grid: { drawOnChartArea: false } } } },
    });
  }
  $('#eco-start').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { state.economy.start = v; save(); renderEcoChart(); } });
  $('#eco-steps').addEventListener('input', (e) => { const v = parseInt(e.target.value, 10); if (v >= 1 && v <= 1000) { state.economy.steps = v; save(); renderEcoChart(); } });
  $('#tab-economy').addEventListener('input', (e) => {
    const item = e.target.closest('.eco-item');
    if (!item) return;
    const x = state.economy[item.dataset.kind][+item.dataset.i], f = e.target.dataset.f;
    if (f === 'name') x.name = e.target.value;
    else { const v = parseFloat(e.target.value); if (!Number.isFinite(v)) return; x[f] = v; }
    save(); renderEcoChart();
  });
  $('#tab-economy').addEventListener('click', (e) => {
    const add = e.target.closest('[data-eco-add]');
    if (add) { state.economy[add.dataset.ecoAdd].push({ name: add.dataset.ecoAdd === 'sources' ? 'Новый источник' : 'Новый сток', amount: 100, growth: 0 }); save(); renderEconomy(); }
    const del = e.target.closest('[data-eco-del]');
    if (del) { const it = del.closest('.eco-item'); state.economy[it.dataset.kind].splice(+it.dataset.i, 1); save(); renderEconomy(); }
  });
  renderers.economy = renderEconomy;

  // ================= 08 Навыки =================
  function renderSkills() {
    const ta = $('#skills-json');
    if (document.activeElement !== ta) ta.value = state.skills ? JSON.stringify(state.skills, null, 2) : '';
    const svg = $('#skills-svg');
    if (!state.skills) { svg.innerHTML = ''; $('#skills-errors').innerHTML = '<div class="msg warn">Дерева пока нет. Загрузите <code>skills.json</code> или вставьте JSON выше.</div>'; return; }
    let t;
    try { t = C.layoutSkillTree(state.skills); } catch (e) { $('#skills-errors').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
    $('#skills-errors').innerHTML = t.errors.length ? `<div class="msg err"><b>С деревом что-то не так</b><ul>${t.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
    const W = 156, H = 46, GX = 72, GY = 16;
    const pos = new Map();
    t.layers.forEach((layer, d) => (layer || []).forEach((n, i) => pos.set(String(n.id), { x: d * (W + GX), y: i * (H + GY) })));
    const width = t.layers.length * (W + GX) - GX + 2;
    const height = Math.max(...t.layers.map((l) => (l || []).length)) * (H + GY) - GY + 2;
    svg.setAttribute('viewBox', `-1 -1 ${width} ${height}`);
    svg.setAttribute('width', width); svg.setAttribute('height', height);
    let edges = '', nodes = '';
    t.byId.forEach((n, id) => {
      const b = pos.get(id);
      (n.requires || []).map(String).filter((r) => pos.has(r)).forEach((r) => {
        const a = pos.get(r), x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = x1 + (x2 - x1) / 2;
        edges += `<path class="edge" data-from="${esc(r)}" data-to="${esc(id)}" d="M${x1},${y1} H${mx - 8} Q${mx},${y1} ${mx},${y1 + Math.sign(y2 - y1) * Math.min(8, Math.abs(y2 - y1) / 2)} V${y2 - Math.sign(y2 - y1) * Math.min(8, Math.abs(y2 - y1) / 2)} Q${mx},${y2} ${mx + 8},${y2} H${x2}"/>`;
      });
      nodes += `<g class="node ${(n.requires || []).length ? '' : 'root'}" data-id="${esc(id)}" transform="translate(${b.x},${b.y})" tabindex="0">
        <rect width="${W}" height="${H}"/><text x="12" y="20">${esc(n.name || id)}</text>
        <text x="12" y="36" class="meta">${esc(id)}${n.cost !== undefined ? ' · ' + esc(n.cost) + ' оч.' : ''}</text><title>${esc(n.name || id)}. Требует: ${esc((n.requires || []).join(', ') || 'ничего')}</title></g>`;
    });
    svg.innerHTML = edges + nodes;
    // Подсветка всей цепочки требований (и суммарной стоимости) при наведении
    const highlight = (id) => {
      $$('.hl', svg).forEach((x) => x.classList.remove('hl'));
      if (!id) return;
      const need = new Set(), stack = [id];
      while (stack.length) { const c = stack.pop(); if (need.has(c) || !t.byId.has(c)) continue; need.add(c); (t.byId.get(c).requires || []).forEach((r) => stack.push(String(r))); }
      need.forEach((n) => $(`.node[data-id="${CSS.escape(n)}"]`, svg).classList.add('hl'));
      $$('path[data-to]', svg).forEach((p) => { if (need.has(p.dataset.to) && need.has(p.dataset.from)) p.classList.add('hl'); });
      const cost = [...need].reduce((s, n) => s + (Number(t.byId.get(n).cost) || 0), 0);
      toast(`${t.byId.get(id).name || id}: ${need.size} ${plural(need.size, 'навык', 'навыка', 'навыков')} в цепочке, ${cost} оч.`);
    };
    $$('.node', svg).forEach((g) => { g.addEventListener('mouseenter', () => highlight(g.dataset.id)); g.addEventListener('focus', () => highlight(g.dataset.id)); g.addEventListener('mouseleave', () => highlight(null)); });
  }
  $('#skills-apply').addEventListener('click', () => {
    try { const p = JSON.parse($('#skills-json').value); C.layoutSkillTree(p); state.skills = Array.isArray(p) ? { nodes: p } : p; save(); $('#skills-json').blur(); renderSkills(); toast('Дерево обновлено'); }
    catch (e) { $('#skills-errors').innerHTML = `<div class="msg err">JSON не разобрался: ${esc(e.message)}</div>`; }
  });
  renderers.skills = renderSkills;

  // ================= 09 Ассистент =================
  // Оба сервиса говорят на OpenAI-совместимом API, отличаются только адресом, моделью и заголовками.
  const PROVIDERS = {
    openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', model: 'deepseek/deepseek-chat', keyName: 'Нужен ключ OpenRouter (openrouter.ai/keys)' },
    deepseek: { url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', keyName: 'Нужен ключ DeepSeek' },
  };
  const ls = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* нет хранилища */ } } };
  const provider = () => $('#ai-provider').value;
  function loadProvider() {
    const p = provider();
    $('#ai-model').value = ls.get('bps.ai.model.' + p) || PROVIDERS[p].model;
    const k = ls.get('bps.ai.key.' + p) || (p === 'deepseek' ? ls.get('bps.deepseekKey') : null);
    $('#ai-key').value = k || '';
    $('#ai-remember').checked = !!k;
  }
  $('#ai-provider').value = ls.get('bps.ai.provider') || 'openrouter';
  loadProvider();
  $('#ai-provider').addEventListener('change', () => { ls.set('bps.ai.provider', provider()); loadProvider(); });
  $('#ai-model').addEventListener('change', (e) => ls.set('bps.ai.model.' + provider(), e.target.value.trim() || null));
  function aiPayload() {
    const units = validUnits();
    const audit = units.length >= 3 ? C.audit(units, ttkOpts()) : [];
    const lv = prLevels();
    const { check } = lootResult();
    const e = state.economy, sim = C.simulateEconomy(e.start, e.sources, e.sinks, e.steps);
    return {
      damageFormula: 'max(attack - defense, attack*minRatio)*mult; expected = base*(1+critChance*(critMult-1)); TTK=(ceil(hp/dmg)-1)/attackSpeed',
      ttkSettings: ttkOpts(),
      units: units.map((u) => { const a = audit.find((x) => x.id === u.id); return { name: u.name, hp: u.hp, attack: u.attack, defense: u.defense, cost: u.cost, winRate: a && Math.round(a.winRate * 100), efficiencyVsMedian: a && Math.round(a.relative * 100) / 100, verdict: a && a.verdict }; }),
      progression: { params: state.progression, xpLevel2: lv[1] && lv[1].totalXp, xpMax: lv[lv.length - 1].totalXp },
      loot: { ok: check.ok, groups: check.groups.map((g) => ({ group: g.group, sum: g.sum, items: g.count })) },
      economy: { start: e.start, steps: e.steps, finalBalance: sim[sim.length - 1].balance, sources: e.sources, sinks: e.sinks },
    };
  }
  function renderAssistant() { $('#ai-payload').textContent = JSON.stringify(aiPayload(), null, 2); }
  $('#ai-remember').addEventListener('change', (e) => ls.set('bps.ai.key.' + provider(), e.target.checked ? $('#ai-key').value.trim() : null));
  $('#ai-send').addEventListener('click', async () => {
    const key = $('#ai-key').value.trim();
    const P = PROVIDERS[provider()];
    if (!key) return toast(P.keyName);
    if ($('#ai-remember').checked) ls.set('bps.ai.key.' + provider(), key);
    const btn = $('#ai-send'); btn.disabled = true; $('#ai-status').textContent = 'думает…'; $('#ai-answer').textContent = '';
    try {
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
      if (provider() === 'openrouter') Object.assign(headers, { 'HTTP-Referer': location.origin, 'X-Title': 'Balance Studio' });
      const r = await fetch(P.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: $('#ai-model').value.trim() || P.model, temperature: 0.3,
          messages: [
            { role: 'system', content: 'Ты геймдизайнер, который занимается балансом. Отвечай по-русски, коротко и по делу, опирайся на конкретные числа из данных. Ничего не выдумывай. Правки предлагай как советы.' },
            { role: 'user', content: $('#ai-question').value + '\n\nДанные баланса (JSON):\n' + JSON.stringify(aiPayload()) },
          ],
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
      $('#ai-answer').textContent = j.choices?.[0]?.message?.content || '(ответ пустой)';
      $('#ai-status').textContent = '';
    } catch (e) {
      $('#ai-status').textContent = '';
      $('#ai-answer').innerHTML = `<div class="msg err">Запрос не прошёл: ${esc(e.message)}</div>`;
    } finally { btn.disabled = false; }
  });
  renderers.assistant = renderAssistant;

  // ---------- Тема и горячие клавиши ----------
  $('#btn-theme').addEventListener('click', toggleTheme);
  function toggleTheme() {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('bps.theme', document.documentElement.dataset.theme); } catch (e) { /* тема не запомнится */ }
    renderers[state.tab] && renderers[state.tab](); // перекрасить графики
  }
  $('#btn-help').addEventListener('click', () => $('#help').showModal());
  const order = $$('.tabs button').map((b) => b.dataset.tab);
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && /^Digit[1-9]$/.test(e.code)) { e.preventDefault(); showTab(order[+e.code.slice(5) - 1]); }
    else if (e.altKey && e.code === 'KeyT') { e.preventDefault(); toggleTheme(); }
    else if (e.altKey && e.code === 'KeyN') { e.preventDefault(); showTab('table'); addRow(); }
    else if (mod && e.code === 'KeyE') { e.preventDefault(); exportProject(); }
    else if (mod && e.code === 'KeyO') { e.preventDefault(); fileInput.click(); }
    else if (e.key === '?' && !typing) { e.preventDefault(); $('#help').showModal(); }
  });

  // ---------- Старт ----------
  // Первый запуск: подгружаем примеры, чтобы все вкладки сразу показывали данные.
  async function bootstrap() {
    if (state.units.length || state.loot.length || state.skills || location.protocol === 'file:') return;
    for (const f of ['units.csv', 'loot.csv', 'skills.json']) {
      try {
        const r = await fetch('data/' + f);
        if (!r.ok) continue;
        const text = await r.text();
        if (f.endsWith('.json')) { state.skills = JSON.parse(text); continue; }
        const type = f.startsWith('loot') ? 'loot' : 'units';
        const p = C.parseCSV(text), v = C.validate(p.rows, type, p.headers);
        if (v.ok) { state[type] = v.rows; state.headers[type] = p.headers; }
      } catch (e) { /* без примеров приложение просто стартует пустым */ }
    }
    save();
  }
  bootstrap().then(() => showTab(state.tab));
  // Шрифты меняют высоту пунктов меню — переставить метку после загрузки.
  document.fonts && document.fonts.ready.then(moveInk);
})();
