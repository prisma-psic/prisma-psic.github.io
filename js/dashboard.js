/* =========================================================================
   PRISMA — dashboard.js
   Página inicial: resumo de atividades por perfil.
     • Psicóloga: indicadores, próxima sessão, solicitações pendentes
       (aceite rápido via services.agenda), agenda da semana, pacientes
       recentes e atividades recentes (auditoria).
     • Paciente: próxima consulta, metas ativas, pendências e atalhos.
   ========================================================================= */
(function (P) {
  'use strict';
  const { util } = P;

  /* ---------- Service: indicadores ---------- */
  const service = {
    kpisPsicologa(db) {
      const now = Date.now();
      const ativos = new Set(db.consultas.filter((c) => ['Agendada', 'Pendente', 'Aguardando_Paciente'].includes(c.Status)).map((c) => c.CPF_Paciente));
      db.metas.filter((m) => m.Status === 'Ativa').forEach((m) => ativos.add(m.CPF_Paciente));
      const hoje = db.consultas.filter((c) => c.Status === 'Agendada' && util.sameDay(c.DataHora, new Date()));
      const proxHoje = hoje.filter((c) => new Date(c.DataHora).getTime() > now).sort((a, b) => new Date(a.DataHora) - new Date(b.DataHora))[0];
      const metasAtivas = db.metas.filter((m) => m.Status === 'Ativa');
      const itens = metasAtivas.reduce((s, m) => s + m.Checklist.length, 0);
      const feitos = metasAtivas.reduce((s, m) => s + m.Checklist.filter((i) => i.concluido).length, 0);
      const realizadas = db.consultas.filter((c) => c.Status === 'Realizada').length;
      const faltas = db.consultas.filter((c) => c.Status === 'Faltou').length;
      return {
        pacientesAtivos: ativos.size, totalPacientes: P.q.pacientesAtivos(db).length,
        consultasHoje: hoje.length, proxHoje,
        metasAtivas: metasAtivas.length, pctItens: itens ? Math.round((feitos / itens) * 100) : 0,
        comparecimento: realizadas + faltas ? Math.round((realizadas / (realizadas + faltas)) * 100) : 100,
        realizadas, faltas,
      };
    },
    proximaConsulta(db, cpf = null) {
      return db.consultas
        .filter((c) => c.Status === 'Agendada' && new Date(c.DataHora).getTime() > Date.now() - 50 * 6e4 && (!cpf || c.CPF_Paciente === cpf))
        .sort((a, b) => new Date(a.DataHora) - new Date(b.DataHora))[0] || null;
    },
  };
  P.services.dashboard = service;

  if (document.body.dataset.page !== 'index') return;

  const { $, esc } = util;
  const ui = P.ui;
  const agenda = P.services.agenda;

  function heroHtml(c, isPsi) {
    if (!c) {
      return `<div class="hero">
        <div class="eyebrow-hero">Próxima sessão</div>
        <div class="hero-title">Nenhuma consulta confirmada</div>
        <div class="hero-sub">${isPsi ? 'Assim que uma solicitação for aceita, ela aparece aqui.' : 'Solicite um horário na agenda — a psicóloga confirma.'}</div>
        <div class="hero-actions"><a class="btn hero-btn" href="${P.url('agenda')}">${P.icon('calendar', 15)}${isPsi ? 'Abrir agenda' : 'Solicitar consulta'}</a></div>
      </div>`;
    }
    const nome = isPsi ? P.q.pacienteNome(c.CPF_Paciente) : P.db.psicologo.Nome;
    const conf = agenda.rules.situacaoConfirmacao(P.db, c);
    const confTxt = !conf ? '' : conf.codigo === 'CONFIRMADA' ? ' · presença confirmada'
      : conf.codigo === 'PENDENTE_CONFIRMACAO' ? ' · presença NÃO confirmada' : ` · confirmar até ${util.fmtDateTime(conf.prazo)}`;
    const dia = util.sameDay(c.DataHora, new Date()) ? 'Hoje' : util.capitalize(util.fmtDateLong(c.DataHora));
    return `<div class="hero">
      <div class="row-between wrap">
        <div>
          <div class="eyebrow-hero">Próxima sessão</div>
          <div class="hero-title">${esc(nome)}</div>
          <div class="hero-sub">${dia} · ${util.fmtTime(c.DataHora)} · ${c.Duracao} · ${c.Modalidade}${esc(confTxt)}</div>
        </div>
        <span class="hero-pill">${P.icon('clock', 14)} ${util.capitalize(util.relTime(c.DataHora))}</span>
      </div>
      <div class="hero-actions">
        <a class="btn hero-btn" href="${P.url('agenda', `id=${c.ID_Consulta}`)}">${P.icon('calendar', 15)}Ver na agenda</a>
        ${!isPsi && conf && conf.codigo !== 'CONFIRMADA' ? `<button class="btn hero-btn" data-confirmar="${c.ID_Consulta}">${P.icon('check-circle', 15)}Confirmar presença</button>` : ''}
        ${isPsi ? `<a class="btn hero-btn ghost" href="${P.url('anotacoes', `paciente=${encodeURIComponent(c.CPF_Paciente)}`)}">${P.icon('clipboard', 15)}Prontuário</a>`
          : `<a class="btn hero-btn ghost" href="${P.url('chat')}">${P.icon('message', 15)}Falar com a psicóloga</a>`}
      </div>
    </div>`;
  }

  /** Tag de confirmação de presença (verde/amarela/vermelha) — ou o status da consulta. */
  const confBadge = (c) => { const s = agenda.rules.situacaoConfirmacao(P.db, c); return ui.statusBadge(s ? s.codigo : c.Status); };

  const kpi = (value, label, trend, tone = '') => `<div class="card kpi"><div class="value">${value}</div><div class="label">${label}</div>${trend ? `<div class="trend ${tone}">${trend}</div>` : ''}</div>`;

  const ACAO_LABEL = {
    SOLICITAR_CONSULTA: 'Solicitação de consulta', ACEITAR_SOLICITACAO: 'Consulta confirmada', RECUSAR_CONSULTA: 'Consulta recusada',
    CONTRAPROPOSTA_CONSULTA: 'Novo horário sugerido', ACEITAR_PROPOSTA: 'Proposta aceita', CANCELAR_CONSULTA: 'Consulta cancelada',
    REMARCAR_CONSULTA: 'Consulta remarcada', UPDATE_CHECKLIST_META: 'Checklist atualizado', CRIAR_META: 'Meta criada',
    UPLOAD_DRIVE: 'Documento enviado', UPLOAD_FALLBACK_LOCAL: 'Documento (fallback local)', EMISSAO_LAUDO_ATESTADO: 'Laudo/atestado emitido',
    ATUALIZAR_REGISTRO_CLINICO: 'Anotação clínica atualizada', CRIAR_REGISTRO_CLINICO: 'Anotação clínica criada', RESPONDER_TESTE: 'Teste respondido',
    ATRIBUIR_TESTE: 'Teste enviado', BLOQUEIO_LIMITE_AGENDA: 'Bloqueio: limite de cancelamento', ACESSO_BLOQUEADO_PRONTUARIO: 'Bloqueio: prontuário',
    APROVAR_CADASTRO_PACIENTE: 'Cadastro aprovado', RECUSAR_CADASTRO_PACIENTE: 'Cadastro recusado', CADASTRO_PACIENTE: 'Novo cadastro de paciente',
    LOGIN_PSICOLOGO: 'Login (psicóloga)', LOGIN_PACIENTE: 'Login (paciente)', LOGIN_FALHA: 'Falha de login', LOGIN_BLOQUEADO_STATUS: 'Login bloqueado (cadastro pendente)', LOGOUT: 'Logout',
    ACESSO_NEGADO: 'Acesso negado', ACESSO_NEGADO_LGPD: 'Acesso negado (LGPD)', FALHA_AGENDAMENTO: 'Falha de agendamento',
    BLOQUEAR_AGENDA: 'Agenda bloqueada', EDITAR_BLOQUEIO: 'Bloqueio de agenda editado', REMOVER_BLOQUEIO: 'Bloqueio de agenda removido',
    CONFIRMAR_PRESENCA: 'Presença confirmada', LEMBRETE_CONFIRMACAO: 'Lembrete de confirmação', ALERTA_CONFIRMACAO: 'Presença não confirmada (36 h)',
    BLOQUEIO_REAGENDAMENTO_48H: 'Bloqueio: reagendamento < 48 h', BLOQUEIO_ANTECEDENCIA_48H: 'Bloqueio: agendamento < 48 h', CONFIGURAR_PRAZOS_AGENDA: 'Prazos da agenda alterados',
  };

  /* ---------- Solicitações de cadastro pendentes ---------- */
  function renderCadastros(user) {
    const box = $('#dash-cadastros');
    const auth = P.services.auth;
    if (!auth || user.tipo !== 'psicologo') { box.hidden = true; return; }
    const { pacientes, profissionais } = auth.pendentes(P.db, user);
    const total = pacientes.length + profissionais.length;
    box.hidden = false;
    box.classList.toggle('has-items', total > 0);
    $('#cad-count').textContent = total ? `${total} aguardando` : 'Nenhuma';
    $('#cad-count').className = `badge ${total ? 'badge-warning' : 'badge-success'}`;
    const linha = (x, tipo) => {
      const id = tipo === 'paciente' ? x.CPF : x.CRP;
      return `<tr>
        <td><div class="row gap-6">${ui.avatar(x.Nome, 'sm')}<div class="grow"><div class="fw-700 truncate">${esc(x.Nome)}</div>
          <div class="text-xs text-muted">${tipo === 'paciente' ? `Paciente · nasc. ${util.fmtDate(x.DataNascimento)}` : `Psicólogo(a) · CRP ${esc(x.CRP)}`}</div></div></div></td>
        <td class="mono text-xs nowrap">${esc(x.CPF)}</td>
        <td class="text-sm">${esc(x.Email)}</td>
        <td class="text-sm nowrap">${esc(x.Telefone || '—')}</td>
        <td class="text-sm nowrap" title="${util.fmtDateTime(x.Data_Solicitacao)}">${util.fmtDate(x.Data_Solicitacao)}<div class="text-xs text-muted">${util.relTime(x.Data_Solicitacao)}</div></td>
        <td class="acoes"><div class="row gap-6" style="justify-content:flex-end">
          <button class="btn btn-success btn-sm" data-aprovar="${esc(id)}" data-tipo="${tipo}">${P.icon('check', 14)}Aprovar cadastro</button>
          <button class="btn btn-danger btn-sm" data-recusar="${esc(id)}" data-tipo="${tipo}">${P.icon('x', 14)}Recusar</button>
        </div></td>
      </tr>`;
    };
    $('#cad-lista').innerHTML = total ? `<div class="table-wrap"><table class="table cad-table">
      <thead><tr><th>Nome</th><th>CPF</th><th>E-mail</th><th>Telefone</th><th>Solicitado em</th><th></th></tr></thead>
      <tbody>${pacientes.map((x) => linha(x, 'paciente')).join('')}${profissionais.map((x) => linha(x, 'psicologo')).join('')}</tbody>
    </table></div>` : ui.empty('check-circle', 'Nenhum cadastro aguardando aprovação', 'Novos pacientes que se cadastrarem aparecerão aqui.');
  }

  function aprovarCadastro(id, tipo) {
    const auth = P.services.auth;
    try {
      const x = tipo === 'paciente' ? auth.aprovarPaciente(P.db, P.currentUser(), id) : auth.aprovarPsicologo(P.db, P.currentUser(), id, true);
      P.save('cadastro');
      ui.toast(`Cadastro de ${x.Nome} aprovado. O acesso já está liberado.`, 'success');
    } catch (e) { P.save(); ui.toast(e.message, 'error'); }
  }

  function recusarCadastro(id, tipo) {
    const auth = P.services.auth;
    const conta = tipo === 'paciente' ? P.q.paciente(id) : (P.db.equipe || []).find((x) => x.CRP === id);
    if (!conta) return;
    ui.formModal({
      title: 'Recusar cadastro', subtitle: `${conta.Nome} · ${conta.Email}`, size: 'sm',
      submitLabel: 'Recusar cadastro', submitVariant: 'btn-danger', submitIcon: 'x',
      body: `<div class="field"><label>Motivo (opcional)</label><textarea class="textarea" name="motivo" maxlength="255" placeholder="Ex.: demanda fora da área de atuação — encaminhado para outro serviço."></textarea>
        <span class="hint">O status passa para REJEITADO e o acesso permanece bloqueado. O registro é mantido para auditoria.</span></div>`,
      onSubmit(d) {
        if (tipo === 'paciente') auth.recusarPaciente(P.db, P.currentUser(), id, d.motivo);
        else auth.aprovarPsicologo(P.db, P.currentUser(), id, false, d.motivo);
        P.save('cadastro');
        ui.toast('Cadastro recusado.', 'success');
      },
    });
  }

  function renderPsicologa(user) {
    const db = P.db;
    const k = service.kpisPsicologa(db);
    renderCadastros(user);
    $('#dash-greeting').innerHTML = `${util.greeting()}, ${esc(user.nome.replace(/ \S+$/, ''))} 👋`;
    $('#dash-date').textContent = `${util.capitalize(util.fmtDateLong(new Date()))} de ${new Date().getFullYear()} · ${k.consultasHoje} consulta${k.consultasHoje === 1 ? '' : 's'} hoje`;
    $('#dash-kpis').innerHTML = [
      kpi(k.pacientesAtivos, 'Pacientes ativos', `${P.icon('users', 13)} ${k.totalPacientes} cadastrados`),
      kpi(k.consultasHoje, 'Consultas hoje', k.proxHoje ? `${P.icon('trending', 13)} Próx. às ${util.fmtTime(k.proxHoje.DataHora)}` : 'Sem mais consultas hoje', 'text-success'),
      kpi(k.metasAtivas, 'Metas em andamento', `${P.icon('trending', 13)} ${k.pctItens}% das etapas concluídas`, 'text-warning'),
      kpi(`${k.comparecimento}%`, 'Taxa de comparecimento', `${k.realizadas} realizadas · ${k.faltas} falta${k.faltas === 1 ? '' : 's'}`, 'text-primary'),
    ].join('');
    $('#dash-hero').innerHTML = heroHtml(service.proximaConsulta(db), true);

    // Solicitações pendentes
    const pend = db.consultas.filter((c) => c.Status === 'Pendente').sort((a, b) => new Date(a.DataHora) - new Date(b.DataHora));
    $('#dash-left-title').innerHTML = `Solicitações pendentes ${pend.length ? `<span class="badge badge-warning">${pend.length}</span>` : ''}`;
    $('#dash-left-link').href = P.url('agenda', 'filtro=pendentes');
    $('#dash-left').innerHTML = pend.length ? pend.slice(0, 5).map((c) => `
      <div class="list-item">
        ${ui.avatar(P.q.pacienteNome(c.CPF_Paciente), 'sm')}
        <div class="grow"><div class="fw-700 truncate">${esc(P.q.pacienteNome(c.CPF_Paciente))}</div><div class="text-xs text-muted">${util.fmtDateTime(c.DataHora)} · ${c.Duracao} · ${c.Modalidade}</div></div>
        <button class="btn btn-success btn-sm" data-aceitar="${c.ID_Consulta}">${P.icon('check', 14)}<span class="hide-mobile">Aceitar</span></button>
        <a class="btn btn-ghost btn-sm" href="${P.url('agenda', `id=${c.ID_Consulta}&filtro=pendentes`)}">Mais</a>
      </div>`).join('') : ui.empty('check-circle', 'Nenhuma solicitação pendente', 'Tudo em dia na agenda.');

    // Confirmações de presença (regra das 36 h)
    const aConf = agenda.aConfirmar(db).filter((x) => x.s.codigo !== 'AGUARDANDO');
    const nAtraso = aConf.filter((x) => x.s.codigo === 'PENDENTE_CONFIRMACAO').length;
    $('#dash-confirmacoes').hidden = false;
    $('#conf-titulo').innerHTML = `Confirmações de presença ${nAtraso ? `<span class="badge badge-danger">${nAtraso} sem confirmação</span>` : aConf.length ? `<span class="badge badge-warning">${aConf.length} no prazo</span>` : ''}`;
    $('#conf-lista').innerHTML = aConf.length ? aConf.slice(0, 5).map(({ c, s }) => `
      <div class="list-item conf-${s.codigo}">
        ${ui.avatar(P.q.pacienteNome(c.CPF_Paciente), 'sm')}
        <div class="grow"><div class="fw-700 truncate">${esc(P.q.pacienteNome(c.CPF_Paciente))}</div>
          <div class="text-xs text-muted">${util.fmtDateTime(c.DataHora)} · ${s.codigo === 'PENDENTE_CONFIRMACAO' ? `prazo encerrado em ${util.fmtDateTime(s.prazo)}` : `confirmar até ${util.fmtDateTime(s.prazo)}`}</div></div>
        ${ui.statusBadge(s.codigo)}
        <button class="btn btn-outline btn-sm" data-registrar="${c.ID_Consulta}" title="Registrar confirmação recebida por telefone/chat">${P.icon('check', 14)}<span class="hide-mobile">Confirmar</span></button>
        ${s.codigo === 'PENDENTE_CONFIRMACAO' ? `<a class="btn btn-ghost btn-sm" href="${P.url('agenda', `id=${c.ID_Consulta}&filtro=confirmacao`)}">Liberar vaga</a>` : ''}
      </div>`).join('') : ui.empty('check-circle', 'Nenhuma confirmação pendente', `Consultas entram aqui ${agenda.rules.prazos(db).LembreteConfirmacaoHoras + agenda.rules.prazos(db).PrazoConfirmacaoHoras} h antes, quando o lembrete é enviado.`);

    // Agenda dos próximos 7 dias
    const ate = Date.now() + 7 * 864e5;
    const semana = db.consultas.filter((c) => c.Status === 'Agendada' && new Date(c.DataHora).getTime() >= Date.now() - 50 * 6e4 && new Date(c.DataHora).getTime() <= ate)
      .sort((a, b) => new Date(a.DataHora) - new Date(b.DataHora));
    $('#dash-agenda').innerHTML = semana.length ? semana.map((c) => `
      <a class="agenda-row" href="${P.url('agenda', `id=${c.ID_Consulta}`)}">
        <div class="agenda-time"><strong>${util.fmtTime(c.DataHora)}</strong><span>${util.sameDay(c.DataHora, new Date()) ? 'Hoje' : `${util.DIAS_CURTOS[new Date(c.DataHora).getDay()]} ${new Date(c.DataHora).getDate()}`}</span></div>
        <span class="agenda-bar ${c.Modalidade === 'Online' ? 'online' : ''}"></span>
        <div class="grow"><div class="fw-700 truncate">${esc(P.q.pacienteNome(c.CPF_Paciente))}</div><div class="text-xs text-muted truncate">${esc(c.Observacoes || 'Sessão individual')}</div></div>
        <span class="text-xs ${c.Modalidade === 'Online' ? 'mod-on' : 'mod-pre'} hide-mobile">${P.icon(c.Modalidade === 'Online' ? 'video' : 'pin', 13)}</span>
        ${confBadge(c)}
      </a>`).join('') : ui.empty('calendar', 'Semana livre', 'Nenhuma consulta confirmada nos próximos 7 dias.');

    // Pacientes recentes (por última consulta) com progresso das metas
    const ultimas = new Map();
    db.consultas.filter((c) => ['Realizada', 'Agendada'].includes(c.Status)).forEach((c) => {
      const t = new Date(c.DataHora).getTime();
      if (t <= Date.now() && (!ultimas.has(c.CPF_Paciente) || ultimas.get(c.CPF_Paciente) < t)) ultimas.set(c.CPF_Paciente, t);
    });
    const recentes = [...ultimas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    $('#dash-right-title').textContent = 'Pacientes recentes';
    $('#dash-right-link').href = P.url('metas');
    $('#dash-right').innerHTML = recentes.map(([cpf, t]) => {
      const p = P.q.paciente(cpf);
      const metasPac = db.metas.filter((m) => m.CPF_Paciente === cpf);
      const pct = P.services.metas ? P.services.metas.progressoGeral(metasPac) : 0;
      return `<a class="recent" href="${P.url('metas', `paciente=${encodeURIComponent(cpf)}`)}">
        <div class="row gap-6">${ui.avatar(p.Nome, 'sm')}<div class="grow"><div class="fw-700 truncate">${esc(p.Nome)}</div><div class="text-xs text-muted truncate">${esc((p.Tags || []).join(' · '))} · ${util.relTime(new Date(t).toISOString())}</div></div></div>
        ${metasPac.length ? `<div class="row gap-6 mt-8"><div class="grow">${ui.progress(pct)}</div><span class="text-xs fw-700">${pct}%</span></div>` : '<div class="text-xs text-muted mt-8">Sem metas definidas</div>'}
      </a>`;
    }).join('') || ui.empty('users', 'Sem atendimentos recentes');

    // Atividades recentes (auditoria)
    const ativ = db.auditoria.slice(0, 7);
    $('#dash-activity').innerHTML = ativ.length ? ativ.map((a) => `
      <div class="activity"><span class="dot" style="background:${a.Sucesso ? '#22c55e' : '#ef4444'}"></span>
        <div class="grow"><div class="text-sm fw-600">${esc(ACAO_LABEL[a.Acao] || a.Acao)}</div><div class="text-xs text-muted truncate">${esc(a.Detalhes)}</div></div>
        <span class="text-xs text-muted">${util.relTime(a.DataHora)}</span></div>`).join('')
      : ui.empty('activity', 'Sem atividades ainda', 'As ações realizadas no sistema aparecem aqui (auditoria LGPD).');
    $('#dash-activity-card').hidden = false;
  }

  function renderPaciente(user) {
    const db = P.db;
    const metas = db.metas.filter((m) => m.CPF_Paciente === user.id);
    const ativas = metas.filter((m) => m.Status === 'Ativa');
    const geral = P.services.metas ? P.services.metas.progressoGeral(metas) : 0;
    const testesPend = db.aplicacoesTeste.filter((a) => a.CPF_Paciente === user.id && a.Status === 'Pendente').length;
    const msgs = db.mensagens.filter((m) => m.Destinatario === user.id && !m.Lida).length;
    const propostas = db.consultas.filter((c) => c.CPF_Paciente === user.id && c.Status === 'Aguardando_Paciente').length;

    $('#dash-greeting').innerHTML = `${util.greeting()}, ${esc(util.firstName(user.nome))} 👋`;
    $('#dash-date').textContent = `${util.capitalize(util.fmtDateLong(new Date()))} de ${new Date().getFullYear()}`;
    $('#dash-kpis').innerHTML = [
      kpi(ativas.length, 'Metas ativas', `${P.icon('target', 13)} ${metas.filter((m) => m.Status === 'Concluida').length} concluídas`),
      kpi(`${geral}%`, 'Progresso geral', `${P.icon('trending', 13)} nas suas metas`, 'text-success'),
      kpi(testesPend, 'Testes pendentes', testesPend ? `<a href="${P.url('testes')}">Responder agora →</a>` : 'Tudo respondido', 'text-warning'),
      kpi(msgs, 'Mensagens não lidas', `<a href="${P.url('chat')}">Abrir chat →</a>`, 'text-primary'),
    ].join('');
    const confirmar = agenda.aConfirmar(db).filter((x) => x.c.CPF_Paciente === user.id && x.s.codigo !== 'AGUARDANDO');
    const alertaConf = confirmar.map(({ c, s }) => `<div class="alert ${s.codigo === 'PENDENTE_CONFIRMACAO' ? 'alert-danger' : 'alert-warning'} mb-12">${P.icon(s.codigo === 'PENDENTE_CONFIRMACAO' ? 'alert' : 'clock', 16)}<span class="grow">${s.codigo === 'PENDENTE_CONFIRMACAO'
      ? `O prazo para confirmar a consulta de <strong>${util.fmtDateTime(c.DataHora)}</strong> terminou (${s.prazoHoras} h antes). Confirme agora ou fale com a psicóloga.`
      : `Confirme sua presença na consulta de <strong>${util.fmtDateTime(c.DataHora)}</strong> até ${util.fmtDateTime(s.prazo)}.`}</span>
      <button class="btn btn-sm ${s.codigo === 'PENDENTE_CONFIRMACAO' ? 'btn-danger' : 'btn-dark'}" data-confirmar="${c.ID_Consulta}">${P.icon('check-circle', 14)}Confirmar presença</button></div>`).join('');
    $('#dash-hero').innerHTML = alertaConf + (propostas ? `<div class="alert alert-warning mb-12">${P.icon('swap', 16)}<span>A psicóloga sugeriu um novo horário para ${propostas} solicitação(ões). <a href="${P.url('agenda', 'filtro=pendentes')}"><strong>Responder na agenda</strong></a></span></div>` : '')
      + heroHtml(service.proximaConsulta(db, user.id), false);

    $('#dash-left-title').textContent = 'Suas metas ativas';
    $('#dash-left-link').href = P.url('metas');
    $('#dash-left').innerHTML = ativas.length ? ativas.map((m) => {
      const done = m.Checklist.filter((i) => i.concluido).length;
      return `<a class="list-item goal-mini" href="${P.url('metas')}">
        <span class="goal-mini-ic">${P.icon('target', 16)}</span>
        <div class="grow"><div class="row-between"><span class="fw-700 truncate">${esc(m.Descricao)}</span><span class="text-xs fw-700">${m.ProgressoPercentual}%</span></div>
          <div class="mt-4">${ui.progress(m.ProgressoPercentual, m.ProgressoPercentual >= 70 ? 'success' : '')}</div>
          <div class="text-xs text-muted mt-4">${done}/${m.Checklist.length} etapas · ${esc(m.Categoria || '')}</div></div>
      </a>`;
    }).join('') : ui.empty('target', 'Nenhuma meta ativa', 'Sua psicóloga definirá metas com você.');

    const minhas = db.consultas.filter((c) => c.CPF_Paciente === user.id && new Date(c.DataHora).getTime() >= Date.now() && ['Agendada', 'Pendente', 'Aguardando_Paciente'].includes(c.Status))
      .sort((a, b) => new Date(a.DataHora) - new Date(b.DataHora));
    $('#dash-agenda').innerHTML = minhas.length ? minhas.map((c) => `
      <a class="agenda-row" href="${P.url('agenda', `id=${c.ID_Consulta}`)}">
        <div class="agenda-time"><strong>${util.fmtTime(c.DataHora)}</strong><span>${util.DIAS_CURTOS[new Date(c.DataHora).getDay()]} ${new Date(c.DataHora).getDate()}</span></div>
        <span class="agenda-bar ${c.Modalidade === 'Online' ? 'online' : ''}"></span>
        <div class="grow"><div class="fw-700">${esc(db.psicologo.Nome)}</div><div class="text-xs text-muted">${c.Duracao} · ${c.Modalidade}</div></div>
        ${confBadge(c)}
      </a>`).join('') : ui.empty('calendar', 'Nenhuma consulta futura', 'Use a agenda para solicitar um horário.');

    $('#dash-right-title').textContent = 'Acesso rápido';
    $('#dash-right-link').href = P.url('agenda');
    $('#dash-right').innerHTML = `<div class="quick-grid">
      ${[['calendar', 'Solicitar consulta', 'Escolha um horário livre', 'agenda'], ['message', 'Chat', 'Falar com a psicóloga', 'chat'], ['file', 'Documentos', 'Laudos e arquivos', 'documentos'], ['test', 'Testes', 'Questionários enviados', 'testes']]
        .map(([ic, t, s, id]) => `<a class="quick" href="${P.url(id)}"><span class="quick-ic">${P.icon(ic, 18)}</span><span class="fw-700">${t}</span><span class="text-xs text-muted">${s}</span></a>`).join('')}
    </div>`;
    $('#dash-activity-card').hidden = true;
    $('#dash-cadastros').hidden = true;
    $('#dash-confirmacoes').hidden = true;
  }

  P.page({
    init() {
      $('#cad-lista').addEventListener('click', (e) => {
        const ap = e.target.closest('[data-aprovar]'); if (ap) { aprovarCadastro(ap.dataset.aprovar, ap.dataset.tipo); return; }
        const rc = e.target.closest('[data-recusar]'); if (rc) recusarCadastro(rc.dataset.recusar, rc.dataset.tipo);
      });
      const confirmar = (id, ok) => {
        try { agenda.confirmarPresenca(P.db, P.currentUser(), id); P.save('agenda'); ui.toast(ok, 'success'); } catch (err) { P.save(); ui.toast(err.message, 'error', 6000); }
      };
      $('#dash-hero').addEventListener('click', (e) => { const b = e.target.closest('[data-confirmar]'); if (b) confirmar(Number(b.dataset.confirmar), 'Presença confirmada. Até lá!'); });
      $('#conf-lista').addEventListener('click', (e) => { const b = e.target.closest('[data-registrar]'); if (b) confirmar(Number(b.dataset.registrar), 'Confirmação de presença registrada.'); });
      $('#dash-left').addEventListener('click', (e) => {
        const b = e.target.closest('[data-aceitar]'); if (!b) return;
        try {
          agenda.aceitar(P.db, P.currentUser(), Number(b.dataset.aceitar));
          P.save('agenda');
          ui.toast('Consulta confirmada. O paciente foi notificado.', 'success');
        } catch (err) { P.save(); ui.toast(err.message, 'error', 6000); }
      });
    },
    render() {
      const user = P.currentUser();
      $('#dash-agenda-title').textContent = user.tipo === 'psicologo' ? 'Agenda dos próximos 7 dias' : 'Suas próximas consultas';
      if (user.tipo === 'psicologo') renderPsicologa(user); else renderPaciente(user);
    },
  });
})(window.PRISMA);
