/* =========================================================================
   PRISMA — chat.js
   Service (mensagens) + controlador da central de Chat.

   Tempo real (sem respostas automáticas/sintéticas):
     • As mensagens são trocadas apenas entre usuários reais (psicóloga ⇄ paciente).
     • Janelas diferentes do navegador sincronizam via BroadcastChannel/storage
       (entre como psicóloga em uma janela e como paciente em outra).
     • O indicador "digitando…" é transmitido entre as janelas.
   Ordenação: cronológica ascendente (mais antigas no topo, mais recentes no
   rodapé), com rolagem automática até o final ao enviar/receber mensagens —
   o mesmo contrato da API GET /api/chat/mensagens/:usuarioId (ORDER BY ASC).
   Regras: Mensagem.Texto VARCHAR(500); paciente conversa apenas com a
   psicóloga responsável (LGPD).
   ========================================================================= */
(function (P) {
  'use strict';
  const { util, core } = P;
  const { RuleError } = core;
  const MAX = 500;

  /* =====================================================================
     SERVICE
     ===================================================================== */
  const service = {
    MAX,

    /** Conversa entre dois usuários em ordem cronológica ASCENDENTE (desempate por ID). */
    thread(db, a, b) {
      return db.mensagens
        .filter((m) => (m.Remetente === a && m.Destinatario === b) || (m.Remetente === b && m.Destinatario === a))
        .sort((x, y) => (new Date(x.DataHora) - new Date(y.DataHora)) || (x.ID_Mensagem - y.ID_Mensagem));
    },

    conversas(db, user) {
      const contatos = user.tipo === 'psicologo'
        ? P.q.pacientesAtivos(db).map((p) => ({ id: p.CPF, nome: p.Nome, sub: p.Email }))
        : [{ id: db.psicologo.CRP, nome: db.psicologo.Nome, sub: `Psicóloga · CRP ${db.psicologo.CRP}` }];
      return contatos.map((c) => {
        const t = service.thread(db, user.id, c.id);
        const last = t[t.length - 1] || null;
        return { ...c, last, unread: t.filter((m) => m.Destinatario === user.id && !m.Lida).length };
      }).sort((a, b) => {
        if (!a.last && !b.last) return a.nome.localeCompare(b.nome);
        if (!a.last) return 1; if (!b.last) return -1;
        return new Date(b.last.DataHora) - new Date(a.last.DataHora);
      });
    },

    podeConversar(db, user, destId) {
      if (user.tipo === 'paciente') return destId === db.psicologo.CRP;
      const p = P.q.paciente(destId, db);
      return !!p && p.Status === 'ATIVO';
    },

    enviar(db, user, destId, texto) {
      const t = String(texto || '').trim();
      if (!t) throw new RuleError('Digite uma mensagem.', 'NOT NULL');
      if (t.length > MAX) throw new RuleError(`A mensagem excede ${MAX} caracteres.`, 'VARCHAR(500)');
      if (!service.podeConversar(db, user, destId)) {
        core.audit(db, user, 'ACESSO_NEGADO_LGPD', `Tentativa de enviar mensagem para ${destId}`, false);
        throw new RuleError('Destinatário não permitido para este perfil.', 'LGPD');
      }
      const m = { ID_Mensagem: P.nextId('mensagem', db), DataHora: new Date().toISOString(), Texto: t, Remetente: user.id, Destinatario: destId, Lida: false };
      db.mensagens.push(m);
      return m;
    },

    marcarLidas(db, user, outroId) {
      let n = 0;
      db.mensagens.forEach((m) => { if (m.Remetente === outroId && m.Destinatario === user.id && !m.Lida) { m.Lida = true; n++; } });
      return n;
    },

  };
  P.services.chat = service;

  /* =====================================================================
     CONTROLADOR DA PÁGINA
     ===================================================================== */
  if (document.body.dataset.page !== 'chat') return;

  const { $, esc } = util;
  const ui = P.ui;
  const params = new URLSearchParams(location.search);
  const state = { ativo: params.get('com') || null, busca: '', typing: {}, lastCount: -1, lastId: null, conversa: null };

  /** Rola a janela do chat até a mensagem mais recente (rodapé). */
  function scrollToBottom(smooth = false) {
    const box = $('#chat-thread');
    const go = () => box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    go();
    requestAnimationFrame(go); // garante a posição após o layout/fontes
  }

  function ativoValido(user) {
    const convs = service.conversas(P.db, user);
    if (!state.ativo || !convs.some((c) => c.id === state.ativo)) {
      state.ativo = window.innerWidth > 767 || user.tipo === 'paciente' ? (convs[0] && convs[0].id) : null;
    }
    return convs;
  }

  function renderList(user, convs) {
    const q = util.normalize(state.busca);
    const rows = convs.filter((c) => !q || util.normalize(c.nome).includes(q));
    $('#chat-conversas').innerHTML = rows.length ? rows.map((c) => {
      const mine = c.last && c.last.Remetente === user.id;
      const preview = c.last ? `${mine ? 'Você: ' : ''}${c.last.Texto}` : 'Nenhuma mensagem ainda';
      const when = c.last ? (util.sameDay(c.last.DataHora, new Date()) ? util.fmtTime(c.last.DataHora) : util.relTime(c.last.DataHora).replace('há ', '')) : '';
      return `<button class="conv ${state.ativo === c.id ? 'active' : ''}" data-conv="${esc(c.id)}">
        ${ui.avatar(c.nome, '', 'online')}
        <div class="grow">
          <div class="row-between"><span class="fw-700 truncate">${esc(c.nome)}</span><span class="text-xs text-muted">${when}</span></div>
          <div class="row-between"><span class="conv-preview truncate ${state.typing[c.id] ? 'typing' : ''}">${state.typing[c.id] ? 'digitando…' : esc(preview)}</span>${c.unread ? `<span class="unread">${c.unread}</span>` : ''}</div>
        </div>
      </button>`;
    }).join('') : ui.empty('search', 'Nenhuma conversa', 'Verifique os termos da busca.');
  }

  function renderThread(user) {
    const layout = $('.chat-layout');
    layout.classList.toggle('show-thread', !!state.ativo);
    if (!state.ativo) {
      $('#chat-head').innerHTML = '';
      $('#chat-thread').innerHTML = ui.empty('message', 'Selecione uma conversa', 'Escolha um contato para ver as mensagens.');
      $('#chat-form').hidden = true;
      return;
    }
    $('#chat-form').hidden = false;
    const db = P.db;
    const nome = P.q.nomeUsuario(state.ativo);
    const isTyping = !!state.typing[state.ativo];
    $('#chat-head').innerHTML = `
      <button class="icon-btn sm chat-back" data-back aria-label="Voltar">${P.icon('arrow-left', 18)}</button>
      ${ui.avatar(nome, '', 'online')}
      <div class="grow"><div class="fw-700 truncate">${esc(nome)}</div><div class="text-xs ${isTyping ? 'text-primary' : 'text-success'}">${isTyping ? 'digitando…' : 'Online agora'}</div></div>
      ${user.tipo === 'psicologo' ? `<a class="icon-btn sm" href="${P.url('anotacoes', `paciente=${encodeURIComponent(state.ativo)}`)}" title="Abrir prontuário" aria-label="Abrir prontuário">${P.icon('clipboard', 17)}</a>` : ''}`;

    const msgs = service.thread(db, user.id, state.ativo);
    let lastDay = null;
    const html = msgs.map((m) => {
      const day = util.isoDate(m.DataHora);
      let sep = '';
      if (day !== lastDay) {
        lastDay = day;
        const label = util.sameDay(m.DataHora, new Date()) ? 'Hoje' : util.sameDay(m.DataHora, new Date(Date.now() - 864e5)) ? 'Ontem' : util.fmtDateShort(day);
        sep = `<div class="day-sep"><span>${label}</span></div>`;
      }
      const mine = m.Remetente === user.id;
      return `${sep}<div class="msg ${mine ? 'mine' : 'theirs'}">
        ${mine ? '' : ui.avatar(nome, 'sm')}
        <div class="bubble"><div class="txt">${esc(m.Texto)}</div><div class="meta">${util.fmtTime(m.DataHora)}${mine ? `<span class="ticks ${m.Lida ? 'read' : ''}" title="${m.Lida ? 'Lida' : 'Enviada'}">${P.icon('check', 12)}${m.Lida ? P.icon('check', 12) : ''}</span>` : ''}</div></div>
      </div>`;
    }).join('');
    const typing = isTyping ? `<div class="msg theirs">${ui.avatar(nome, 'sm')}<div class="bubble typing-bubble"><span></span><span></span><span></span></div></div>` : '';
    const box = $('#chat-thread');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.innerHTML = (html || ui.empty('message', 'Nenhuma mensagem trocada ainda', 'Envie a primeira mensagem.')) + typing;
    // Nova conversa aberta, mensagem enviada/recebida (ou indicador de digitação) → vai para o rodapé
    const lastId = msgs.length ? msgs[msgs.length - 1].ID_Mensagem : null;
    const mudou = state.conversa !== state.ativo || lastId !== state.lastId || msgs.length !== state.lastCount;
    if (mudou) scrollToBottom(state.conversa === state.ativo);
    else if (nearBottom) scrollToBottom();
    state.conversa = state.ativo; state.lastId = lastId; state.lastCount = msgs.length;

    // Marca como lidas as mensagens recebidas nesta conversa
    if (service.marcarLidas(db, user, state.ativo) > 0) P.save('chat-read');
  }

  function render() {
    const user = P.currentUser();
    const convs = ativoValido(user);
    renderList(user, convs);
    renderThread(user);
  }

  function enviar() {
    const input = $('#chat-input');
    const user = P.currentUser();
    const dest = state.ativo;
    try {
      service.enviar(P.db, user, dest, input.value);
      input.value = ''; autoGrow(); updateCounter();
      P.save('chat');      // re-renderiza e rola até a mensagem enviada
      scrollToBottom(true);
    } catch (e) { P.save(); ui.toast(e.message, 'error'); }
  }

  function autoGrow() { const t = $('#chat-input'); t.style.height = 'auto'; t.style.height = `${Math.min(140, t.scrollHeight)}px`; }
  function updateCounter() {
    const n = $('#chat-input').value.length;
    const c = $('#chat-counter');
    c.textContent = `${n}/${MAX}`;
    c.classList.toggle('text-danger', n > MAX);
    $('#chat-send').disabled = !n || n > MAX;
  }

  const emitTyping = util.debounce(() => {
    const u = P.currentUser();
    if (state.ativo) P.broadcast({ type: 'typing', from: u.id, to: state.ativo });
  }, 250);

  P.page({
    init() {
      $('#chat-busca').addEventListener('input', (e) => { state.busca = e.target.value; render(); });
      $('#chat-conversas').addEventListener('click', (e) => {
        const b = e.target.closest('[data-conv]'); if (!b) return;
        state.ativo = b.dataset.conv; render();
        $('#chat-input').focus();
      });
      $('#chat-head').addEventListener('click', (e) => { if (e.target.closest('[data-back]')) { state.ativo = null; render(); } });
      $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); enviar(); });
      const input = $('#chat-input');
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!$('#chat-send').disabled) enviar(); } });
      input.addEventListener('input', () => { autoGrow(); updateCounter(); emitTyping(); });
      updateCounter();

      // Indicador "digitando…" vindo de outra aba
      window.addEventListener('prisma:broadcast', (e) => {
        const d = e.detail || {};
        const u = P.currentUser();
        if (d.type === 'typing' && d.to === u.id) {
          state.typing[d.from] = Date.now();
          render();
          setTimeout(() => { if (state.typing[d.from] && Date.now() - state.typing[d.from] >= 2400) { delete state.typing[d.from]; render(); } }, 2500);
        }
      });
      window.addEventListener('prisma:session', () => { state.ativo = null; state.conversa = null; });
    },
    render,
  });
})(window.PRISMA);
