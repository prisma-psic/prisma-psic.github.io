/* =========================================================================
   PRISMA — global.js
   Núcleo compartilhado por todas as páginas:
     1. Utilitários (datas, formatação, escape de HTML)
     2. Ícones SVG
     3. Banco de dados local (seed espelhando database/schema.sql)
     4. Store com persistência em localStorage + sincronização entre abas
     5. Sessão / troca de perfil (Psicóloga ⇄ Paciente)
     6. Núcleo de auditoria (LGPD) e notificações (FCM simulado)
     7. Componentes de UI (toast, modal, badges, avatar, empty state)
     8. Shell da aplicação (sidebar, drawer mobile, topbar, bottom nav)
     9. Registro de páginas (PRISMA.page)

   Cada módulo (agenda.js, metas.js, ...) expõe seu "service" em
   PRISMA.services.<modulo> e só registra o controlador de página quando
   <body data-page="..."> corresponde ao módulo. Assim, um módulo pode ser
   reaproveitado em outra página (ex.: testes.html usa os services para
   executar os casos de teste CT01–CT11).
   ========================================================================= */
(function () {
  'use strict';

  const PRISMA = (window.PRISMA = window.PRISMA || {});
  PRISMA.version = '3.0.0';
  PRISMA.services = PRISMA.services || {};

  const STORAGE_KEY = 'prisma:db:v4';
  const SESSION_KEY = 'prisma:session';
  const PREFS_KEY = 'prisma:prefs';

  /* =====================================================================
     1. UTILITÁRIOS
     ===================================================================== */
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
  const DIAS_CURTOS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];

  const pad = (n) => String(n).padStart(2, '0');

  const util = {
    MESES, MESES_CURTOS, DIAS, DIAS_CURTOS,
    $: (sel, root = document) => root.querySelector(sel),
    $$: (sel, root = document) => Array.from(root.querySelectorAll(sel)),

    esc(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    initials(nome = '') {
      const partes = String(nome).replace(/^(Dra?\.)\s*/i, '').trim().split(/\s+/).filter(Boolean);
      if (!partes.length) return '?';
      const first = partes[0][0];
      const last = partes.length > 1 ? partes[partes.length - 1][0] : '';
      return (first + last).toUpperCase();
    },
    firstName(nome = '') {
      return String(nome).replace(/^(Dra?\.)\s*/i, '').split(' ')[0];
    },
    /** Data local → 'YYYY-MM-DD' */
    isoDate(d = new Date()) {
      const x = new Date(d);
      return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
    },
    /** 'YYYY-MM-DD' + 'HH:MM' (horário local) → ISO UTC */
    combine(dateStr, timeStr) {
      const [y, m, d] = dateStr.split('-').map(Number);
      const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
      return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
    },
    parseDate(dateStr) {
      if (!dateStr) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d);
      }
      return new Date(dateStr);
    },
    fmtDate(v) {
      const d = util.parseDate(v); if (!d || isNaN(d)) return '—';
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    },
    fmtDateShort(v) {
      const d = util.parseDate(v); if (!d || isNaN(d)) return '—';
      return `${d.getDate()} ${MESES_CURTOS[d.getMonth()]} ${d.getFullYear()}`;
    },
    fmtTime(v) {
      const d = new Date(v); if (isNaN(d)) return '—';
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    fmtDateTime(v) { return `${util.fmtDate(v)} às ${util.fmtTime(v)}`; },
    fmtDateLong(v) {
      const d = util.parseDate(v);
      return `${DIAS[d.getDay()]}, ${d.getDate()} de ${MESES[d.getMonth()]}`;
    },
    fmtDateFull(v) {
      const d = util.parseDate(v);
      return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
    },
    capitalize: (s = '') => s.charAt(0).toUpperCase() + s.slice(1),
    sameDay(a, b) {
      const x = new Date(a), y = new Date(b);
      return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
    },
    hoursUntil(iso) { return (new Date(iso).getTime() - Date.now()) / 36e5; },
    relTime(iso) {
      const diff = new Date(iso).getTime() - Date.now();
      const abs = Math.abs(diff);
      const min = Math.round(abs / 6e4), h = Math.round(abs / 36e5), d = Math.round(abs / 864e5);
      let txt;
      if (min < 1) return 'agora';
      if (min < 60) txt = `${min} min`;
      else if (h < 24) txt = `${h} h`;
      else txt = `${d} dia${d > 1 ? 's' : ''}`;
      return diff > 0 ? `em ${txt}` : `há ${txt}`;
    },
    fmtSize(kb) {
      if (kb == null) return '—';
      return kb >= 1024 ? `${(kb / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(kb))} KB`;
    },
    debounce(fn, ms = 200) {
      let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    },
    normalize: (s = '') => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(),
    clone: (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o))),
    greeting() {
      const h = new Date().getHours();
      return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    },
    formData(form) {
      const data = {};
      new FormData(form).forEach((v, k) => {
        if (k in data) data[k] = [].concat(data[k], v); else data[k] = typeof v === 'string' ? v.trim() : v;
      });
      return data;
    },
  };
  PRISMA.util = util;

  /* =====================================================================
     2. ÍCONES (SVG inline, traço 2px)
     ===================================================================== */
  const ICONS = {
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/>',
    test: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><polyline points="9 14 11 16 15 12"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
    'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
    'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    trending: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    'cloud-off': '<path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/><line x1="1" y1="1" x2="23" y2="23"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    'x-circle': '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    prism: '<path d="M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5z"/><circle cx="12" cy="12" r="3.2"/>',
    history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><polyline points="12 7 12 12 15 15"/>',
    swap: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    'file-plus': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
    award: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
    bar: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    card: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  };
  PRISMA.icon = function (name, size = 18, extraClass = '') {
    const body = ICONS[name] || ICONS.info;
    return `<svg class="ic-${name} ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };

  /* =====================================================================
     3. BANCO DE DADOS LOCAL — SEED
     Estrutura idêntica às tabelas do database/schema.sql.
     Datas das consultas são relativas ao "agora" para que as regras
     (trava de 24h, choque de horário) possam ser demonstradas a qualquer momento.
     ===================================================================== */
  function createSeed() {
    const now = new Date();
    /** Primeiro horário comercial (08:00–19:00, passo de 30 min) a partir de um instante */
    const nextBusiness = (fromMs) => {
      const d = new Date(fromMs); d.setSeconds(0, 0);
      d.setMinutes(d.getMinutes() === 0 ? 0 : d.getMinutes() <= 30 ? 30 : 60);
      for (let i = 0; i < 200; i++) {
        const mins = d.getHours() * 60 + d.getMinutes();
        if (mins >= 8 * 60 && mins <= 19 * 60) return d;
        d.setTime(d.getTime() + 30 * 6e4);
      }
      return d;
    };
    /** Dia futuro (dias à frente) em horário fixo 'HH:MM' */
    const at = (days, hhmm) => {
      const d = new Date(now); d.setDate(d.getDate() + days);
      const [h, m] = hhmm.split(':').map(Number); d.setHours(h, m, 0, 0); return d.toISOString();
    };
    // Consulta "em breve" e consulta dentro da janela de 24 h (para demonstrar a trava)
    const t111 = nextBusiness(now.getTime() + 1.5 * 36e5);
    const t104 = nextBusiness(Math.max(now.getTime() + 7 * 36e5, t111.getTime() + 2 * 36e5));
    const daysAgo = (days, hour = 10, min = 0) => {
      const d = new Date(now); d.setDate(d.getDate() - days); d.setHours(hour, min, 0, 0); return d.toISOString();
    };
    const dateAgo = (days) => util.isoDate(new Date(now.getTime() - days * 864e5));
    const dateIn = (days) => util.isoDate(new Date(now.getTime() + days * 864e5));
    const CRP = '06/12345';

    const psicologo = {
      CRP,
      Nome: 'Dra. Shelley Christina',
      Especialidade: 'Neuropsicologia e Psicologia Social',
      Abordagem: 'Terapia Cognitivo-Comportamental (TCC)',
      Email: 'shelley.christina@prisma.com.br',
      Telefone: '(43) 99888-7766',
      CPF: '012.345.678-90',
      Consultorio: 'Rua XV de Novembro, 120 — Santana do Itararé/PR',
      Bio: 'Psicóloga com 14 anos de experiência em atendimento online e presencial.',
      LimiteAlteracaoHoras: 24,            // cancelamento pelo paciente (configurável)
      AntecedenciaAgendamentoHoras: 48,    // novo agendamento: agora + 48 h
      AntecedenciaReagendamentoHoras: 48,  // reagendamento: só com mais de 48 h para a consulta
      PrazoConfirmacaoHoras: 36,           // presença confirmada até 36 h antes
      LembreteConfirmacaoHoras: 24,        // lembrete enviado 24 h antes do prazo (60 h antes da consulta)
      // Autenticação — senha de demonstração: prisma123 (hash SHA-256 com salt)
      Status: 'ATIVO', IsAdmin: true,
      SenhaHash: 'sha256$a1f4c9e2$31ebf4bb457598554c34d0e2b6944aa767d0f77eee5c1ac3c1274238714a2553',
    };

    /** Outros profissionais da clínica (cadastro de psicólogo exige validação do administrador) */
    const equipe = [
      { CRP: '08/54321', Nome: 'Dr. Marcos Vieira', Especialidade: 'Psicologia Clínica', Abordagem: 'Psicanálise', Email: 'marcos.vieira@email.com',
        Telefone: '(43) 99111-2233', CPF: '321.654.987-00', LimiteAlteracaoHoras: 24, Status: 'PENDENTE_APROVACAO', IsAdmin: false,
        Data_Solicitacao: new Date(now.getTime() - 5 * 36e5).toISOString(), Data_Aprovacao: null, CRP_Psicologo_Aprovador: null,
        SenhaHash: 'sha256$4ea18293$489ff242ebc4c528a31f5711350dd388a633c0c7146f5602c1bacbb5b9febac7' },
    ];

    const pacientes = [
      { CPF: '111.222.333-44', Nome: 'Ana Carolina Mendes', Email: 'ana.carolina@email.com', Telefone: '(43) 98765-4321', DataNascimento: '1995-04-12', QueixaPrincipal: 'Ansiedade generalizada e estresse ocupacional', Tags: ['ansiedade', 'tcc'] },
      { CPF: '222.333.444-55', Nome: 'Bruno Ferreira', Email: 'bruno.ferreira@email.com', Telefone: '(43) 97654-3210', DataNascimento: '1989-11-23', QueixaPrincipal: 'Episódios depressivos e isolamento social', Tags: ['depressão', 'ruminação'] },
      { CPF: '333.444.555-66', Nome: 'Camila Rodrigues', Email: 'camila.rodrigues@email.com', Telefone: '(43) 96543-2109', DataNascimento: '2001-08-15', QueixaPrincipal: 'Insegurança nas tomadas de decisão e baixa autoestima', Tags: ['autoestima', 'limites'] },
      { CPF: '444.555.666-77', Nome: 'Diego Souza', Email: 'diego.souza@email.com', Telefone: '(43) 95432-1098', DataNascimento: '1987-03-30', QueixaPrincipal: 'Dificuldades de comunicação conjugal e assertividade', Tags: ['casal', 'comunicação'] },
      { CPF: '555.666.777-88', Nome: 'Elena Martins', Email: 'elena.martins@email.com', Telefone: '(43) 94321-0987', DataNascimento: '1992-06-18', QueixaPrincipal: 'Transição profissional e sobrecarga emocional', Tags: ['carreira'] },
      { CPF: '777.888.999-00', Nome: 'Maria Silva', Email: 'maria.silva@email.com', Telefone: '(43) 93210-9876', DataNascimento: '1994-09-05', QueixaPrincipal: 'Regulação emocional e acompanhamento preventivo', Tags: ['regulação emocional'] },
    ];
    // Pacientes em acompanhamento: cadastro já aprovado pela psicóloga (senha de demonstração: prisma123)
    const HASHES = {
      '111.222.333-44': 'sha256$b7d2e810$57bd9a658228a06b83d929b9d3a14b5313a058abe2dbfd6af6becfdb2ffed01f',
      '222.333.444-55': 'sha256$c3a9f147$7ee05ebffcac54da5c96e6dd33ce24f2045c8e6ee325df4a8b9e7d97963199d8',
      '333.444.555-66': 'sha256$d58e2b06$a834f4f8006667e1997353eff543d9b687f4f039e515611d4c13054c3f52ad70',
      '444.555.666-77': 'sha256$e2c71d93$09c88f609fd6038a97176b64ce3de50cd6ba4652363b9fffa85edaddddd30231',
      '555.666.777-88': 'sha256$f9b3a0c4$06dd57049b74f0edec8489bf231c4beed994b5bc755a5d7364d2a72922df4f3e',
      '777.888.999-00': 'sha256$0a6d4e5f$0ba7470f3e6e5d39e0707ba30c5602a71642122fe732360aa761b68e352d9442',
      '888.999.000-11': 'sha256$1b7e5f60$514e590ff249a7698ca3997ceb36b1898963da1b30ebcdbdf7c1090caa89702d',
      '999.000.111-22': 'sha256$2c8f6071$b6488329c8348fc232357546e766ad22da334da9b04fc3a080a637f8a4a9d752',
      '000.111.222-33': 'sha256$3d907182$bc0dd60d9b8727b7ea25894a6b6dbe797a6996e3dda22099df82fc3287d289e5',
    };
    pacientes.forEach((p, i) => Object.assign(p, {
      Status: 'ATIVO', ConsentimentoLGPD: true,
      Data_Solicitacao: new Date(now.getTime() - (120 - i) * 864e5).toISOString(),
      Data_Aprovacao: new Date(now.getTime() - (119 - i) * 864e5).toISOString(),
      CRP_Psicologo_Aprovador: CRP, SenhaHash: HASHES[p.CPF],
    }));
    // Solicitações de cadastro aguardando a psicóloga + uma recusada
    pacientes.push(
      { CPF: '888.999.000-11', Nome: 'Lucas Almeida', Email: 'lucas.almeida@email.com', Telefone: '(43) 99876-1122', DataNascimento: '1998-02-14', QueixaPrincipal: null, Tags: [],
        Status: 'PENDENTE_APROVACAO', ConsentimentoLGPD: true, Data_Solicitacao: new Date(now.getTime() - 26 * 36e5).toISOString(), Data_Aprovacao: null, CRP_Psicologo_Aprovador: null, SenhaHash: HASHES['888.999.000-11'] },
      { CPF: '999.000.111-22', Nome: 'Fernanda Costa', Email: 'fernanda.costa@email.com', Telefone: '(43) 98555-7788', DataNascimento: '1990-12-01', QueixaPrincipal: null, Tags: [],
        Status: 'PENDENTE_APROVACAO', ConsentimentoLGPD: true, Data_Solicitacao: new Date(now.getTime() - 3 * 36e5).toISOString(), Data_Aprovacao: null, CRP_Psicologo_Aprovador: null, SenhaHash: HASHES['999.000.111-22'] },
      { CPF: '000.111.222-33', Nome: 'Rafael Nunes', Email: 'rafael.nunes@email.com', Telefone: '(43) 97444-3322', DataNascimento: '1985-07-22', QueixaPrincipal: null, Tags: [],
        Status: 'REJEITADO', ConsentimentoLGPD: true, Data_Solicitacao: new Date(now.getTime() - 10 * 864e5).toISOString(), Data_Aprovacao: null, CRP_Psicologo_Aprovador: CRP,
        MotivoRejeicao: 'Demanda fora da área de atuação — encaminhado para outro serviço.', SenhaHash: HASHES['000.111.222-33'] },
    );

    const C = (o) => ({
      DataHoraSugerida: null, CRP_Psicologo: CRP, Solicitante: 'Paciente', MotivoCancelamento: null,
      // Confirmação de presença (regra das 36 h)
      StatusConfirmacao: o.Status === 'Agendada' ? 'AGUARDANDO' : o.Status === 'Realizada' ? 'CONFIRMADA' : null,
      ConfirmadaEm: null, ConfirmadaPor: null, ConfirmacaoTardia: false, LembreteConfirmacaoEm: null, AlertaConfirmacaoEm: null,
      ...o,
    });
    const consultas = [
      // Histórico (realizadas / faltas)
      C({ ID_Consulta: 95, DataHora: daysAgo(28, 8), Duracao: '60 min', Status: 'Realizada', CPF_Paciente: '111.222.333-44', Modalidade: 'Presencial', Solicitante: 'Psicóloga', Observacoes: 'Sessão 22 — psicoeducação sobre ansiedade.' }),
      C({ ID_Consulta: 96, DataHora: daysAgo(10, 14), Duracao: '90 min', Status: 'Realizada', CPF_Paciente: '444.555.666-77', Modalidade: 'Presencial', Observacoes: 'Terapia de casal — mapeamento de conflitos.' }),
      C({ ID_Consulta: 97, DataHora: daysAgo(3, 15, 30), Duracao: '60 min', Status: 'Faltou', CPF_Paciente: '555.666.777-88', Modalidade: 'Online', Observacoes: 'Paciente não compareceu e não avisou.' }),
      C({ ID_Consulta: 101, DataHora: daysAgo(7, 8), Duracao: '60 min', Status: 'Realizada', CPF_Paciente: '111.222.333-44', Modalidade: 'Presencial', Solicitante: 'Psicóloga', Observacoes: 'Sessão 24 — reestruturação cognitiva e revisão de RPD.' }),
      C({ ID_Consulta: 102, DataHora: daysAgo(14, 9, 30), Duracao: '60 min', Status: 'Realizada', CPF_Paciente: '222.333.444-55', Modalidade: 'Presencial', Solicitante: 'Psicóloga', Observacoes: 'Sessão 8 — ativação comportamental.' }),
      C({ ID_Consulta: 103, DataHora: daysAgo(21, 11), Duracao: '60 min', Status: 'Realizada', CPF_Paciente: '333.444.555-66', Modalidade: 'Online', Solicitante: 'Psicóloga', Observacoes: 'Sessão 12 — inventário de forças.' }),
      // Futuras
      C({ ID_Consulta: 111, DataHora: t111.toISOString(), Duracao: '60 min', Status: 'Agendada', CPF_Paciente: '333.444.555-66', Modalidade: 'Online', Observacoes: 'Sessão individual de acompanhamento.',
        StatusConfirmacao: 'CONFIRMADA', ConfirmadaPor: 'Paciente', ConfirmadaEm: new Date(t111.getTime() - 50 * 36e5).toISOString(), LembreteConfirmacaoEm: new Date(t111.getTime() - 60 * 36e5).toISOString() }),
      C({ ID_Consulta: 104, DataHora: t104.toISOString(), Duracao: '60 min', Status: 'Agendada', CPF_Paciente: '111.222.333-44', Modalidade: 'Online', Observacoes: 'Acompanhamento quinzenal — dentro da janela de 24 h: o paciente não pode cancelar nem remarcar. Presença ainda não confirmada.' }),
      C({ ID_Consulta: 109, DataHora: at(2, '09:00'), DataHoraSugerida: at(3, '15:00'), Duracao: '60 min', Status: 'Aguardando_Paciente', CPF_Paciente: '111.222.333-44', Modalidade: 'Presencial', Observacoes: 'A psicóloga sugeriu remanejar devido a um congresso.' }),
      C({ ID_Consulta: 108, DataHora: at(2, '14:00'), Duracao: '60 min', Status: 'Pendente', CPF_Paciente: '111.222.333-44', Modalidade: 'Online', Observacoes: 'Solicitação para manejo de ansiedade pré-avaliação profissional.' }),
      C({ ID_Consulta: 105, DataHora: at(3, '10:00'), Duracao: '60 min', Status: 'Agendada', CPF_Paciente: '777.888.999-00', Modalidade: 'Presencial', Observacoes: 'Sessão individual presencial no consultório.' }),
      C({ ID_Consulta: 110, DataHora: at(3, '17:00'), Duracao: '60 min', Status: 'Recusada', CPF_Paciente: '222.333.444-55', Modalidade: 'Online', Observacoes: 'Solicitação não pôde ser atendida.', MotivoCancelamento: 'Horário indisponível na grade clínica.' }),
      C({ ID_Consulta: 106, DataHora: at(4, '14:00'), Duracao: '90 min', Status: 'Agendada', CPF_Paciente: '444.555.666-77', Modalidade: 'Presencial', Solicitante: 'Psicóloga', Observacoes: 'Terapia de casal — alinhamento de acordos.' }),
      C({ ID_Consulta: 107, DataHora: at(5, '09:00'), Duracao: '30 min', Status: 'Agendada', CPF_Paciente: '555.666.777-88', Modalidade: 'Online', Observacoes: 'Feedback rápido de evolução.' }),
      C({ ID_Consulta: 113, DataHora: at(2, '17:00'), Duracao: '60 min', Status: 'Agendada', CPF_Paciente: '222.333.444-55', Modalidade: 'Online', Solicitante: 'Psicóloga', Observacoes: 'Sessão 9 — revisão da agenda de atividades.' }),
      C({ ID_Consulta: 112, DataHora: at(6, '10:00'), Duracao: '60 min', Status: 'Pendente', CPF_Paciente: '222.333.444-55', Modalidade: 'Presencial', Observacoes: 'Retomada do acompanhamento semanal.' }),
    ];

    const d101 = util.isoDate(consultas.find((c) => c.ID_Consulta === 101).DataHora);
    const d102 = util.isoDate(consultas.find((c) => c.ID_Consulta === 102).DataHora);
    const d103 = util.isoDate(consultas.find((c) => c.ID_Consulta === 103).DataHora);
    const d95 = util.isoDate(consultas.find((c) => c.ID_Consulta === 95).DataHora);
    const next104 = consultas.find((c) => c.ID_Consulta === 104).DataHora;

    const registrosClinicos = [
      {
        ID_RC: 1, DataCriacao: d101, DataUltMod: d101, CPF_Paciente: '111.222.333-44', ID_Consulta: 101, CRP_Psicologo: CRP,
        NumeroSessao: 24, DuracaoMin: 50,
        Conteudo: 'Sessão focada em reestruturação cognitiva e manejo de ansiedade antecipatória no ambiente profissional.',
        QueixaPrincipal: 'Paciente relatou semana difícil com episódios de ansiedade na segunda e quarta-feira, associados a reuniões no trabalho.',
        IntervencoesRealizadas: '• Revisão dos registros de pensamentos automáticos\n• Técnica de reestruturação cognitiva: questionamento socrático sobre catastrofização\n• Exercício de respiração diafragmática em sessão',
        ProgressoObservado: 'Paciente demonstrou maior capacidade de identificar distorções cognitivas. Relata que a técnica de respiração tem ajudado antes das reuniões.',
        TarefasParaCasa: '1. Continuar registro de pensamentos (3x/semana)\n2. Aplicar técnica de respiração nos momentos de gatilho\n3. Leitura: cap. 5 do material sobre ansiedade social',
        ProximaSessao: util.fmtDateTime(next104), Tags: ['ansiedade', 'tcc'],
      },
      {
        ID_RC: 2, DataCriacao: d102, DataUltMod: d102, CPF_Paciente: '222.333.444-55', ID_Consulta: 102, CRP_Psicologo: CRP,
        NumeroSessao: 8, DuracaoMin: 50,
        Conteudo: 'Sessão com foco em ativação comportamental e desativação de ciclos de ruminação depressiva.',
        QueixaPrincipal: 'Relatou desânimo matinal e tendência a evitar contatos telefônicos durante o fim de semana.',
        IntervencoesRealizadas: '• Mapeamento de esquemas de inibição emocional\n• Agendamento de atividades prazerosas de baixa exigência',
        ProgressoObservado: 'Conseguiu realizar uma caminhada curta no parque, conforme combinado na sessão anterior. Resistência inicial à reestruturação.',
        TarefasParaCasa: '1. Registrar momentos de satisfação (escala 1 a 10) ao menos 1x ao dia',
        ProximaSessao: 'A confirmar', Tags: ['depressão', 'ruminação'],
      },
      {
        ID_RC: 3, DataCriacao: d103, DataUltMod: d103, CPF_Paciente: '333.444.555-66', ID_Consulta: 103, CRP_Psicologo: CRP,
        NumeroSessao: 12, DuracaoMin: 50,
        Conteudo: 'Conclusão do ciclo inicial de fortalecimento de autoestima.',
        QueixaPrincipal: 'Dúvidas sobre limites nas relações interpessoais familiares.',
        IntervencoesRealizadas: '• Treinamento de assertividade\n• Comunicação não-violenta: role-play de situações familiares',
        ProgressoObservado: 'Progresso notável. Completou todas as tarefas acordadas entre as sessões.',
        TarefasParaCasa: '1. Praticar resposta assertiva em situação de baixa tensão',
        ProximaSessao: util.fmtDateTime(consultas.find((c) => c.ID_Consulta === 111).DataHora), Tags: ['autoestima', 'limites'],
      },
      {
        ID_RC: 4, DataCriacao: d95, DataUltMod: d95, CPF_Paciente: '111.222.333-44', ID_Consulta: 95, CRP_Psicologo: CRP,
        NumeroSessao: 22, DuracaoMin: 50,
        Conteudo: 'Psicoeducação sobre o ciclo da ansiedade.',
        QueixaPrincipal: 'Sintomas físicos de ansiedade (taquicardia, tensão muscular) antes de apresentações.',
        IntervencoesRealizadas: '• Psicoeducação: modelo cognitivo da ansiedade\n• Introdução ao Registro de Pensamentos Disfuncionais (RPD)',
        ProgressoObservado: 'Boa adesão à proposta terapêutica.',
        TarefasParaCasa: '1. Preencher o RPD em 2 situações da semana',
        ProximaSessao: util.fmtDate(d101), Tags: ['ansiedade', 'psicoeducação'],
      },
    ];

    const M = (o) => ({ CRP_Psicologo: CRP, Status: 'Ativa', DataInicio: dateAgo(30), DataFim: dateIn(30), ProgressoPercentual: 0, ...o });
    const metas = [
      M({ ID_Meta: 1, Descricao: 'Praticar mindfulness diariamente', Objetivos: '10 minutos por dia antes de iniciar a jornada de trabalho', CPF_Paciente: '111.222.333-44', Categoria: 'Bem-estar', Prazo: 'Curto',
        Checklist: [{ id: 1, descricao: 'Semana 1 — respiração guiada 5 min', concluido: true }, { id: 2, descricao: 'Semana 2 — atenção plena corporal', concluido: true }, { id: 3, descricao: 'Semana 3 — meditação matinal 10 min', concluido: true }, { id: 4, descricao: 'Semana 4 — prática autônoma de ancoragem', concluido: false }] }),
      M({ ID_Meta: 2, Descricao: 'Exercícios de respiração diafragmática', Objetivos: '3 vezes por semana em pausas programadas', CPF_Paciente: '111.222.333-44', Categoria: 'Ansiedade', Prazo: 'Curto',
        Checklist: [{ id: 1, descricao: 'Prática de terça-feira pós-almoço', concluido: true }, { id: 2, descricao: 'Prática de quinta-feira fim do expediente', concluido: true }, { id: 3, descricao: 'Prática de sábado ao despertar', concluido: false }] }),
      M({ ID_Meta: 3, Descricao: 'Registro de pensamentos (diário de TCC)', Objetivos: 'Anotar situações-gatilho, emoções e pensamentos alternativos', CPF_Paciente: '111.222.333-44', Categoria: 'Terapia Cognitiva', Prazo: 'Médio', DataFim: dateIn(60),
        Checklist: [{ id: 1, descricao: 'Identificar gatilhos de segunda-feira', concluido: true }, { id: 2, descricao: 'Reavaliar pensamento catastrófico de quarta', concluido: true }, { id: 3, descricao: 'Anotar evidências contra e a favor', concluido: true }, { id: 4, descricao: 'Formular pensamento equilibrado', concluido: false }] }),
      M({ ID_Meta: 4, Descricao: 'Aumentar atividades sociais gradualmente', Objetivos: '1 atividade social por semana com rede de apoio', CPF_Paciente: '111.222.333-44', Categoria: 'Plano terapêutico', Prazo: 'Longo', DataFim: dateIn(120),
        Checklist: [{ id: 1, descricao: 'Café presencial com colega de confiança', concluido: true }, { id: 2, descricao: 'Visita à família no fim de semana', concluido: false }] }),
      M({ ID_Meta: 5, Descricao: 'Caminhada diária de 20 minutos', Objetivos: 'Ativação física ao ar livre', CPF_Paciente: '222.333.444-55', Categoria: 'Plano terapêutico', Prazo: 'Curto',
        Checklist: [{ id: 1, descricao: 'Segunda-feira — 20 min', concluido: true }, { id: 2, descricao: 'Quarta-feira — 20 min', concluido: true }, { id: 3, descricao: 'Sexta-feira — 20 min', concluido: false }] }),
      M({ ID_Meta: 6, Descricao: 'Registro diário de humor', Objetivos: 'Escala de 1 a 10 ao final do dia', CPF_Paciente: '222.333.444-55', Categoria: 'Terapia Cognitiva', Prazo: 'Médio',
        Checklist: [{ id: 1, descricao: 'Semana 1', concluido: true }, { id: 2, descricao: 'Semana 2', concluido: false }, { id: 3, descricao: 'Semana 3', concluido: false }, { id: 4, descricao: 'Semana 4', concluido: false }, { id: 5, descricao: 'Semana 5', concluido: false }] }),
      M({ ID_Meta: 7, Descricao: 'Praticar respostas assertivas', Objetivos: 'Aplicar a técnica em 3 situações do cotidiano', CPF_Paciente: '333.444.555-66', Categoria: 'Autoestima', Prazo: 'Médio',
        Checklist: [{ id: 1, descricao: 'Situação no trabalho', concluido: true }, { id: 2, descricao: 'Situação com a família', concluido: true }, { id: 3, descricao: 'Situação com amigos', concluido: true }, { id: 4, descricao: 'Reflexão escrita sobre as experiências', concluido: false }] }),
      M({ ID_Meta: 8, Descricao: 'Diário de autocompaixão', Objetivos: 'Escrever 3 qualidades pessoais por semana', CPF_Paciente: '333.444.555-66', Categoria: 'Autoestima', Prazo: 'Curto', Status: 'Concluida', DataFim: dateAgo(2),
        Checklist: [{ id: 1, descricao: 'Semana 1', concluido: true }, { id: 2, descricao: 'Semana 2', concluido: true }] }),
      M({ ID_Meta: 9, Descricao: 'Técnica de respiração antes de dormir', Objetivos: '5 minutos por noite', CPF_Paciente: '777.888.999-00', Categoria: 'Bem-estar', Prazo: 'Curto',
        Checklist: [{ id: 1, descricao: 'Primeira semana', concluido: true }, { id: 2, descricao: 'Segunda semana', concluido: false }] }),
    ];
    metas.forEach((m) => {
      const done = m.Checklist.filter((i) => i.concluido).length;
      m.ProgressoPercentual = m.Checklist.length ? Math.round((done / m.Checklist.length) * 100) : 0;
    });

    const D = (o) => ({ CRP_Psicologo: CRP, ID_Consulta: null, Armazenamento: 'Google Drive API v3', ConteudoBase64: null, MimeType: 'application/pdf', ...o });
    const documentos = [
      D({ ID_Doc: 1, Tipo: 'Administrativo', Origem: 'Sistema', NomeArquivo: 'Termo de Consentimento (TCLE).pdf', Conteudo: 'Termo de Consentimento Livre e Esclarecido para atendimento psicológico online e presencial.', DataEnvio: dateAgo(40), CPF_Paciente: '111.222.333-44', TamanhoKb: 245, DriveFileId: 'gdrive_tcle_001' }),
      D({ ID_Doc: 2, Tipo: 'Avaliações', Origem: 'Psicóloga', NomeArquivo: 'Avaliação Inicial Neuropsicológica.pdf', Conteudo: 'Avaliação inicial das funções executivas, histórico biopsicossocial e anamnese.', DataEnvio: dateAgo(35), CPF_Paciente: '222.333.444-55', TamanhoKb: 1250, DriveFileId: 'gdrive_av_002', ID_Consulta: 102 }),
      D({ ID_Doc: 3, Tipo: 'Tratamento', Origem: 'Psicóloga', NomeArquivo: 'Plano Terapêutico Singular.pdf', Conteudo: 'Plano terapêutico com metas de curto, médio e longo prazo.', DataEnvio: dateAgo(28), CPF_Paciente: '333.444.555-66', TamanhoKb: 890, DriveFileId: 'gdrive_pts_003', ID_Consulta: 103 }),
      D({ ID_Doc: 4, Tipo: 'Testes', Origem: 'Paciente', NomeArquivo: 'Inventário de Ansiedade (digitalizado).pdf', Conteudo: 'Respostas preenchidas e digitalizadas pelo paciente.', DataEnvio: dateAgo(20), CPF_Paciente: '444.555.666-77', TamanhoKb: 320, DriveFileId: 'gdrive_inv_004' }),
      D({ ID_Doc: 5, Tipo: 'Relatórios', Origem: 'Psicóloga', NomeArquivo: 'Relatório de Acompanhamento.pdf', Conteudo: 'Relatório clínico consolidado de evolução psicológica do mês.', DataEnvio: dateAgo(12), CPF_Paciente: '555.666.777-88', TamanhoKb: 445, DriveFileId: 'gdrive_rel_005' }),
      D({ ID_Doc: 6, Tipo: 'Relatórios', Origem: 'Psicóloga', NomeArquivo: 'Laudo Psicológico — Ana Carolina.pdf', Conteudo: 'Laudo psicológico referente ao acompanhamento em TCC.', DataEnvio: d101, CPF_Paciente: '111.222.333-44', TamanhoKb: 210, DriveFileId: 'gdrive_laudo_006', ID_Consulta: 101 }),
    ];

    const laudosAtestados = [
      { ID_LA: 1, Tipo: 'Laudo', Titulo: 'Laudo Psicológico — Acompanhamento TCC', DataEmissao: d101, ID_Consulta: 101, CPF_Paciente: '111.222.333-44', CRP_Psicologo: CRP,
        Conteudo: 'Atesto, para os devidos fins, que a paciente Ana Carolina Mendes encontra-se em acompanhamento psicológico sob abordagem cognitivo-comportamental, apresentando evolução favorável no manejo de sintomas ansiosos.' },
      { ID_LA: 2, Tipo: 'Atestado', Titulo: 'Atestado de Comparecimento', DataEmissao: d102, ID_Consulta: 102, CPF_Paciente: '222.333.444-55', CRP_Psicologo: CRP,
        Conteudo: 'Declaro, para fins de comprovação, que o paciente Bruno Ferreira compareceu à sessão de atendimento psicológico no período das 09:30 às 10:30.' },
    ];

    // Mensagens sempre no passado (evita horário "futuro" que quebraria a ordem cronológica do chat)
    const msg = (id, daysBack, minutes, texto, rem, dest, lida = true) => {
      const d = daysBack === 0 ? new Date(now.getTime() - (60 - minutes) * 6e4) : new Date(now.getTime() - daysBack * 864e5);
      if (daysBack > 0) d.setHours(10, minutes, 0, 0);
      return { ID_Mensagem: id, DataHora: d.toISOString(), Texto: texto, Remetente: rem, Destinatario: dest, Lida: lida };
    };
    const ANA = '111.222.333-44', BRUNO = '222.333.444-55', CAMILA = '333.444.555-66', DIEGO = '444.555.666-77', ELENA = '555.666.777-88', MARIA = '777.888.999-00';
    const mensagens = [
      msg(1, 0, 10, 'Dra. Shelley, bom dia! Posso me consultar na próxima semana?', ANA, CRP),
      msg(2, 0, 15, 'Olá, Ana! Claro, temos horário na terça às 09h ou quinta às 14h. Qual prefere?', CRP, ANA),
      msg(3, 0, 18, 'Prefiro terça mesmo. Muito obrigada!', ANA, CRP),
      msg(4, 0, 20, 'Perfeito! Envie a solicitação pela Agenda que eu confirmo por lá. Até lá! 😊', CRP, ANA),
      msg(5, 0, 24, 'Obrigada pela indicação do material, Dra.!', ANA, CRP, false),
      msg(6, 1, 5, 'Vejo você na quinta!', BRUNO, CRP),
      msg(7, 1, 30, 'Posso remarcar para a semana que vem?', CAMILA, CRP, false),
      msg(8, 2, 0, 'Fiz as anotações pedidas na última sessão.', DIEGO, CRP),
      msg(9, 3, 0, 'Obrigada pela atenção de sempre.', ELENA, CRP),
      msg(10, 1, 40, 'Olá, Maria! Como você está se sentindo hoje?', CRP, MARIA),
      msg(11, 1, 45, 'Estou melhor! Consegui fazer os exercícios de respiração que você recomendou.', MARIA, CRP),
      msg(12, 1, 50, 'Excelente progresso! Consegue praticar também antes de dormir?', CRP, MARIA),
    ];

    const nowIso = now.toISOString();
    const notificacoes = [
      { id: 'n1', titulo: 'Consulta próxima', mensagem: 'Lembrete: sua sessão com a Dra. Shelley Christina acontece nas próximas horas.', tipo: 'consulta_proxima', dataHora: nowIso, lida: false, destinatarioId: ANA },
      { id: 'n2', titulo: 'Meta terapêutica', mensagem: 'A meta "Praticar mindfulness diariamente" aguarda sua atualização hoje.', tipo: 'meta_ativa', dataHora: nowIso, lida: false, destinatarioId: ANA },
      { id: 'n3', titulo: 'Nova proposta de horário', mensagem: 'A Dra. Shelley sugeriu um novo horário para sua consulta. Confirme na Agenda.', tipo: 'contraproposta_horario', dataHora: nowIso, lida: false, destinatarioId: ANA },
      { id: 'n4', titulo: 'Nova solicitação de agendamento', mensagem: 'Ana Carolina Mendes solicitou uma consulta. Aguardando sua confirmação.', tipo: 'solicitacao_pendente', dataHora: nowIso, lida: false, destinatarioId: CRP },
      { id: 'n5', titulo: 'Nova solicitação de agendamento', mensagem: 'Bruno Ferreira solicitou uma consulta presencial.', tipo: 'solicitacao_pendente', dataHora: nowIso, lida: false, destinatarioId: CRP },
      { id: 'n7', titulo: 'Nova solicitação de cadastro', mensagem: 'Fernanda Costa se cadastrou e aguarda sua aprovação para acessar a plataforma.', tipo: 'cadastro_pendente', dataHora: nowIso, lida: false, destinatarioId: CRP },
      { id: 'n8', titulo: 'Nova solicitação de cadastro', mensagem: 'Lucas Almeida se cadastrou e aguarda sua aprovação para acessar a plataforma.', tipo: 'cadastro_pendente', dataHora: nowIso, lida: true, destinatarioId: CRP },
      { id: 'n6', titulo: 'Teste psicológico pendente', mensagem: 'Você recebeu o questionário PHQ-9 para responder antes da próxima sessão.', tipo: 'teste_pendente', dataHora: nowIso, lida: false, destinatarioId: ANA },
    ];

    // Testes psicológicos: aplicações (as definições dos instrumentos ficam em testes.js)
    const A = (o) => ({ CRP_Psicologo: CRP, Respostas: null, Pontuacao: null, Classificacao: null, DataResposta: null, ...o });
    const aplicacoesTeste = [
      A({ ID_Aplicacao: 1, CodigoTeste: 'GAD7', CPF_Paciente: ANA, Status: 'Respondido', DataAtribuicao: dateAgo(60), DataResposta: dateAgo(58), Respostas: [3, 2, 3, 2, 2, 2, 2], Pontuacao: 16, Classificacao: 'Grave' }),
      A({ ID_Aplicacao: 2, CodigoTeste: 'GAD7', CPF_Paciente: ANA, Status: 'Respondido', DataAtribuicao: dateAgo(32), DataResposta: dateAgo(30), Respostas: [2, 2, 2, 2, 1, 2, 2], Pontuacao: 13, Classificacao: 'Moderada' }),
      A({ ID_Aplicacao: 3, CodigoTeste: 'GAD7', CPF_Paciente: ANA, Status: 'Respondido', DataAtribuicao: dateAgo(9), DataResposta: dateAgo(8), Respostas: [2, 1, 2, 1, 1, 2, 1], Pontuacao: 10, Classificacao: 'Moderada' }),
      A({ ID_Aplicacao: 4, CodigoTeste: 'PHQ9', CPF_Paciente: ANA, Status: 'Pendente', DataAtribuicao: dateAgo(1) }),
      A({ ID_Aplicacao: 5, CodigoTeste: 'PHQ9', CPF_Paciente: BRUNO, Status: 'Respondido', DataAtribuicao: dateAgo(45), DataResposta: dateAgo(44), Respostas: [2, 2, 2, 3, 1, 2, 2, 2, 1], Pontuacao: 17, Classificacao: 'Moderadamente grave' }),
      A({ ID_Aplicacao: 6, CodigoTeste: 'PHQ9', CPF_Paciente: BRUNO, Status: 'Respondido', DataAtribuicao: dateAgo(15), DataResposta: dateAgo(14), Respostas: [2, 2, 1, 2, 1, 2, 2, 2, 0], Pontuacao: 14, Classificacao: 'Moderada' }),
      A({ ID_Aplicacao: 7, CodigoTeste: 'BEMESTAR', CPF_Paciente: CAMILA, Status: 'Respondido', DataAtribuicao: dateAgo(6), DataResposta: dateAgo(5), Respostas: [3, 3, 2, 3, 2, 3], Pontuacao: 16, Classificacao: 'Bom' }),
    ];

    // Anexos de texto por sessão (Registro_Clinico_Anexo) + histórico da sessão (Sessao_Historico)
    const ts = (dateStr, hhmm) => util.combine(dateStr, hhmm);
    const anexosSessao = [
      { ID_Anexo: 1, ID_Consulta: 101, CPF_Paciente: '111.222.333-44', CRP_Psicologo: CRP, NomeArquivo: 'Registro de pensamentos - semana 24.txt', Extensao: 'txt', MimeType: 'text/plain',
        ConteudoTexto: 'REGISTRO DE PENSAMENTOS DISFUNCIONAIS (RPD)\n\nSituação: reunião de segunda-feira com a diretoria.\nEmoção: ansiedade (80%).\nPensamento automático: "Vou travar e todos vão perceber."\nEvidências a favor: já gaguejei uma vez em 2024.\nEvidências contra: apresentei 6 vezes este ano sem problemas.\nPensamento alternativo: "Posso ficar nervosa e ainda assim apresentar bem."\nEmoção após: ansiedade (40%).\n',
        ConteudoBase64: null, Versao: 1, Descricao: 'Tarefa de casa trazida pela paciente', Removido: false, DataEnvio: ts(d101, '09:05'), DataUltMod: ts(d101, '09:05'), EnviadoPor: CRP },
      { ID_Anexo: 2, ID_Consulta: 101, CPF_Paciente: '111.222.333-44', CRP_Psicologo: CRP, NomeArquivo: 'Plano de exposição gradual.txt', Extensao: 'txt', MimeType: 'text/plain',
        ConteudoTexto: 'PLANO DE EXPOSIÇÃO GRADUAL\n\n1. Falar 1 minuto na reunião de equipe (ansiedade esperada: 30%)\n2. Apresentar resultado da semana para o coordenador (50%)\n3. Apresentação para a diretoria (80%)\n\nRegra: só avançar quando a ansiedade cair pela metade na etapa atual.\n',
        ConteudoBase64: null, Versao: 2, Descricao: 'Anotação externa da sessão', Removido: false, DataEnvio: ts(d101, '09:10'), DataUltMod: ts(d101, '18:40'), EnviadoPor: CRP },
      { ID_Anexo: 3, ID_Consulta: 102, CPF_Paciente: '222.333.444-55', CRP_Psicologo: CRP, NomeArquivo: 'Agenda de atividades prazerosas.txt', Extensao: 'txt', MimeType: 'text/plain',
        ConteudoTexto: 'Seg: caminhada 15 min — satisfação 6/10\nTer: ligar para o irmão — 7/10\nQua: —\nQui: cozinhar receita nova — 8/10\n',
        ConteudoBase64: null, Versao: 1, Descricao: '', Removido: false, DataEnvio: ts(d102, '10:40'), DataUltMod: ts(d102, '10:40'), EnviadoPor: CRP },
    ];
    anexosSessao.forEach((a) => { a.TamanhoBytes = new TextEncoder().encode(a.ConteudoTexto).length; });
    const H = (id, idc, dataHora, acao, detalhes) => ({ ID_Historico: id, ID_Consulta: idc, DataHora: dataHora, Acao: acao, UsuarioId: CRP, Detalhes: detalhes });
    const historicoSessao = [
      H(1, 95, ts(d95, '09:00'), 'REGISTRO_CRIADO', 'Anotação clínica da sessão 22 criada'),
      H(2, 101, ts(d101, '09:00'), 'REGISTRO_CRIADO', 'Anotação clínica da sessão 24 criada'),
      H(3, 101, ts(d101, '09:05'), 'ANEXO_ENVIADO', 'Registro de pensamentos - semana 24.txt'),
      H(4, 101, ts(d101, '09:10'), 'ANEXO_ENVIADO', 'Plano de exposição gradual.txt'),
      H(5, 101, ts(d101, '18:40'), 'ANEXO_EDITADO', 'Plano de exposição gradual.txt → versão 2'),
      H(6, 102, ts(d102, '10:30'), 'REGISTRO_CRIADO', 'Anotação clínica da sessão 8 criada'),
      H(7, 102, ts(d102, '10:40'), 'ANEXO_ENVIADO', 'Agenda de atividades prazerosas.txt'),
      H(8, 103, ts(d103, '12:00'), 'REGISTRO_CRIADO', 'Anotação clínica da sessão 12 criada'),
    ];

    // Bloqueios de agenda (BloqueioAgenda): folgas, feriados, congressos…
    const dia = (days, hh = 0, mm = 0, ss = 0) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hh, mm, ss, 0); return d.toISOString(); };
    const B = (id, ini, fim, diaInteiro, motivo, criado) => ({ ID_Bloqueio: id, CRP_Psicologo: CRP, Data_Inicio: ini, Data_Fim: fim, DiaInteiro: diaInteiro, Motivo: motivo, CriadoEm: criado, AtualizadoEm: criado });
    const bloqueios = [
      B(1, dia(-40), dia(-31, 23, 59, 59), true, 'Férias', dia(-70, 10)),
      B(2, dia(7, 13), dia(7, 18), false, 'Compromisso pessoal', dia(-2, 11)),
      B(3, dia(8), dia(10, 23, 59, 59), true, 'Congresso Brasileiro de Psicologia', dia(-20, 9)),
      B(4, dia(15), dia(15, 23, 59, 59), true, 'Feriado municipal', dia(-5, 16)),
    ];

    return {
      schemaVersion: 4,
      seededAt: nowIso,
      config: { driveOnline: true, driveUploads: 0, localFallbacks: 0 },
      seq: { consulta: 200, meta: 20, documento: 20, laudo: 10, registro: 10, mensagem: 100, aplicacao: 20, auditoria: 1, anexo: 10, historico: 20, bloqueio: 10 },
      anexosSessao, historicoSessao, bloqueios,
      psicologo, equipe, pacientes, consultas, registrosClinicos, metas, documentos, laudosAtestados, mensagens, notificacoes, aplicacoesTeste,
      auditoria: [],
    };
  }

  /* =====================================================================
     4. STORE — persistência + eventos + sincronização entre abas
     ===================================================================== */
  const storage = {
    get(key, area = localStorage) {
      try { const raw = area.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
    },
    set(key, value, area = localStorage) {
      try { area.setItem(key, JSON.stringify(value)); return true; } catch (e) { console.warn('[PRISMA] Falha ao persistir', e); return false; }
    },
  };
  PRISMA.storage = storage;

  let channel = null;
  try { channel = new BroadcastChannel('prisma'); } catch (e) { /* navegador sem suporte */ }

  function loadDb() {
    const saved = storage.get(STORAGE_KEY);
    if (saved && saved.schemaVersion === 4) {
      // Migração em memória: estruturas novas sem apagar os dados já existentes no navegador
      if (!saved.anexosSessao) saved.anexosSessao = createSeed().anexosSessao;
      if (!saved.historicoSessao) saved.historicoSessao = createSeed().historicoSessao;
      saved.seq.anexo = Math.max(saved.seq.anexo || 0, 10);
      saved.seq.historico = Math.max(saved.seq.historico || 0, 20);
      // Bloqueios de agenda + prazos de 48 h / 36 h (versão 3 do módulo de agenda)
      if (!saved.bloqueios) saved.bloqueios = createSeed().bloqueios;
      saved.seq.bloqueio = Math.max(saved.seq.bloqueio || 0, 10);
      const PRAZOS = { AntecedenciaAgendamentoHoras: 48, AntecedenciaReagendamentoHoras: 48, PrazoConfirmacaoHoras: 36, LembreteConfirmacaoHoras: 24 };
      Object.entries(PRAZOS).forEach(([k, v]) => { if (saved.psicologo[k] == null) saved.psicologo[k] = v; });
      saved.consultas.forEach((c) => {
        if (c.StatusConfirmacao === undefined) {
          c.StatusConfirmacao = c.Status === 'Agendada' ? 'AGUARDANDO' : c.Status === 'Realizada' ? 'CONFIRMADA' : null;
          Object.assign(c, { ConfirmadaEm: null, ConfirmadaPor: null, ConfirmacaoTardia: false, LembreteConfirmacaoEm: null, AlertaConfirmacaoEm: null });
        }
      });
      if (saved.config) delete saved.config.respostaSimuladaChat; // respostas automáticas do chat removidas
      // Mensagens com horário no futuro (seed antigo) quebravam a ordem do chat: desloca-as para o passado
      const agora = Date.now();
      const maisFutura = Math.max(0, ...saved.mensagens.map((m) => new Date(m.DataHora).getTime()));
      if (maisFutura > agora) {
        const delta = maisFutura - agora + 6e4;
        saved.mensagens.forEach((m) => { const t = new Date(m.DataHora).getTime(); if (t > agora - 864e5) m.DataHora = new Date(t - delta).toISOString(); });
      }
      return saved;
    }
    const fresh = createSeed();
    storage.set(STORAGE_KEY, fresh);
    return fresh;
  }
  PRISMA.db = loadDb();

  /** Gera o próximo ID de uma sequência (equivalente ao AUTO_INCREMENT). */
  PRISMA.nextId = function (seqName, db = PRISMA.db) {
    db.seq[seqName] = (db.seq[seqName] || 0) + 1;
    return db.seq[seqName];
  };

  function emit(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail })); }

  /** Persiste o estado e notifica a página atual e as demais abas. */
  PRISMA.save = function (reason = 'update') {
    storage.set(STORAGE_KEY, PRISMA.db);
    emit('prisma:change', { reason, local: true });
    if (channel) channel.postMessage({ type: 'db-change', reason });
  };

  /** Persiste sem disparar re-renderização (ex.: registros de auditoria de leitura). */
  PRISMA.persist = function () { storage.set(STORAGE_KEY, PRISMA.db); };

  PRISMA.resetDemo = function () {
    PRISMA.db = createSeed();
    PRISMA.save('reset');
  };

  // Outra aba alterou o banco → recarrega
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try { PRISMA.db = JSON.parse(e.newValue); emit('prisma:change', { reason: 'remote', local: false }); } catch (err) { /* ignora */ }
    }
  });
  if (channel) {
    channel.onmessage = (ev) => {
      const data = ev.data || {};
      if (data.type === 'db-change') {
        const fresh = storage.get(STORAGE_KEY);
        if (fresh) { PRISMA.db = fresh; emit('prisma:change', { reason: 'remote', local: false }); }
      } else {
        emit('prisma:broadcast', data);
      }
    };
  }
  PRISMA.broadcast = (payload) => { if (channel) channel.postMessage(payload); };

  /* =====================================================================
     5. SESSÃO / AUTENTICAÇÃO
     A sessão é criada somente pela tela de login (pages/login.html → auth.js).
       • sem "Lembrar-me": sessionStorage (expira ao fechar a aba, máx. 8 h)
       • com "Lembrar-me": localStorage (30 dias)
     Toda página valida a sessão ao carregar e a cada alteração do banco:
     se a conta deixar de estar ATIVA (ex.: inativada), o usuário é desconectado.
     ===================================================================== */
  function readSession() {
    const s = storage.get(SESSION_KEY, sessionStorage) || storage.get(SESSION_KEY);
    if (!s || !s.role || !s.id) return null;
    if (s.expiraEm && new Date(s.expiraEm).getTime() < Date.now()) { PRISMA.clearSession(); return null; }
    return s;
  }
  PRISMA.clearSession = function () {
    try { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignora */ }
    PRISMA.session = null;
  };
  /** Chamado pelo login após validar credenciais e status da conta. */
  PRISMA.startSession = function ({ role, id }, lembrar = false) {
    const agora = Date.now();
    const s = { role, id, lembrar: !!lembrar, inicio: new Date(agora).toISOString(), expiraEm: new Date(agora + (lembrar ? 30 * 864e5 : 8 * 36e5)).toISOString() };
    PRISMA.clearSession();
    storage.set(SESSION_KEY, s, lembrar ? localStorage : sessionStorage);
    PRISMA.session = s;
    return s;
  };
  PRISMA.session = readSession();

  /** Conta (psicólogo ou paciente) por identificador — CRP ou CPF */
  PRISMA.conta = function (role, id, db = PRISMA.db) {
    if (role === 'psicologo') {
      if (db.psicologo.CRP === id) return db.psicologo;
      return (db.equipe || []).find((x) => x.CRP === id) || null;
    }
    return db.pacientes.find((x) => x.CPF === id) || null;
  };

  /** Usuário autenticado no formato { tipo, id, nome, email, isAdmin } — null se não houver sessão válida */
  PRISMA.currentUser = function (db = PRISMA.db, session = PRISMA.session) {
    if (!session) return null;
    const c = PRISMA.conta(session.role, session.id, db);
    if (!c || c.Status !== 'ATIVO') return null;
    return session.role === 'psicologo'
      ? { tipo: 'psicologo', id: c.CRP, nome: c.Nome, email: c.Email, isAdmin: !!c.IsAdmin }
      : { tipo: 'paciente', id: c.CPF, nome: c.Nome, email: c.Email, isAdmin: false };
  };
  PRISMA.isPsicologa = () => !!PRISMA.session && PRISMA.session.role === 'psicologo';

  PRISMA.logout = function (motivo) {
    const u = PRISMA.currentUser();
    if (u) { PRISMA.core.audit(PRISMA.db, u, 'LOGOUT', motivo || 'Sessão encerrada pelo usuário', true); PRISMA.persist(); }
    PRISMA.clearSession();
    location.href = PRISMA.url('login', motivo ? `msg=${encodeURIComponent(motivo)}` : '');
  };

  /* ---------- Helpers de consulta ao banco ---------- */
  PRISMA.q = {
    paciente: (cpf, db = PRISMA.db) => db.pacientes.find((p) => p.CPF === cpf),
    pacienteNome: (cpf, db = PRISMA.db) => (db.pacientes.find((p) => p.CPF === cpf) || {}).Nome || 'Paciente',
    /** Apenas pacientes com cadastro aprovado participam do atendimento */
    pacientesAtivos: (db = PRISMA.db) => db.pacientes.filter((p) => p.Status === 'ATIVO'),
    consulta: (id, db = PRISMA.db) => db.consultas.find((c) => c.ID_Consulta === Number(id)),
    nomeUsuario(id, db = PRISMA.db) {
      if (id === db.psicologo.CRP) return db.psicologo.Nome;
      const outro = (db.equipe || []).find((x) => x.CRP === id);
      if (outro) return outro.Nome;
      if (id === 'sistema') return 'Sistema';
      return PRISMA.q.pacienteNome(id, db);
    },
  };

  /* =====================================================================
     6. NÚCLEO — auditoria (LGPD) e notificações (FCM simulado)
     Recebem `db` explicitamente para funcionar também em sandbox (CTs).
     ===================================================================== */
  PRISMA.core = {
    audit(db, user, acao, detalhes, sucesso = true) {
      db.auditoria.unshift({
        ID_Auditoria: PRISMA.nextId('auditoria', db),
        DataHora: new Date().toISOString(),
        Acao: acao,
        UsuarioId: user ? user.id : 'sistema',
        UsuarioTipo: user ? user.tipo : 'sistema',
        Detalhes: detalhes,
        Sucesso: !!sucesso,
      });
      if (db.auditoria.length > 300) db.auditoria.length = 300;
    },
    notify(db, destinatarioId, titulo, mensagem, tipo = 'sistema') {
      db.notificacoes.unshift({
        id: `n${Date.now()}${Math.floor(Math.random() * 1000)}`,
        titulo, mensagem, tipo,
        dataHora: new Date().toISOString(),
        lida: false,
        destinatarioId,
      });
      if (db.notificacoes.length > 150) db.notificacoes.length = 150;
    },
    /** Erro de regra de negócio (equivale a SIGNAL SQLSTATE '45000') */
    RuleError: class RuleError extends Error {
      constructor(message, regra) { super(message); this.name = 'RuleError'; this.regra = regra; }
    },
  };

  /* =====================================================================
     7. COMPONENTES DE UI
     ===================================================================== */
  const ui = {};

  ui.toast = function (message, type = 'success', ms = 3600) {
    let wrap = util.$('.toasts');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toasts'; wrap.setAttribute('role', 'status'); document.body.appendChild(wrap); }
    const icon = { success: 'check-circle', error: 'x-circle', warning: 'alert', info: 'info' }[type] || 'info';
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `${PRISMA.icon(icon, 18)}<div>${util.esc(message)}</div>`;
    wrap.appendChild(el);
    setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 220); }, ms);
  };

  /**
   * Modal genérico.
   * @param {object} o { title, subtitle, body (html), size: 'sm'|'lg', actions: [{label, variant, onClick(close, el), type}] , onOpen(el) }
   */
  ui.modal = function (o) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ${o.size || ''}" role="dialog" aria-modal="true" aria-label="${util.esc(o.title)}">
        <div class="modal-head">
          <div><h2>${util.esc(o.title)}</h2>${o.subtitle ? `<p>${util.esc(o.subtitle)}</p>` : ''}</div>
          <button class="icon-btn sm" data-close aria-label="Fechar">${PRISMA.icon('x', 18)}</button>
        </div>
        <div class="modal-body">${o.body || ''}</div>
        ${o.actions && o.actions.length ? '<div class="modal-foot"></div>' : ''}
      </div>`;
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); if (o.onClose) o.onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('[data-close]').addEventListener('click', close);
    const foot = overlay.querySelector('.modal-foot');
    (o.actions || []).forEach((a) => {
      const b = document.createElement('button');
      b.type = a.type || 'button';
      b.className = `btn ${a.variant || 'btn-outline'}`;
      b.innerHTML = (a.icon ? PRISMA.icon(a.icon, 16) : '') + util.esc(a.label);
      if (a.form) b.setAttribute('form', a.form);
      b.addEventListener('click', (ev) => { if (a.onClick) a.onClick(close, overlay, ev); else if (!a.form) close(); });
      foot.appendChild(b);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    const first = overlay.querySelector('input:not([type=hidden]):not([readonly]), select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
    if (o.onOpen) o.onOpen(overlay, close);
    return { el: overlay, close };
  };

  /**
   * Modal com formulário. onSubmit(data, form, el) pode lançar Error → mensagem exibida no topo do form.
   * Retornar false mantém o modal aberto.
   */
  ui.formModal = function (o) {
    const formId = `f${Date.now()}`;
    const m = ui.modal({
      title: o.title, subtitle: o.subtitle, size: o.size, onOpen: o.onOpen,
      body: `<form id="${formId}" novalidate><div class="form-error" hidden></div>${o.body}</form>`,
      actions: [
        { label: 'Cancelar', variant: 'btn-ghost' },
        { label: o.submitLabel || 'Salvar', variant: o.submitVariant || 'btn-dark', type: 'submit', form: formId, icon: o.submitIcon },
      ],
    });
    const form = m.el.querySelector('form');
    const errBox = form.querySelector('.form-error');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      errBox.hidden = true;
      const missing = Array.from(form.querySelectorAll('[required]')).find((f) => !String(f.value).trim());
      if (missing) {
        errBox.innerHTML = `${PRISMA.icon('alert', 16)}<span>Preencha o campo obrigatório: ${util.esc(missing.dataset.label || missing.name)}</span>`;
        errBox.hidden = false; missing.focus(); return;
      }
      try {
        const r = o.onSubmit(util.formData(form), form, m.el);
        if (r !== false) m.close();
      } catch (err) {
        errBox.innerHTML = `${PRISMA.icon('alert', 16)}<span>${util.esc(err.message)}</span>`;
        errBox.hidden = false;
        errBox.scrollIntoView({ block: 'nearest' });
      }
    });
    return m;
  };

  ui.confirm = function ({ title, message, confirmLabel = 'Confirmar', variant = 'btn-dark', onConfirm }) {
    return ui.modal({
      title, size: 'sm',
      body: `<p class="text-2">${message}</p>`,
      actions: [
        { label: 'Voltar', variant: 'btn-ghost' },
        { label: confirmLabel, variant, onClick: (close) => { try { onConfirm(); close(); } catch (e) { ui.toast(e.message, 'error'); } } },
      ],
    });
  };

  const AVATAR_COLORS = ['#6366f1', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#22c55e', '#ef4444'];
  ui.avatar = function (nome, size = '', extra = '') {
    const ini = util.initials(nome);
    const idx = [...String(nome)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
    const bg = nome && nome.startsWith('Dra') ? 'var(--grad)' : AVATAR_COLORS[idx];
    return `<span class="avatar ${size} ${extra}" style="background:${bg}" aria-hidden="true">${util.esc(ini)}</span>`;
  };

  const STATUS_MAP = {
    Agendada: ['badge-success', 'Agendada'],
    Pendente: ['badge-warning', 'Pendente'],
    Aguardando_Paciente: ['badge-violet', 'Aguardando paciente'],
    Realizada: ['badge-info', 'Realizada'],
    Cancelada: ['badge-neutral', 'Cancelada'],
    Recusada: ['badge-danger', 'Recusada'],
    Faltou: ['badge-danger', 'Faltou'],
    Ativa: ['badge-info', 'Ativa'],
    Concluida: ['badge-success', 'Concluída'],
    Respondido: ['badge-success', 'Respondido'],
    PENDENTE_APROVACAO: ['badge-warning', 'Aguardando aprovação'],
    CONFIRMADA: ['badge-success', 'Presença confirmada'],
    AGUARDANDO: ['badge-neutral', 'Aguardando confirmação'],
    LEMBRETE: ['badge-warning', 'Confirmação pendente'],
    PENDENTE_CONFIRMACAO: ['badge-danger', 'Pendente de confirmação'],
    ATIVO: ['badge-success', 'Ativo'],
    REJEITADO: ['badge-danger', 'Rejeitado'],
    INATIVO: ['badge-neutral', 'Inativo'],
  };
  ui.statusBadge = function (status) {
    const [cls, label] = STATUS_MAP[status] || ['badge-neutral', status];
    return `<span class="badge ${cls}">${util.esc(label)}</span>`;
  };
  ui.statusLabel = (status) => (STATUS_MAP[status] || [null, status])[1];
  ui.progress = (pct, cls = '') => `<div class="progress ${cls}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`;
  ui.empty = (icon, title, message = '') => `<div class="empty"><div class="ic">${PRISMA.icon(icon, 22)}</div><div class="t">${util.esc(title)}</div>${message ? `<div class="m">${util.esc(message)}</div>` : ''}</div>`;
  ui.denied = (message) => `
    <div class="card denied">
      <div class="ic">${PRISMA.icon('lock', 28)}</div>
      <h1 class="h2">Acesso restrito</h1>
      <p class="text-2 mt-8">${util.esc(message)}</p>
      <p class="text-xs text-muted mt-12">Tentativa registrada na auditoria (LGPD · Código de Ética Profissional do Psicólogo).</p>
      <a class="btn btn-dark mt-16" href="${PRISMA.url('index')}">${PRISMA.icon('home', 16)} Voltar ao início</a>
    </div>`;

  /** Download de arquivo gerado no cliente */
  ui.download = function (filename, content, mime = 'text/plain;charset=utf-8') {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  PRISMA.ui = ui;

  /* =====================================================================
     8. SHELL — sidebar, drawer mobile, topbar, bottom nav
     ===================================================================== */
  const NAV = [
    { id: 'index', label: 'Início', icon: 'home', path: 'index.html' },
    { id: 'agenda', label: 'Agenda', icon: 'calendar', path: 'pages/agenda.html' },
    { id: 'metas', label: 'Metas', icon: 'target', path: 'pages/metas.html' },
    { id: 'documentos', label: 'Documentos', icon: 'file', path: 'pages/documentos.html' },
    { id: 'chat', label: 'Chat', icon: 'message', path: 'pages/chat.html' },
    { id: 'anotacoes', label: 'Prontuário', icon: 'clipboard', path: 'pages/anotacoes.html', roles: ['psicologo'] },
    { id: 'testes', label: 'Testes', icon: 'test', path: 'pages/testes.html' },
    { id: 'configuracoes', label: 'Configurações', icon: 'settings', path: 'pages/configuracoes.html', section: 'Preferências' },
    { id: 'login', label: 'Entrar', icon: 'user', path: 'pages/login.html', hidden: true },
  ];
  PRISMA.NAV = NAV;

  /** URL relativa de uma página a partir da página atual (funciona via file://) */
  PRISMA.url = function (id, query = '') {
    const root = (document.body && document.body.dataset.root) || '.';
    const item = NAV.find((n) => n.id === id);
    return `${root}/${item ? item.path : 'index.html'}${query ? `?${query}` : ''}`;
  };

  function badgeCounts(db, user) {
    const unreadMsgs = db.mensagens.filter((m) => m.Destinatario === user.id && !m.Lida).length;
    const pendentes = user.tipo === 'psicologo'
      ? db.consultas.filter((c) => c.Status === 'Pendente').length
      : db.consultas.filter((c) => c.CPF_Paciente === user.id && c.Status === 'Aguardando_Paciente').length;
    const testes = user.tipo === 'paciente' ? db.aplicacoesTeste.filter((a) => a.CPF_Paciente === user.id && a.Status === 'Pendente').length : 0;
    // Solicitações de cadastro aguardando aprovação (pacientes; profissionais só para o administrador)
    const cadastros = user.tipo === 'psicologo'
      ? db.pacientes.filter((p) => p.Status === 'PENDENTE_APROVACAO').length
        + (user.isAdmin ? (db.equipe || []).filter((x) => x.Status === 'PENDENTE_APROVACAO').length : 0)
      : 0;
    return { chat: unreadMsgs, agenda: pendentes, testes, index: cadastros };
  }

  const shell = {
    notifOpen: false,

    init() {
      const page = document.body.dataset.page;
      const sidebar = util.$('#sidebar');
      const topbar = util.$('#topbar');
      if (!sidebar || !topbar) return;

      if (!util.$('.drawer-overlay')) {
        const ov = document.createElement('div');
        ov.className = 'drawer-overlay';
        ov.addEventListener('click', () => shell.toggleDrawer(false));
        document.body.appendChild(ov);
      }
      if (!util.$('.bottom-nav')) {
        const bn = document.createElement('nav');
        bn.className = 'bottom-nav'; bn.setAttribute('aria-label', 'Navegação inferior');
        document.body.appendChild(bn);
      }
      shell.render();

      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { shell.toggleDrawer(false); shell.toggleNotif(false); } });
      document.addEventListener('click', (e) => {
        if (shell.notifOpen && !e.target.closest('.bell-wrap')) shell.toggleNotif(false);
      });
      window.addEventListener('resize', util.debounce(() => { if (window.innerWidth >= 1024) shell.toggleDrawer(false); }, 150));
      document.title = `${(NAV.find((n) => n.id === page) || { label: 'PRISMA' }).label} · PRISMA`;
    },

    render() {
      const db = PRISMA.db;
      const user = PRISMA.currentUser();
      const page = document.body.dataset.page;
      const counts = badgeCounts(db, user);
      const visible = NAV.filter((n) => !n.hidden && (!n.roles || n.roles.includes(user.tipo)));

      // ---- Sidebar ----
      let lastSection = null;
      const links = visible.map((n) => {
        let sec = '';
        if (n.section && n.section !== lastSection) { sec = `<div class="nav-section">${n.section}</div>`; lastSection = n.section; }
        const count = counts[n.id] || 0;
        return `${sec}<a class="nav-link ${n.id === page ? 'active' : ''}" href="${PRISMA.url(n.id)}" ${n.id === page ? 'aria-current="page"' : ''}>
          ${PRISMA.icon(n.icon, 18)}<span>${n.label}</span>${count ? `<span class="nav-badge">${count}</span>` : ''}</a>`;
      }).join('');
      const sub = user.tipo === 'psicologo' ? `CRP ${user.id}${user.isAdmin ? ' · admin' : ''}` : 'Paciente';
      util.$('#sidebar').innerHTML = `
        <div class="brand">
          <span class="brand-logo">${PRISMA.icon('prism', 18)}</span>
          <div><div class="brand-name">PRISMA</div><div class="brand-tag">Metas assistidas</div></div>
          <button class="icon-btn sm menu-btn" style="margin-left:auto" data-drawer-close aria-label="Fechar menu">${PRISMA.icon('x', 18)}</button>
        </div>
        <nav class="nav" aria-label="Navegação principal">
          <div class="nav-section" style="padding-top:0">Módulos</div>
          ${links}
        </nav>
        <div class="user-card">
          ${ui.avatar(user.nome)}
          <div class="meta"><div class="name truncate">${util.esc(user.nome)}</div><div class="sub">${util.esc(sub)}</div></div>
          <button class="icon-btn sm" data-logout title="Sair" aria-label="Sair da conta">${PRISMA.icon('logout', 16)}</button>
        </div>`;

      // ---- Topbar ----
      const nav = NAV.find((n) => n.id === page) || { label: '' };
      const myNotifs = db.notificacoes.filter((n) => n.destinatarioId === user.id);
      const unread = myNotifs.filter((n) => !n.lida).length;
      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      util.$('#topbar').innerHTML = `
        <button class="icon-btn menu-btn" data-drawer-open aria-label="Abrir menu">${PRISMA.icon('menu', 20)}</button>
        <div class="crumbs"><strong>PRISMA</strong><span class="crumb-page">/</span><span class="crumb-page">${util.esc(nav.label)}</span></div>
        <div class="topbar-actions">
          <span class="role-pill hide-mobile" title="Perfil autenticado">${PRISMA.icon(user.tipo === 'psicologo' ? 'shield' : 'user', 14)} ${user.tipo === 'psicologo' ? 'Psicóloga' : 'Paciente'}</span>
          <button class="icon-btn hide-mobile" data-theme-toggle title="Alternar tema" aria-label="Alternar tema">${PRISMA.icon(theme === 'dark' ? 'sun' : 'moon', 18)}</button>
          <div class="bell-wrap" style="position:relative">
            <button class="icon-btn bell" data-bell aria-label="Notificações">${PRISMA.icon('bell', 19)}${unread ? `<span class="dot">${unread}</span>` : ''}</button>
            <div class="notif-panel" data-notif-panel ${shell.notifOpen ? '' : 'hidden'}>
              <header><strong>Notificações</strong>${unread ? '<button class="btn btn-ghost btn-sm" data-read-all>Marcar todas como lidas</button>' : ''}</header>
              <div class="notif-list">${myNotifs.length ? myNotifs.slice(0, 25).map(shell.notifItem).join('') : ui.empty('bell', 'Tudo em dia', 'Nenhuma notificação por aqui.')}</div>
            </div>
          </div>
          <button class="icon-btn" data-logout title="Sair" aria-label="Sair da conta">${PRISMA.icon('logout', 18)}</button>
        </div>`;

      // ---- Bottom nav (mobile) ----
      const bottomIds = user.tipo === 'psicologo' ? ['index', 'agenda', 'metas', 'chat', 'anotacoes'] : ['index', 'agenda', 'metas', 'chat', 'testes'];
      const bn = util.$('.bottom-nav');
      if (bn) {
        bn.innerHTML = bottomIds.map((id) => {
          const n = NAV.find((x) => x.id === id);
          return `<a href="${PRISMA.url(id)}" class="${id === page ? 'active' : ''}">${PRISMA.icon(n.icon, 20)}<span>${n.label}</span></a>`;
        }).join('');
      }
      shell.bind();
    },

    notifItem(n) {
      const icon = { consulta_proxima: 'clock', meta_ativa: 'target', solicitacao_pendente: 'calendar', consulta_confirmada: 'check-circle', solicitacao_recusada: 'x-circle', contraproposta_horario: 'swap', proposta_aceita: 'check-circle', teste_pendente: 'test', mensagem: 'message', documento: 'file', cadastro_pendente: 'users', cadastro_aprovado: 'check-circle', confirmacao_pendente: 'clock', confirmacao_atrasada: 'alert', presenca_confirmada: 'check-circle', agenda_bloqueada: 'lock' }[n.tipo] || 'bell';
      return `<div class="notif-item ${n.lida ? '' : 'unread'}" data-notif="${util.esc(n.id)}">
        <div class="ic">${PRISMA.icon(icon, 16)}</div>
        <div class="grow"><div class="t">${util.esc(n.titulo)}</div><div class="m">${util.esc(n.mensagem)}</div><div class="d">${util.relTime(n.dataHora)}</div></div>
      </div>`;
    },

    bind() {
      const top = util.$('#topbar');
      const side = util.$('#sidebar');
      top.querySelector('[data-drawer-open]').onclick = () => shell.toggleDrawer(true);
      const closeBtn = side.querySelector('[data-drawer-close]');
      if (closeBtn) closeBtn.onclick = () => shell.toggleDrawer(false);


      top.querySelector('[data-theme-toggle]').onclick = () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        PRISMA.setTheme(next);
      };
      top.querySelector('[data-bell]').onclick = (e) => { e.stopPropagation(); shell.toggleNotif(!shell.notifOpen); };
      const readAll = top.querySelector('[data-read-all]');
      if (readAll) readAll.onclick = (e) => {
        e.stopPropagation();
        const u = PRISMA.currentUser();
        PRISMA.db.notificacoes.forEach((n) => { if (n.destinatarioId === u.id) n.lida = true; });
        PRISMA.save('notificacoes');
      };
      top.querySelectorAll('[data-notif]').forEach((el) => {
        el.onclick = (e) => {
          e.stopPropagation();
          const n = PRISMA.db.notificacoes.find((x) => x.id === el.dataset.notif);
          if (n && !n.lida) { n.lida = true; PRISMA.save('notificacoes'); }
          const target = { solicitacao_pendente: 'agenda', consulta_confirmada: 'agenda', solicitacao_recusada: 'agenda', contraproposta_horario: 'agenda', proposta_aceita: 'agenda', consulta_proxima: 'agenda', meta_ativa: 'metas', teste_pendente: 'testes', mensagem: 'chat', documento: 'documentos', cadastro_pendente: 'index', confirmacao_pendente: 'agenda', confirmacao_atrasada: 'agenda', presenca_confirmada: 'agenda', agenda_bloqueada: 'agenda' }[n && n.tipo];
          if (target && target !== document.body.dataset.page) location.href = PRISMA.url(target);
        };
      });
      util.$$('[data-logout]').forEach((b) => { b.onclick = () => shell.confirmLogout(); });
    },

    confirmLogout() {
      ui.confirm({ title: 'Sair do PRISMA', message: 'Deseja encerrar sua sessão neste navegador?', confirmLabel: 'Sair', onConfirm: () => PRISMA.logout() });
    },

    toggleDrawer(open) { document.body.classList.toggle('drawer-open', open); },
    toggleNotif(open) {
      shell.notifOpen = open;
      const p = util.$('[data-notif-panel]');
      if (p) p.hidden = !open;
    },
  };
  PRISMA.shell = shell;

  /* ---------- Tema ---------- */
  PRISMA.prefs = storage.get(PREFS_KEY) || { theme: 'light', notificacoes: { consultas: true, metas: true, mensagens: true } };
  PRISMA.setTheme = function (theme) {
    document.documentElement.dataset.theme = theme;
    PRISMA.prefs.theme = theme;
    storage.set(PREFS_KEY, PRISMA.prefs);
    shell.render();
    emit('prisma:theme', theme);
  };
  PRISMA.savePrefs = () => storage.set(PREFS_KEY, PRISMA.prefs);
  document.documentElement.dataset.theme = PRISMA.prefs.theme || 'light';

  /* =====================================================================
     9. REGISTRO DE PÁGINAS
     PRISMA.page({ roles, deniedMessage, init(), render() })
       - init: executado uma vez (bind de eventos estáticos)
       - render: executado na carga e sempre que o banco ou o perfil mudar
     ===================================================================== */
  /** Redireciona para o login se não houver sessão válida (ou a conta deixou de estar ATIVA). */
  PRISMA.requireAuth = function () {
    if (PRISMA.currentUser()) return true;
    const had = !!PRISMA.session;
    PRISMA.clearSession();
    const here = location.pathname.split('/').slice(-2).join('/');
    const next = encodeURIComponent(document.body.dataset.page === 'index' ? 'index.html' : here);
    const msg = had ? '&msg=' + encodeURIComponent('Sua sessão expirou ou a conta não está mais ativa. Entre novamente.') : '';
    location.replace(PRISMA.url('login', `next=${next}${msg}`));
    return false;
  };

  /**
   * Automações (equivalem aos EVENTs do MySQL): cada módulo registra uma função
   * fn(db) → nº de alterações. Rodam ao abrir a página, a cada minuto e a cada
   * mudança no banco. Ex.: agenda.js → lembrete/alerta de confirmação (36 h).
   */
  PRISMA.automacoes = [];
  PRISMA.executarAutomacoes = function () {
    let n = 0;
    for (const fn of PRISMA.automacoes) {
      try { n += Number(fn(PRISMA.db)) || 0; } catch (e) { console.warn('[PRISMA] Falha na automação', e); }
    }
    if (n) { storage.set(STORAGE_KEY, PRISMA.db); if (channel) channel.postMessage({ type: 'db-change', reason: 'automacao' }); }
    return n;
  };

  PRISMA.page = function (controller) {
    const start = () => {
      if (!PRISMA.requireAuth()) return;
      PRISMA.executarAutomacoes();
      shell.init();
      const view = util.$('#view');
      let initialized = false;
      let deniedMarkup = null;

      const run = () => {
        const user = PRISMA.currentUser();
        if (controller.roles && !controller.roles.includes(user.tipo)) {
          if (!deniedMarkup) {
            deniedMarkup = view.innerHTML;
            PRISMA.core.audit(PRISMA.db, user, 'ACESSO_NEGADO', `Tentativa de acesso à página "${document.body.dataset.page}"`, false);
            storage.set(STORAGE_KEY, PRISMA.db);
          }
          view.innerHTML = ui.denied(controller.deniedMessage || 'Seu perfil não tem permissão para acessar este módulo.');
          return;
        }
        if (deniedMarkup) { view.innerHTML = deniedMarkup; deniedMarkup = null; initialized = false; }
        try {
          if (!initialized) { if (controller.init) controller.init(); initialized = true; }
          if (controller.render) controller.render();
        } catch (err) {
          console.error('[PRISMA] Erro ao renderizar a página:', err);
          ui.toast('Erro ao renderizar a página. Veja o console.', 'error');
        }
      };

      const refresh = () => { if (!PRISMA.requireAuth()) return; PRISMA.executarAutomacoes(); shell.render(); run(); };
      window.addEventListener('prisma:change', refresh);
      window.addEventListener('prisma:session', refresh);
      // Logout/login feito em outra aba
      window.addEventListener('storage', (e) => { if (e.key === SESSION_KEY) { PRISMA.session = readSession(); refresh(); } });
      setInterval(() => { if (PRISMA.executarAutomacoes()) refresh(); }, 60000);
      run();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  };
})();
