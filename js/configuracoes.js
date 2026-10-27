/* =========================================================================
   PRISMA — configuracoes.js
   Perfil, regras da agenda (prazos de 48 h / 36 h e limite de cancelamento), preferências
   (notificações, tema), privacidade/LGPD (auditoria, exportação e reset).
   ========================================================================= */
(function (P) {
  'use strict';
  const { util, core } = P;
  const { RuleError } = core;

  /* ---------- Service ---------- */
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const service = {
    atualizarPsicologa(db, user, dados) {
      if (user.tipo !== 'psicologo') throw new RuleError('Apenas a psicóloga altera este perfil.', 'RBAC');
      if (!dados.Nome) throw new RuleError('Informe o nome completo.', 'NOT NULL');
      if (!EMAIL_RE.test(dados.Email || '')) throw new RuleError('E-mail inválido.', 'Email');
      ['Nome', 'Email', 'Telefone', 'Especialidade', 'Abordagem', 'Consultorio', 'Bio'].forEach((k) => { if (k in dados) db.psicologo[k] = dados[k]; });
      core.audit(db, user, 'ATUALIZAR_PERFIL', 'Perfil da psicóloga atualizado', true);
    },
    /** CHK_LimiteAlteracao: inteiro entre 0 e 168 horas */
    definirLimite(db, user, horas) {
      if (user.tipo !== 'psicologo') throw new RuleError('Apenas a psicóloga configura o limite.', 'RBAC');
      const h = Number(horas);
      if (!Number.isInteger(h) || h < 0 || h > 168) throw new RuleError('O limite deve ser um número inteiro entre 0 e 168 horas.', 'CHK_LimiteAlteracao');
      const antes = db.psicologo.LimiteAlteracaoHoras;
      db.psicologo.LimiteAlteracaoHoras = h;
      core.audit(db, user, 'CONFIGURAR_LIMITE_AGENDA', `LimiteAlteracaoHoras: ${antes} → ${h}`, true);
    },
    /**
     * Prazos da agenda: antecedência para agendar / reagendar (padrão 48 h),
     * prazo de confirmação de presença (36 h) e antecedência do lembrete (24 h).
     */
    definirPrazos(db, user, dados) {
      if (user.tipo !== 'psicologo') throw new RuleError('Apenas a psicóloga configura os prazos da agenda.', 'RBAC');
      const campos = [
        ['AntecedenciaAgendamentoHoras', 'agendamento', 'Antecedência para agendar', 0, 336],
        ['AntecedenciaReagendamentoHoras', 'reagendamento', 'Antecedência para reagendar', 0, 336],
        ['PrazoConfirmacaoHoras', 'confirmacao', 'Prazo de confirmação', 1, 168],
        ['LembreteConfirmacaoHoras', 'lembrete', 'Antecedência do lembrete', 1, 168],
      ];
      const novos = {};
      campos.forEach(([col, k, label, min, max]) => {
        const h = Number(dados[k]);
        if (!Number.isInteger(h) || h < min || h > max) throw new RuleError(`${label}: informe um número inteiro entre ${min} e ${max} horas.`, `CHK_${col}`);
        novos[col] = h;
      });
      const antes = campos.map(([col]) => `${col}=${db.psicologo[col]}`).join(', ');
      Object.assign(db.psicologo, novos);
      core.audit(db, user, 'CONFIGURAR_PRAZOS_AGENDA', `${antes} → ${campos.map(([col]) => `${col}=${novos[col]}`).join(', ')}`, true);
    },
    atualizarPaciente(db, user, dados) {
      if (user.tipo !== 'paciente') throw new RuleError('Perfil inválido.', 'RBAC');
      const p = P.q.paciente(user.id, db);
      if (!dados.Nome) throw new RuleError('Informe o nome completo.', 'NOT NULL');
      if (!EMAIL_RE.test(dados.Email || '')) throw new RuleError('E-mail inválido.', 'Email');
      if (db.pacientes.some((x) => x.CPF !== p.CPF && x.Email.toLowerCase() === dados.Email.toLowerCase())) throw new RuleError('E-mail já utilizado por outro cadastro (UNIQUE).', 'UQ_Email');
      ['Nome', 'Email', 'Telefone', 'DataNascimento'].forEach((k) => { if (k in dados) p[k] = dados[k]; });
      core.audit(db, user, 'ATUALIZAR_PERFIL', 'Dados cadastrais do paciente atualizados', true);
    },
    /** LGPD: portabilidade — o paciente exporta apenas os próprios dados (sem prontuário). */
    exportar(db, user) {
      if (user.tipo === 'psicologo') return db;
      const cpf = user.id;
      return {
        exportadoEm: new Date().toISOString(), titular: P.q.paciente(cpf, db),
        consultas: db.consultas.filter((c) => c.CPF_Paciente === cpf), metas: db.metas.filter((m) => m.CPF_Paciente === cpf),
        documentos: db.documentos.filter((d) => d.CPF_Paciente === cpf).map(({ ConteudoBase64, ...d }) => d),
        laudosAtestados: db.laudosAtestados.filter((l) => l.CPF_Paciente === cpf),
        mensagens: db.mensagens.filter((m) => m.Remetente === cpf || m.Destinatario === cpf),
        testes: db.aplicacoesTeste.filter((a) => a.CPF_Paciente === cpf).map(({ Respostas, Pontuacao, Classificacao, ...a }) => a),
        observacao: 'Registros clínicos (prontuário) não são exportados por este canal — solicite à psicóloga (Resolução CFP nº 01/2009).',
      };
    },
  };
  P.services.configuracoes = service;

  if (document.body.dataset.page !== 'configuracoes') return;

  const { $, esc } = util;
  const ui = P.ui;
  const state = { secao: new URLSearchParams(location.search).get('secao') || 'perfil' };

  const SECOES = [
    { id: 'perfil', icon: 'user', label: 'Perfil', sub: 'Informações pessoais', grupo: 'Conta' },
    { id: 'agenda', icon: 'calendar', label: 'Regras da agenda', sub: 'Prazos de 48 h / 36 h e bloqueios', grupo: 'Conta', roles: ['psicologo'] },
    { id: 'cadastros', icon: 'users', label: 'Cadastros', sub: 'Aprovação e status de pacientes', grupo: 'Conta', roles: ['psicologo'] },
    { id: 'seguranca', icon: 'lock', label: 'Segurança', sub: 'Senha e sessão', grupo: 'Conta' },
    { id: 'privacidade', icon: 'shield', label: 'Privacidade', sub: 'Auditoria e dados (LGPD)', grupo: 'Conta' },
    { id: 'notificacoes', icon: 'bell', label: 'Notificações', sub: 'Alertas e lembretes', grupo: 'Preferências' },
    { id: 'aparencia', icon: 'moon', label: 'Aparência', sub: 'Tema claro ou escuro', grupo: 'Preferências' },
    { id: 'sobre', icon: 'info', label: 'Sobre o sistema', sub: 'Versão e arquitetura', grupo: 'Preferências' },
  ];

  function save(fn, ok) {
    try { fn(); P.save('config'); ui.toast(ok, 'success'); } catch (e) { ui.toast(e.message, 'error'); }
  }

  const field = (label, name, value, attrs = '') => `<div class="field"><label>${label}</label><input class="input" name="${name}" value="${esc(value || '')}" ${attrs}></div>`;

  function secPerfil(user) {
    const db = P.db;
    if (user.tipo === 'psicologo') {
      const p = db.psicologo;
      return `<div class="profile-top">${ui.avatar(p.Nome, 'xl')}<div><div class="h2">${esc(p.Nome)}</div><div class="text-sm text-muted">Psicóloga · CRP ${esc(p.CRP)}</div></div></div>
      <form id="form-perfil" class="form-grid mt-16">
        ${field('Nome completo', 'Nome', p.Nome, 'required maxlength="150"')}
        ${field('CRP', 'CRP', p.CRP, 'readonly title="Chave primária — não editável"')}
        ${field('E-mail', 'Email', p.Email, 'type="email" required maxlength="100"')}
        ${field('Telefone', 'Telefone', p.Telefone, 'maxlength="20"')}
        ${field('Especialidade', 'Especialidade', p.Especialidade, 'maxlength="100"')}
        ${field('Abordagem', 'Abordagem', p.Abordagem, 'maxlength="100"')}
        <div class="field full">${'<label>Consultório</label>'}<input class="input" name="Consultorio" value="${esc(p.Consultorio || '')}" maxlength="255"></div>
        <div class="field full"><label>Apresentação</label><textarea class="textarea" name="Bio" rows="3" maxlength="500">${esc(p.Bio || '')}</textarea></div>
        <div class="full"><button class="btn btn-dark" type="submit">${P.icon('check', 15)}Salvar alterações</button></div>
      </form>`;
    }
    const p = P.q.paciente(user.id);
    return `<div class="profile-top">${ui.avatar(p.Nome, 'xl')}<div><div class="h2">${esc(p.Nome)}</div><div class="text-sm text-muted">Paciente · ${esc(p.Email)}</div></div></div>
      <form id="form-perfil" class="form-grid mt-16">
        ${field('Nome completo', 'Nome', p.Nome, 'required maxlength="150"')}
        ${field('CPF', 'CPF', p.CPF, 'readonly title="Chave primária — não editável"')}
        ${field('E-mail', 'Email', p.Email, 'type="email" required maxlength="100"')}
        ${field('Telefone', 'Telefone', p.Telefone, 'maxlength="20"')}
        ${field('Data de nascimento', 'DataNascimento', p.DataNascimento, 'type="date"')}
        <div class="full"><button class="btn btn-dark" type="submit">${P.icon('check', 15)}Salvar alterações</button></div>
      </form>`;
  }

  function secAgenda() {
    const h = P.db.psicologo.LimiteAlteracaoHoras;
    const pz = P.services.agenda ? P.services.agenda.rules.prazos(P.db) : { AntecedenciaAgendamentoHoras: 48, AntecedenciaReagendamentoHoras: 48, PrazoConfirmacaoHoras: 36, LembreteConfirmacaoHoras: 24 };
    const bloqs = P.services.agenda ? P.services.agenda.listarBloqueios(P.db, P.currentUser()) : [];
    const num = (name, v, min, max, label, hint) => `<div class="field"><label>${label}</label><div class="row gap-6"><input class="input" type="number" name="${name}" value="${v}" min="${min}" max="${max}" step="1" required data-label="${label}" style="max-width:110px"><span class="text-sm text-2">horas</span></div><span class="hint">${hint}</span></div>`;
    return `<h2 class="h2">Regras da agenda</h2>
      <p class="text-sm text-2 mt-4">Prazos aplicados automaticamente às ações do paciente. Você (psicóloga) pode remarcar e cancelar a qualquer momento.</p>
      <form id="form-prazos" class="limit-box mt-16" style="max-width:640px">
        <h3 class="h3">Agendamento e confirmação</h3>
        <div class="form-grid">
          ${num('agendamento', pz.AntecedenciaAgendamentoHoras, 0, 336, 'Antecedência mínima para agendar', 'Horários antes de agora + este prazo ficam indisponíveis. Padrão: 48 h.')}
          ${num('reagendamento', pz.AntecedenciaReagendamentoHoras, 0, 336, 'Reagendar somente com mais de', 'Abaixo disso o paciente é orientado a falar com você. Padrão: 48 h.')}
          ${num('confirmacao', pz.PrazoConfirmacaoHoras, 1, 168, 'Confirmar presença até', 'Sem confirmação → PENDENTE_CONFIRMACAO. Padrão: 36 h.')}
          ${num('lembrete', pz.LembreteConfirmacaoHoras, 1, 168, 'Enviar lembrete antes do prazo', `Lembrete enviado ${pz.PrazoConfirmacaoHoras + pz.LembreteConfirmacaoHoras} h antes da consulta. Padrão: 24 h.`)}
        </div>
        <div><button class="btn btn-dark" type="submit">${P.icon('check', 15)}Salvar prazos</button></div>
      </form>
      <div class="limit-box mt-16" style="max-width:640px">
        <div class="row-between wrap"><h3 class="h3">Bloqueio de dias/horários</h3><a class="btn btn-outline btn-sm" href="${P.url('agenda', 'bloquear=1')}">${P.icon('lock', 14)}Novo bloqueio</a></div>
        <div class="text-sm text-2">${bloqs.length ? `${bloqs.length} bloqueio(s) ativo(s) ou futuro(s): ${bloqs.slice(0, 4).map((b) => `<strong>${util.esc(P.services.agenda.rules.rotuloBloqueio(b))}</strong>${b.Motivo ? ` (${util.esc(b.Motivo)})` : ''}`).join(' · ')}${bloqs.length > 4 ? '…' : ''}` : 'Nenhum bloqueio futuro.'}</div>
        <a class="text-sm fw-700" href="${P.url('agenda')}">Gerenciar bloqueios na Agenda →</a>
      </div>
      <h3 class="h3 mt-16">Cancelamento pelo paciente</h3>
      <p class="text-sm text-2 mt-4">Antecedência mínima para o paciente cancelar uma consulta já confirmada.</p>
      <form id="form-limite" class="limit-box mt-16">
        <div class="limit-value"><input class="input" type="number" name="horas" min="0" max="168" step="1" value="${h}" aria-label="Limite em horas"><span>horas</span></div>
        <input type="range" min="0" max="168" step="1" value="${h}" name="range" aria-label="Limite em horas (controle deslizante)">
        <div class="row wrap gap-6">${[0, 12, 24, 48, 72].map((v) => `<button type="button" class="chip ${v === h ? 'active' : ''}" data-preset="${v}">${v === 0 ? 'Sem limite' : `${v} h`}</button>`).join('')}</div>
        <div class="text-xs text-muted">Domínio: 0 a 168 horas (CHK_LimiteAlteracao). Valor padrão do projeto: 24 h.</div>
        <div><button class="btn btn-dark" type="submit">${P.icon('check', 15)}Salvar limite de cancelamento</button></div>
      </form>
      <div class="divider"></div>
      <h3 class="h3">Outras regras aplicadas automaticamente</h3>
      <ul class="rule-list mt-8">
        <li>${P.icon('clock', 15)} Intervalo mínimo de <strong>20 minutos</strong> entre consultas, considerando a duração de cada sessão.</li>
        <li>${P.icon('calendar', 15)} Não é possível agendar em datas passadas (TRG_Verifica_Data_Consulta).</li>
        <li>${P.icon('swap', 15)} Agendamento iniciado pelo paciente; confirmação final da psicóloga.</li>
        <li>${P.icon('pin', 15)} Durações permitidas: 30, 60, 90 ou 120 minutos.</li>
      </ul>`;
  }

  function secPrivacidade(user) {
    const db = P.db;
    const logs = user.tipo === 'psicologo' ? db.auditoria : db.auditoria.filter((a) => a.UsuarioId === user.id);
    return `<h2 class="h2">Privacidade e dados</h2>
      <p class="text-sm text-2 mt-4">${user.tipo === 'psicologo' ? 'Registro de auditoria de todas as operações sensíveis (LGPD, art. 37).' : 'Seus acessos e operações registrados na plataforma (LGPD, art. 18 — direito de acesso).'}</p>
      <div class="row wrap mt-16">
        <button class="btn btn-outline" data-export>${P.icon('download', 15)}${user.tipo === 'psicologo' ? 'Exportar banco (JSON)' : 'Exportar meus dados (JSON)'}</button>
        ${user.tipo === 'psicologo' ? `<button class="btn btn-ghost" data-reset>${P.icon('refresh', 15)}Restaurar dados de demonstração</button>` : ''}
      </div>
      <div class="card mt-16">
        <div class="card-head"><h3>Auditoria</h3><span class="text-xs text-muted">${logs.length} registro(s)</span></div>
        <div class="table-wrap audit">${logs.length ? `<table class="table"><thead><tr><th>Data/hora</th><th>Ação</th><th>Usuário</th><th>Detalhes</th><th>Resultado</th></tr></thead><tbody>
          ${logs.slice(0, 80).map((a) => `<tr><td class="nowrap text-xs">${util.fmtDateTime(a.DataHora)}</td><td class="mono text-xs">${esc(a.Acao)}</td><td class="text-xs">${esc(P.q.nomeUsuario(a.UsuarioId))}</td><td class="text-xs">${esc(a.Detalhes)}</td><td>${a.Sucesso ? '<span class="badge badge-success">OK</span>' : '<span class="badge badge-danger">Bloqueado</span>'}</td></tr>`).join('')}
        </tbody></table>` : ui.empty('shield', 'Nenhum registro ainda', 'As operações realizadas aparecem aqui.')}</div>
      </div>`;
  }

  const STATUS_CAD = {
    PENDENTE_APROVACAO: ['badge-warning', 'Aguardando aprovação'], ATIVO: ['badge-success', 'Ativo'],
    REJEITADO: ['badge-danger', 'Rejeitado'], INATIVO: ['badge-neutral', 'Inativo'],
  };
  const badgeCad = (st) => `<span class="badge ${(STATUS_CAD[st] || [])[0] || 'badge-neutral'}">${esc((STATUS_CAD[st] || [])[1] || st)}</span>`;

  function secCadastros() {
    const db = P.db;
    const filtro = state.filtroCad || 'todos';
    const ordem = { PENDENTE_APROVACAO: 0, ATIVO: 1, INATIVO: 2, REJEITADO: 3 };
    const lista = db.pacientes.filter((p) => filtro === 'todos' || p.Status === filtro)
      .sort((a, b) => (ordem[a.Status] - ordem[b.Status]) || a.Nome.localeCompare(b.Nome));
    const count = (st) => db.pacientes.filter((p) => p.Status === st).length;
    const chips = [['todos', 'Todos', db.pacientes.length], ['PENDENTE_APROVACAO', 'Pendentes', count('PENDENTE_APROVACAO')], ['ATIVO', 'Ativos', count('ATIVO')], ['INATIVO', 'Inativos', count('INATIVO')], ['REJEITADO', 'Rejeitados', count('REJEITADO')]];
    const acoes = (p) => {
      const b = (acao, label, variant, icon) => `<button class="btn btn-sm ${variant}" data-cad="${acao}" data-cpf="${esc(p.CPF)}">${P.icon(icon, 13)}${label}</button>`;
      if (p.Status === 'PENDENTE_APROVACAO') return b('aprovar', 'Aprovar', 'btn-success', 'check') + b('recusar', 'Recusar', 'btn-danger', 'x');
      if (p.Status === 'ATIVO') return b('INATIVO', 'Inativar', 'btn-ghost', 'lock');
      return b('ATIVO', 'Reativar', 'btn-outline', 'refresh');
    };
    return `<h2 class="h2">Cadastros de pacientes</h2>
      <p class="text-sm text-2 mt-4">Todo novo cadastro começa como <strong>aguardando aprovação</strong> e só acessa a plataforma depois de aprovado por um(a) psicólogo(a).</p>
      <div class="chips mt-16">${chips.map(([id, l, n]) => `<button class="chip ${filtro === id ? 'active' : ''}" data-filtro-cad="${id}">${l} <span class="count">${n}</span></button>`).join('')}</div>
      <div class="card mt-16"><div class="table-wrap">${lista.length ? `<table class="table">
        <thead><tr><th>Paciente</th><th>Status</th><th></th></tr></thead>
        <tbody>${lista.map((p) => `<tr>
          <td><div class="fw-700">${esc(p.Nome)}</div><div class="text-xs text-muted">CPF ${esc(p.CPF)} · ${esc(p.Email)}</div></td>
          <td>${badgeCad(p.Status)}
            <div class="text-xs text-muted mt-4">Solicitado em ${p.Data_Solicitacao ? util.fmtDate(p.Data_Solicitacao) : '—'}${p.Data_Aprovacao ? ` · aprovado em ${util.fmtDate(p.Data_Aprovacao)} por ${esc(P.q.nomeUsuario(p.CRP_Psicologo_Aprovador))}` : p.CRP_Psicologo_Aprovador ? ` · analisado por ${esc(P.q.nomeUsuario(p.CRP_Psicologo_Aprovador))}` : ''}</div>
            ${p.MotivoRejeicao ? `<div class="text-xs text-muted">Motivo: ${esc(p.MotivoRejeicao)}</div>` : ''}</td>
          <td><div class="row gap-6" style="justify-content:flex-end">${acoes(p)}</div></td>
        </tr>`).join('')}</tbody></table>` : ui.empty('users', 'Nenhum cadastro com este status')}</div></div>`;
  }

  function secSeguranca(user) {
    const s = P.session || {};
    return `<h2 class="h2">Segurança</h2>
      <p class="text-sm text-2 mt-4">Sessão iniciada em ${s.inicio ? util.fmtDateTime(s.inicio) : '—'} · ${s.lembrar ? 'lembrada neste navegador por 30 dias' : 'expira ao fechar a aba (máx. 8 h)'}.</p>
      <form id="form-senha" class="form-grid mt-16" style="max-width:560px" autocomplete="off">
        <div class="field full"><label>Senha atual</label><input class="input" type="password" name="atual" required autocomplete="current-password"></div>
        <div class="field"><label>Nova senha</label><input class="input" type="password" name="nova" required autocomplete="new-password"><span class="hint">Mínimo 8 caracteres, com letras e números.</span></div>
        <div class="field"><label>Confirmar nova senha</label><input class="input" type="password" name="confirmar" required autocomplete="new-password"></div>
        <div class="full"><button class="btn btn-dark" type="submit">${P.icon('lock', 15)}Alterar senha</button></div>
      </form>
      <div class="divider"></div>
      <button class="btn btn-outline" data-sair>${P.icon('logout', 15)}Sair desta conta</button>`;
  }

  function secNotificacoes() {
    const n = P.prefs.notificacoes || {};
    const row = (k, t, s) => `<label class="pref-row"><div class="grow"><div class="fw-700">${t}</div><div class="text-xs text-muted">${s}</div></div><span class="switch"><input type="checkbox" data-pref="${k}" ${n[k] !== false ? 'checked' : ''}><span></span></span></label>`;
    return `<h2 class="h2">Notificações</h2>
      <p class="text-sm text-2 mt-4">Preferências de lembretes (Firebase Cloud Messaging — simulado neste protótipo).</p>
      <div class="card mt-16">
        ${row('consultas', 'Consultas próximas', 'Lembrete antes de cada consulta confirmada.')}
        ${row('solicitacoes', 'Solicitações da agenda', 'Novas solicitações, contrapropostas e cancelamentos.')}
        ${row('metas', 'Metas terapêuticas', 'Lembretes de metas ativas e conclusões.')}
        ${row('mensagens', 'Mensagens', 'Novas mensagens no chat.')}
      </div>`;
  }

  function secAparencia() {
    const t = document.documentElement.dataset.theme;
    return `<h2 class="h2">Aparência</h2>
      <div class="theme-grid mt-16">
        <button class="theme-opt ${t !== 'dark' ? 'active' : ''}" data-theme-set="light"><span class="theme-prev light"></span>${P.icon('sun', 15)} Claro</button>
        <button class="theme-opt ${t === 'dark' ? 'active' : ''}" data-theme-set="dark"><span class="theme-prev dark"></span>${P.icon('moon', 15)} Escuro</button>
      </div>
      <div class="field mt-16" style="max-width:260px"><label>Idioma</label><select class="select" disabled><option>Português (Brasil)</option></select></div>`;
  }

  function secSobre() {
    return `<h2 class="h2">Sobre o PRISMA</h2>
      <p class="text-sm text-2 mt-4">Plataforma de Registro, Interação e Suporte de Metas Assistidas · versão ${P.version} (arquitetura modular).</p>
      <div class="about-grid mt-16">
        <div><span>Front-end</span><strong>HTML5 · CSS3 · JavaScript (ES2025)</strong></div>
        <div><span>Banco de dados</span><strong>MySQL 8.4 LTS — <a href="${document.body.dataset.root}/database/schema.sql" target="_blank" rel="noopener">schema.sql</a></strong></div>
        <div><span>Persistência do protótipo</span><strong>localStorage (espelha as tabelas)</strong></div>
        <div><span>Arquivos</span><strong>Google Drive API v3 (simulada) + fallback local</strong></div>
        <div><span>Notificações</span><strong>Firebase Cloud Messaging (simulado)</strong></div>
        <div><span>Módulos</span><strong>${P.NAV.map((n) => n.label).join(' · ')}</strong></div>
      </div>`;
  }

  function render() {
    const user = P.currentUser();
    const secs = SECOES.filter((s) => !s.roles || s.roles.includes(user.tipo));
    if (!secs.some((s) => s.id === state.secao)) state.secao = 'perfil';
    let grupo = null;
    $('#cfg-menu').innerHTML = `<button class="cfg-user" data-secao="perfil">${ui.avatar(user.nome)}<div class="grow"><div class="fw-700 truncate">${esc(user.nome)}</div><div class="text-xs text-muted truncate">${esc(user.email)}</div></div>${P.icon('chevron-right', 16)}</button>`
      + secs.map((s) => {
        const g = s.grupo !== grupo ? `<div class="nav-section">${s.grupo}</div>` : ''; grupo = s.grupo;
        return `${g}<button class="cfg-item ${state.secao === s.id ? 'active' : ''}" data-secao="${s.id}">${P.icon(s.icon, 17)}<div class="grow"><div class="fw-700">${s.label}</div><div class="text-xs sub">${s.sub}</div></div>${P.icon('chevron-right', 15)}</button>`;
      }).join('');
    const map = { cadastros: secCadastros, seguranca: secSeguranca, perfil: secPerfil, agenda: secAgenda, privacidade: secPrivacidade, notificacoes: secNotificacoes, aparencia: secAparencia, sobre: secSobre };
    const panel = $('#cfg-panel');
    // não sobrescreve um formulário em edição quando outra aba altera o banco
    if (panel.dataset.secao === state.secao && panel.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return;
    panel.dataset.secao = state.secao;
    panel.innerHTML = map[state.secao](user);
  }

  P.page({
    init() {
      $('#cfg-menu').addEventListener('click', (e) => {
        const b = e.target.closest('[data-secao]'); if (!b) return;
        state.secao = b.dataset.secao; $('#cfg-panel').dataset.secao = ''; render();
        if (window.innerWidth < 1024) $('#cfg-panel').scrollIntoView({ behavior: 'smooth' });
      });
      const panel = $('#cfg-panel');
      panel.addEventListener('submit', (e) => {
        e.preventDefault();
        const d = util.formData(e.target);
        const user = P.currentUser();
        if (e.target.id === 'form-perfil') {
          save(() => (user.tipo === 'psicologo' ? service.atualizarPsicologa(P.db, user, d) : service.atualizarPaciente(P.db, user, d)), 'Perfil atualizado.');
        } else if (e.target.id === 'form-senha') {
          const form = e.target;
          P.services.auth.alterarSenha(P.db, user, d.atual, d.nova, d.confirmar)
            .then(() => { P.save('senha'); form.reset(); ui.toast('Senha alterada com sucesso.', 'success'); })
            .catch((err) => { P.save(); ui.toast(err.message, 'error'); });
        } else if (e.target.id === 'form-prazos') {
          save(() => service.definirPrazos(P.db, user, d), 'Prazos da agenda atualizados.');
        } else if (e.target.id === 'form-limite') {
          save(() => service.definirLimite(P.db, user, d.horas), `Limite de cancelamento definido para ${d.horas} h.`);
        }
      });
      panel.addEventListener('input', (e) => {
        const f = e.target.form;
        if (!f || f.id !== 'form-limite') return;
        if (e.target.name === 'range') f.horas.value = e.target.value;
        if (e.target.name === 'horas') f.range.value = e.target.value;
      });
      panel.addEventListener('click', (e) => {
        const fc = e.target.closest('[data-filtro-cad]');
        if (fc) { state.filtroCad = fc.dataset.filtroCad; panel.dataset.secao = ''; render(); return; }
        if (e.target.closest('[data-sair]')) { P.shell.confirmLogout(); return; }
        const cad = e.target.closest('[data-cad]');
        if (cad) {
          const auth = P.services.auth; const cpf = cad.dataset.cpf; const acao = cad.dataset.cad; const u = P.currentUser();
          const run = (fn, ok) => { try { fn(); P.save('cadastro'); panel.dataset.secao = ''; render(); ui.toast(ok, 'success'); } catch (err) { P.save(); ui.toast(err.message, 'error'); } };
          if (acao === 'aprovar') run(() => auth.aprovarPaciente(P.db, u, cpf), 'Cadastro aprovado. Acesso liberado.');
          else if (acao === 'recusar') {
            ui.formModal({ title: 'Recusar cadastro', size: 'sm', submitLabel: 'Recusar', submitVariant: 'btn-danger',
              body: '<div class="field"><label>Motivo (opcional)</label><textarea class="textarea" name="motivo" maxlength="255"></textarea></div>',
              onSubmit: (dd) => { auth.recusarPaciente(P.db, P.currentUser(), cpf, dd.motivo); P.save('cadastro'); panel.dataset.secao = ''; render(); ui.toast('Cadastro recusado.', 'success'); } });
          } else if (acao === 'INATIVO') {
            ui.confirm({ title: 'Inativar paciente', message: 'O paciente perde o acesso imediatamente (sessões abertas são encerradas). Os dados clínicos são mantidos.', confirmLabel: 'Inativar', variant: 'btn-danger',
              onConfirm: () => run(() => auth.alterarStatusPaciente(P.db, P.currentUser(), cpf, 'INATIVO'), 'Paciente inativado.') });
          } else run(() => auth.alterarStatusPaciente(P.db, u, cpf, 'ATIVO'), 'Acesso reativado.');
          return;
        }
        const pre = e.target.closest('[data-preset]');
        if (pre) { const f = $('#form-limite'); f.horas.value = f.range.value = pre.dataset.preset; util.$$('[data-preset]').forEach((c) => c.classList.toggle('active', c === pre)); }
        const th = e.target.closest('[data-theme-set]');
        if (th) { P.setTheme(th.dataset.themeSet); panel.dataset.secao = ''; render(); }
        if (e.target.closest('[data-export]')) {
          const user = P.currentUser();
          const data = service.exportar(P.db, user);
          core.audit(P.db, user, 'EXPORTAR_DADOS', user.tipo === 'psicologo' ? 'Exportação completa do banco' : 'Exportação de dados do titular (portabilidade)', true);
          P.save('export');
          ui.download(`prisma-${user.tipo}-${util.isoDate()}.json`, JSON.stringify(data, null, 2), 'application/json');
        }
        if (e.target.closest('[data-reset]')) {
          ui.confirm({ title: 'Restaurar dados de demonstração', message: 'Todos os dados locais (consultas, metas, mensagens, documentos…) serão substituídos pelo conjunto inicial.', confirmLabel: 'Restaurar', variant: 'btn-danger',
            onConfirm: () => { P.resetDemo(); ui.toast('Dados de demonstração restaurados.', 'success'); } });
        }
      });
      panel.addEventListener('change', (e) => {
        const k = e.target.dataset.pref; if (!k) return;
        P.prefs.notificacoes = { ...(P.prefs.notificacoes || {}), [k]: e.target.checked };
        P.savePrefs();
        ui.toast('Preferência salva.', 'success');
      });
    },
    render,
  });
})(window.PRISMA);
