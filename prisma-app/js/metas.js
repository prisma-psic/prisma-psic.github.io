/* =========================================================================
   PRISMA — metas.js
   Service (checklist + cálculo percentual de progresso) + controlador da
   página de Metas terapêuticas.

   Regras:
     • CHK_Datas_Meta ...... DataFim >= DataInicio
     • CHK_Status_Meta ..... 'Ativa' | 'Concluida' | 'Cancelada'
     • Progresso ........... round(itens concluídos / total de itens * 100)
     • Status automático ... 100% → Concluida; ao desmarcar um item → Ativa
       (equivale aos triggers TRG_Checklist_* do schema.sql)
     • Somente a psicóloga cria/edita metas; o paciente marca o checklist
       das próprias metas (LGPD).
   ========================================================================= */
(function (P) {
  'use strict';
  const { util, core } = P;
  const { RuleError } = core;

  const CATEGORIAS = ['Bem-estar', 'Ansiedade', 'Terapia Cognitiva', 'Autoestima', 'Plano terapêutico', 'Relacionamentos', 'Outro'];
  const PRAZOS = ['Curto', 'Médio', 'Longo'];

  /* =====================================================================
     SERVICE
     ===================================================================== */
  const service = {
    CATEGORIAS, PRAZOS,

    /** Percentual de progresso de uma meta a partir do checklist. */
    calcularProgresso(checklist = []) {
      if (!checklist.length) return 0;
      return Math.round((checklist.filter((i) => i.concluido).length / checklist.length) * 100);
    },

    /** Atualiza ProgressoPercentual e o status automático da meta. */
    recalcular(meta) {
      const pct = service.calcularProgresso(meta.Checklist);
      meta.ProgressoPercentual = pct;
      if (meta.Status !== 'Cancelada') meta.Status = pct === 100 ? 'Concluida' : 'Ativa';
      return pct;
    },

    /** Média de progresso das metas (ignora canceladas). */
    progressoGeral(metas) {
      const validas = metas.filter((m) => m.Status !== 'Cancelada');
      if (!validas.length) return 0;
      return Math.round(validas.reduce((s, m) => s + m.ProgressoPercentual, 0) / validas.length);
    },

    validaDatas(inicio, fim) {
      if (!inicio) throw new RuleError('A data de início é obrigatória.', 'CHK_Datas_Meta');
      if (fim && util.parseDate(fim) < util.parseDate(inicio)) {
        throw new RuleError('A data final deve ser igual ou posterior à data de início (CHK_Datas_Meta).', 'CHK_Datas_Meta');
      }
    },

    listar(db, user, cpf = null) {
      let list = db.metas.slice();
      if (user.tipo === 'paciente') list = list.filter((m) => m.CPF_Paciente === user.id);
      else if (cpf) list = list.filter((m) => m.CPF_Paciente === cpf);
      return list;
    },

    criar(db, user, { cpf, descricao, objetivos, categoria, prazo, dataInicio, dataFim, itens = [] }) {
      if (user.tipo !== 'psicologo') throw new RuleError('Apenas a psicóloga pode criar metas terapêuticas.', 'RBAC');
      if (!cpf || !P.q.pacientesAtivos(db).some((p) => p.CPF === cpf)) throw new RuleError('Selecione um paciente válido.', 'FK_Meta_Paciente');
      if (!descricao) throw new RuleError('A descrição da meta é obrigatória.', 'NOT NULL');
      service.validaDatas(dataInicio, dataFim);
      const checklist = itens.map((t) => String(t).trim()).filter(Boolean).map((t, i) => ({ id: i + 1, descricao: t, concluido: false }));
      if (!checklist.length) throw new RuleError('Inclua ao menos uma etapa no checklist.', 'Checklist');
      const meta = {
        ID_Meta: P.nextId('meta', db), Status: 'Ativa', DataInicio: dataInicio, DataFim: dataFim || null,
        Descricao: descricao, Objetivos: objetivos || null, CPF_Paciente: cpf, CRP_Psicologo: db.psicologo.CRP,
        Categoria: categoria || 'Plano terapêutico', Prazo: prazo || 'Curto', Checklist: checklist, ProgressoPercentual: 0,
      };
      service.recalcular(meta);
      db.metas.push(meta);
      core.notify(db, cpf, 'Nova meta terapêutica', `${db.psicologo.Nome} adicionou a meta "${descricao}" ao seu plano.`, 'meta_ativa');
      core.audit(db, user, 'CRIAR_META', `Meta ${meta.ID_Meta} criada para ${cpf}`, true);
      return meta;
    },

    obter(db, user, metaId) {
      const meta = db.metas.find((m) => m.ID_Meta === Number(metaId));
      if (!meta) throw new RuleError('Meta não encontrada.', 'FK');
      if (user.tipo === 'paciente' && meta.CPF_Paciente !== user.id) {
        core.audit(db, user, 'ACESSO_NEGADO_LGPD', `Tentativa de acesso à meta ${metaId} de outro paciente`, false);
        throw new RuleError('Acesso negado a metas de outro paciente.', 'LGPD');
      }
      return meta;
    },

    toggleItem(db, user, metaId, itemId) {
      const meta = service.obter(db, user, metaId);
      if (meta.Status === 'Cancelada') throw new RuleError('Meta cancelada não pode ser atualizada.', 'CHK_Status_Meta');
      const item = meta.Checklist.find((i) => i.id === Number(itemId));
      if (!item) throw new RuleError('Item do checklist não encontrado.', 'FK');
      const statusAntes = meta.Status;
      item.concluido = !item.concluido;
      item.dataConclusao = item.concluido ? new Date().toISOString() : null;
      const pct = service.recalcular(meta);
      core.audit(db, user, 'UPDATE_CHECKLIST_META', `Meta ${meta.ID_Meta}, item ${item.id} → ${item.concluido ? 'concluído' : 'pendente'} (${pct}%)`, true);
      if (user.tipo === 'paciente' && meta.Status === 'Concluida' && statusAntes !== 'Concluida') {
        core.notify(db, db.psicologo.CRP, 'Meta concluída 🎉', `${user.nome} concluiu a meta "${meta.Descricao}".`, 'meta_ativa');
      }
      return { meta, item, progresso: pct };
    },

    adicionarItem(db, user, metaId, descricao) {
      if (user.tipo !== 'psicologo') throw new RuleError('Apenas a psicóloga edita o checklist.', 'RBAC');
      const meta = service.obter(db, user, metaId);
      if (!descricao || !descricao.trim()) throw new RuleError('Descreva a etapa.', 'NOT NULL');
      const id = meta.Checklist.reduce((mx, i) => Math.max(mx, i.id), 0) + 1;
      meta.Checklist.push({ id, descricao: descricao.trim(), concluido: false });
      service.recalcular(meta);
      core.audit(db, user, 'ADICIONAR_ITEM_META', `Meta ${meta.ID_Meta}: item "${descricao.trim()}"`, true);
      return meta;
    },

    removerItem(db, user, metaId, itemId) {
      if (user.tipo !== 'psicologo') throw new RuleError('Apenas a psicóloga edita o checklist.', 'RBAC');
      const meta = service.obter(db, user, metaId);
      if (meta.Checklist.length <= 1) throw new RuleError('A meta precisa de ao menos uma etapa.', 'Checklist');
      meta.Checklist = meta.Checklist.filter((i) => i.id !== Number(itemId));
      service.recalcular(meta);
      core.audit(db, user, 'REMOVER_ITEM_META', `Meta ${meta.ID_Meta}: item ${itemId} removido`, true);
      return meta;
    },

    alterarStatus(db, user, metaId, status) {
      if (user.tipo !== 'psicologo') throw new RuleError('Apenas a psicóloga altera o status da meta.', 'RBAC');
      if (!['Ativa', 'Cancelada'].includes(status)) throw new RuleError('Status inválido (CHK_Status_Meta).', 'CHK_Status_Meta');
      const meta = service.obter(db, user, metaId);
      meta.Status = status;
      if (status === 'Ativa') service.recalcular(meta);
      core.audit(db, user, 'STATUS_META', `Meta ${meta.ID_Meta} → ${meta.Status}`, true);
      return meta;
    },
  };
  P.services.metas = service;

  /* =====================================================================
     CONTROLADOR DA PÁGINA
     ===================================================================== */
  if (document.body.dataset.page !== 'metas') return;

  const { $, esc } = util;
  const ui = P.ui;
  const params = new URLSearchParams(location.search);
  const state = { cpf: params.get('paciente') || null, filtro: 'Ativa', busca: '' };

  function act(fn, ok) {
    try { const r = fn(); P.save('metas'); if (ok) ui.toast(ok, 'success'); return r; }
    catch (e) { P.save('metas'); ui.toast(e.message, 'error'); return null; }
  }

  function openNovaMeta() {
    const db = P.db;
    const hoje = util.isoDate();
    const fim = util.isoDate(new Date(Date.now() + 30 * 864e5));
    ui.formModal({
      title: 'Nova meta terapêutica', subtitle: 'Metas de curto, médio ou longo prazo com checklist de acompanhamento.',
      submitLabel: 'Criar meta', submitIcon: 'plus', size: 'lg',
      body: `<div class="form-grid">
        <div class="field full"><label>Paciente *</label><select class="select" name="cpf" required data-label="Paciente">${P.q.pacientesAtivos(db).map((p) => `<option value="${esc(p.CPF)}" ${p.CPF === state.cpf ? 'selected' : ''}>${esc(p.Nome)}</option>`).join('')}</select></div>
        <div class="field full"><label>Descrição da meta *</label><input class="input" name="descricao" maxlength="150" required data-label="Descrição" placeholder="Ex.: Praticar mindfulness diariamente"></div>
        <div class="field full"><label>Objetivos / resultado esperado</label><input class="input" name="objetivos" maxlength="150" placeholder="Ex.: 10 minutos por dia antes do trabalho"></div>
        <div class="field"><label>Categoria</label><select class="select" name="categoria">${CATEGORIAS.map((c) => `<option>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Prazo</label><select class="select" name="prazo">${PRAZOS.map((c) => `<option>${c}</option>`).join('')}</select></div>
        <div class="field"><label>Data de início *</label><input class="input" type="date" name="dataInicio" value="${hoje}" required data-label="Data de início"></div>
        <div class="field"><label>Data final</label><input class="input" type="date" name="dataFim" value="${fim}"><span class="hint">Deve ser igual ou posterior ao início.</span></div>
        <div class="field full"><label>Etapas do checklist * <span class="text-muted fw-600">(uma por linha)</span></label>
          <textarea class="textarea" name="itens" rows="5" required data-label="Etapas do checklist" placeholder="Semana 1 — respiração guiada 5 min&#10;Semana 2 — atenção plena corporal&#10;Semana 3 — prática autônoma"></textarea>
        </div>
      </div>`,
      onSubmit(d) {
        const meta = service.criar(P.db, P.currentUser(), {
          cpf: d.cpf, descricao: d.descricao, objetivos: d.objetivos, categoria: d.categoria, prazo: d.prazo,
          dataInicio: d.dataInicio, dataFim: d.dataFim, itens: String(d.itens || '').split('\n'),
        });
        state.cpf = meta.CPF_Paciente; state.filtro = 'Ativa';
        P.save('metas');
        ui.toast('Meta criada e paciente notificado.', 'success');
      },
    });
  }

  function renderPatients(user) {
    const box = $('#metas-pacientes');
    if (user.tipo !== 'psicologo') { box.hidden = true; return; }
    box.hidden = false;
    const db = P.db;
    const q = util.normalize(state.busca);
    const rows = P.q.pacientesAtivos(db)
      .filter((p) => !q || util.normalize(p.Nome).includes(q))
      .map((p) => {
        const metas = db.metas.filter((m) => m.CPF_Paciente === p.CPF);
        const ativas = metas.filter((m) => m.Status === 'Ativa').length;
        const geral = service.progressoGeral(metas);
        return `<button class="patient-row ${state.cpf === p.CPF ? 'active' : ''}" data-cpf="${esc(p.CPF)}">
          ${ui.avatar(p.Nome, 'sm')}
          <div class="grow"><div class="fw-700 truncate">${esc(p.Nome)}</div><div class="text-xs muted-inv">${metas.length ? `${ativas} ativa${ativas === 1 ? '' : 's'} · ${geral}% geral` : 'Sem metas'}</div></div>
        </button>`;
      }).join('');
    $('#metas-pacientes-list').innerHTML = `<button class="patient-row ${!state.cpf ? 'active' : ''}" data-cpf="">
        <span class="avatar sm" style="background:var(--surface-3);color:var(--text-2)">${P.icon('users', 14)}</span>
        <div class="grow"><div class="fw-700">Todos os pacientes</div><div class="text-xs muted-inv">${db.metas.length} metas</div></div>
      </button>${rows}`;
  }

  function metaCard(m, user) {
    const done = m.Checklist.filter((i) => i.concluido).length;
    const nome = P.q.pacienteNome(m.CPF_Paciente);
    const vencida = m.Status === 'Ativa' && m.DataFim && util.parseDate(m.DataFim) < util.parseDate(util.isoDate());
    const pctCls = m.ProgressoPercentual === 100 ? 'text-success' : m.ProgressoPercentual >= 70 ? 'text-success' : '';
    return `
      <article class="card goal ${m.Status === 'Cancelada' ? 'cancelled' : ''}" data-meta="${m.ID_Meta}">
        <header class="goal-head">
          <span class="goal-ring" style="--p:${m.ProgressoPercentual}" aria-hidden="true"><span>${m.ProgressoPercentual}%</span></span>
          <div class="grow">
            <div class="row wrap gap-6"><h3 class="goal-title">${esc(m.Descricao)}</h3><span class="fw-800 ${pctCls}">${m.ProgressoPercentual}%</span></div>
            ${m.Objetivos ? `<p class="text-sm text-2">${esc(m.Objetivos)}</p>` : ''}
            <div class="row wrap gap-6 mt-8">
              <span class="tag">${esc(m.Categoria || 'Geral')}</span>
              <span class="tag">Prazo ${esc(m.Prazo || '—')}</span>
              ${ui.statusBadge(m.Status)}
              ${vencida ? '<span class="badge badge-warning">Prazo vencido</span>' : ''}
              ${user.tipo === 'psicologo' && !state.cpf ? `<span class="text-xs text-muted">${esc(nome)}</span>` : ''}
            </div>
          </div>
          ${user.tipo === 'psicologo' ? `<div class="goal-menu">
            ${m.Status === 'Cancelada'
              ? `<button class="btn btn-ghost btn-sm" data-status="Ativa" data-id="${m.ID_Meta}">${P.icon('refresh', 14)}Reativar</button>`
              : `<button class="icon-btn sm" data-status="Cancelada" data-id="${m.ID_Meta}" title="Cancelar meta" aria-label="Cancelar meta">${P.icon('trash', 15)}</button>`}
          </div>` : ''}
        </header>
        <div class="goal-progress">
          <div class="row-between text-xs"><span class="text-muted">Progresso</span><strong>${done}/${m.Checklist.length}</strong></div>
          ${ui.progress(m.ProgressoPercentual, m.ProgressoPercentual === 100 ? 'success' : '')}
        </div>
        <ul class="checklist">
          ${m.Checklist.map((i) => `
            <li class="${i.concluido ? 'done' : ''}">
              <label class="check">
                <input type="checkbox" data-toggle="${m.ID_Meta}:${i.id}" ${i.concluido ? 'checked' : ''} ${m.Status === 'Cancelada' ? 'disabled' : ''}>
                <span class="box">${P.icon('check', 12)}</span>
                <span class="txt">${esc(i.descricao)}</span>
              </label>
              ${user.tipo === 'psicologo' && m.Status !== 'Cancelada' ? `<button class="icon-btn sm rm" data-rm="${m.ID_Meta}:${i.id}" aria-label="Remover etapa">${P.icon('x', 14)}</button>` : ''}
            </li>`).join('')}
        </ul>
        ${user.tipo === 'psicologo' && m.Status !== 'Cancelada' ? `<form class="add-item" data-add="${m.ID_Meta}"><input class="input" name="item" maxlength="120" placeholder="Adicionar etapa ao checklist…" aria-label="Nova etapa"><button class="btn btn-outline btn-sm" type="submit">${P.icon('plus', 14)}Adicionar</button></form>` : ''}
        <footer class="goal-foot text-xs text-muted">${P.icon('calendar', 12)} ${util.fmtDate(m.DataInicio)} → ${m.DataFim ? util.fmtDate(m.DataFim) : 'sem data final'}</footer>
      </article>`;
  }

  function render() {
    const user = P.currentUser();
    const db = P.db;
    if (user.tipo === 'paciente') state.cpf = user.id;
    else if (state.cpf && !P.q.paciente(state.cpf)) state.cpf = null;
    const all = service.listar(db, user, user.tipo === 'psicologo' ? state.cpf : null);
    const geral = service.progressoGeral(all);
    const concluidos = all.reduce((s, m) => s + m.Checklist.filter((i) => i.concluido).length, 0);
    const totalItens = all.reduce((s, m) => s + m.Checklist.length, 0);

    $('#btn-nova-meta').hidden = user.tipo !== 'psicologo';
    $('#metas-sub').textContent = user.tipo === 'psicologo'
      ? (state.cpf ? `Plano de ${P.q.pacienteNome(state.cpf)}` : 'Acompanhe as metas de todos os pacientes.')
      : 'Marque as etapas concluídas — sua psicóloga acompanha o progresso.';
    document.querySelector('.metas-layout').classList.toggle('single', user.tipo !== 'psicologo');

    $('#metas-hero').innerHTML = `
      <div class="eyebrow-inv">${P.icon('trending', 14)} Progresso geral</div>
      <div class="hero-value">${geral}%</div>
      <div class="hero-sub">${concluidos} de ${totalItens} etapas concluídas · ${all.filter((m) => m.Status === 'Ativa').length} metas ativas · ${all.filter((m) => m.Status === 'Concluida').length} concluídas</div>
      <div class="hero-bar"><span style="width:${geral}%"></span></div>`;

    const counts = { Ativa: 0, Concluida: 0, Cancelada: 0 };
    all.forEach((m) => { counts[m.Status] = (counts[m.Status] || 0) + 1; });
    const filtros = [['Ativa', 'Ativas'], ['Concluida', 'Concluídas'], ['Cancelada', 'Canceladas'], ['Todas', 'Todas']];
    $('#metas-filtros').innerHTML = filtros.map(([id, label]) => `<button class="chip ${state.filtro === id ? 'active' : ''}" data-filtro="${id}">${label} <span class="count">${id === 'Todas' ? all.length : counts[id] || 0}</span></button>`).join('');

    const list = state.filtro === 'Todas' ? all : all.filter((m) => m.Status === state.filtro);
    list.sort((a, b) => a.ProgressoPercentual - b.ProgressoPercentual);
    $('#metas-list').innerHTML = list.length
      ? list.map((m) => metaCard(m, user)).join('')
      : ui.empty('target', 'Nenhuma meta aqui', user.tipo === 'psicologo' ? 'Crie uma nova meta para o paciente.' : 'Sua psicóloga ainda não definiu metas nesta categoria.');
    renderPatients(user);
  }

  P.page({
    init() {
      $('#btn-nova-meta').addEventListener('click', openNovaMeta);
      $('#metas-busca').addEventListener('input', util.debounce((e) => { state.busca = e.target.value; render(); }, 150));
      $('#metas-pacientes-list').addEventListener('click', (e) => {
        const b = e.target.closest('[data-cpf]'); if (!b) return;
        state.cpf = b.dataset.cpf || null; render();
      });
      $('#metas-filtros').addEventListener('click', (e) => {
        const b = e.target.closest('[data-filtro]'); if (!b) return;
        state.filtro = b.dataset.filtro; render();
      });
      const list = $('#metas-list');
      list.addEventListener('change', (e) => {
        const t = e.target.closest('[data-toggle]'); if (!t) return;
        const [metaId, itemId] = t.dataset.toggle.split(':').map(Number);
        const r = act(() => service.toggleItem(P.db, P.currentUser(), metaId, itemId));
        if (r && r.meta.Status === 'Concluida' && r.item.concluido) ui.toast('Meta concluída! 🎉', 'success');
      });
      list.addEventListener('click', (e) => {
        const rm = e.target.closest('[data-rm]');
        if (rm) { const [m, i] = rm.dataset.rm.split(':').map(Number); act(() => service.removerItem(P.db, P.currentUser(), m, i), 'Etapa removida.'); return; }
        const st = e.target.closest('[data-status]');
        if (st) {
          const id = Number(st.dataset.id);
          if (st.dataset.status === 'Cancelada') {
            ui.confirm({ title: 'Cancelar meta', message: 'A meta deixará de aparecer entre as ativas do paciente. Você pode reativá-la depois.', confirmLabel: 'Cancelar meta', variant: 'btn-danger',
              onConfirm: () => act(() => service.alterarStatus(P.db, P.currentUser(), id, 'Cancelada'), 'Meta cancelada.') });
          } else act(() => service.alterarStatus(P.db, P.currentUser(), id, 'Ativa'), 'Meta reativada.');
        }
      });
      list.addEventListener('submit', (e) => {
        const f = e.target.closest('[data-add]'); if (!f) return;
        e.preventDefault();
        act(() => service.adicionarItem(P.db, P.currentUser(), Number(f.dataset.add), f.item.value), 'Etapa adicionada.');
      });
    },
    render,
  });
})(window.PRISMA);
