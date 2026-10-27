/* =========================================================================
   PRISMA — agenda.js
   Service (regras de agendamento) + controlador da página Agenda.

   Regras implementadas (espelham os triggers do database/schema.sql):
     • TRG_Verifica_Data_Consulta ..... não permite agendar em data passada
     • TRG_Evita_Choque_Horario ....... não permite sobreposição de consultas
                                        ativas considerando a duração + intervalo
                                        mínimo de 20 minutos entre atendimentos
     • TRG_Bloqueio_Agenda ............ nenhum agendamento em dias/horários
                                        bloqueados pela psicóloga (BloqueioAgenda)
     • TRG_Antecedencia_Agendamento ... paciente só agenda com no mínimo 48 h
                                        de antecedência (agora + 48 h)
     • TRG_Limite_Alteracao_Agenda .... paciente só REAGENDA se faltarem mais de
                                        48 h; só CANCELA consulta confirmada com a
                                        antecedência de LimiteAlteracaoHoras (24 h)
     • EVT_Confirmacao_Presenca ....... presença confirmada até 36 h antes;
                                        lembrete antes do prazo e alerta
                                        PENDENTE_CONFIRMACAO para a psicóloga
     • Fluxo: o paciente SOLICITA → a psicóloga ACEITA, RECUSA ou SUGERE outro
       horário (contraproposta) → o paciente aceita/recusa a sugestão.

   Os prazos (48 h / 48 h / 36 h / lembrete) ficam no cadastro da psicóloga e
   podem ser ajustados em Configurações → Regras da agenda.
   ========================================================================= */
(function (P) {
  'use strict';
  const { util, core } = P;
  const { RuleError } = core;

  /* =====================================================================
     SERVICE
     ===================================================================== */
  const DURACOES = { '30 min': 30, '60 min': 60, '90 min': 90, '120 min': 120 };
  const INTERVALO_MINIMO_MIN = 20;
  const STATUS_INATIVOS = ['Cancelada', 'Recusada'];
  const STATUS_ATIVOS = ['Pendente', 'Agendada', 'Aguardando_Paciente'];
  const EXPEDIENTE = { inicio: '08:00', fim: '21:00', passoMin: 30 };
  const PRAZOS_PADRAO = {
    LimiteAlteracaoHoras: 24,            // cancelamento pelo paciente
    AntecedenciaAgendamentoHoras: 48,    // novo agendamento
    AntecedenciaReagendamentoHoras: 48,  // reagendamento pelo paciente
    PrazoConfirmacaoHoras: 36,           // confirmação de presença
    LembreteConfirmacaoHoras: 24,        // lembrete: X h antes do prazo de confirmação
  };
  const H = 36e5;

  const MSG = {
    reagendamento: (h) => `Reagendamentos só podem ser realizados com pelo menos ${h} horas de antecedência. Entre em contato diretamente com a psicóloga.`,
    agendamento: (h, aPartir) => `Novos agendamentos exigem pelo menos ${h} horas de antecedência. Escolha um horário a partir de ${aPartir}.`,
    bloqueioPaciente: 'Data indisponível: a agenda da psicóloga está bloqueada neste período. Escolha outra data.',
  };

  const minutos = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const inicioDoDia = (dateStr) => util.parseDate(dateStr).getTime();
  const fmtH = (h) => Math.max(0, h).toFixed(1).replace('.', ',').replace(',0', '');

  const rules = {
    DURACOES, INTERVALO_MINIMO_MIN, EXPEDIENTE, PRAZOS_PADRAO, MSG,

    duracaoMin: (d) => DURACOES[d] || 60,

    /** Prazos configurados pela psicóloga (com os valores padrão do projeto). */
    prazos(db) {
      const out = { ...PRAZOS_PADRAO };
      Object.keys(PRAZOS_PADRAO).forEach((k) => { if (db.psicologo[k] != null && db.psicologo[k] !== '') out[k] = Number(db.psicologo[k]); });
      return out;
    },

    /** TRG_Verifica_Data_Consulta */
    verificaDataConsulta(iso) {
      if (!iso || isNaN(new Date(iso))) throw new RuleError('Data/hora inválida.', 'TRG_Verifica_Data_Consulta');
      if (new Date(iso).getTime() < Date.now()) {
        throw new RuleError('Não é possível agendar uma consulta em data passada.', 'TRG_Verifica_Data_Consulta');
      }
    },

    /** CHK_Duracao_Consulta */
    verificaDuracao(duracao) {
      if (!DURACOES[duracao]) throw new RuleError("Duração inválida. Opções: '30 min', '60 min', '90 min' ou '120 min'.", 'CHK_Duracao_Consulta');
    },

    /**
     * TRG_Evita_Choque_Horario — choque exato ou sobreposição considerando
     * a duração das duas consultas e o intervalo mínimo de 20 minutos.
     * Horários sugeridos em contrapropostas pendentes também ficam reservados.
     */
    evitaChoqueHorario(db, iso, duracao = '60 min', ignorarId = null) {
      const inicioNovo = new Date(iso).getTime();
      const fimNovo = inicioNovo + rules.duracaoMin(duracao) * 6e4;
      const gap = INTERVALO_MINIMO_MIN * 6e4;
      const crp = db.psicologo.CRP;

      for (const c of db.consultas) {
        if (ignorarId != null && c.ID_Consulta === Number(ignorarId)) continue;
        if (c.CRP_Psicologo !== crp || STATUS_INATIVOS.includes(c.Status)) continue;
        const ocupados = [c.DataHora];
        if (c.Status === 'Aguardando_Paciente' && c.DataHoraSugerida) ocupados.push(c.DataHoraSugerida);

        for (const inicioIso of ocupados) {
          const ini = new Date(inicioIso).getTime();
          const fim = ini + rules.duracaoMin(c.Duracao) * 6e4;
          if (ini === inicioNovo) {
            throw new RuleError('O psicólogo já possui consulta ativa neste horário.', 'TRG_Evita_Choque_Horario');
          }
          if (inicioNovo < fim + gap && fimNovo + gap > ini) {
            throw new RuleError(
              `Conflito de agenda com a consulta das ${util.fmtTime(ini)} (${c.Duracao}) em ${util.fmtDate(ini)}. É necessário um intervalo mínimo de ${INTERVALO_MINIMO_MIN} minutos entre consultas.`,
              'TRG_Evita_Choque_Horario'
            );
          }
        }
      }
    },

    /* ---------------- Bloqueios da agenda (BloqueioAgenda) ---------------- */

    /** Bloqueios da psicóloga que se sobrepõem ao intervalo [iniMs, fimMs). */
    bloqueiosNoPeriodo(db, iniMs, fimMs, ignorarId = null) {
      return (db.bloqueios || []).filter((b) => b.CRP_Psicologo === db.psicologo.CRP
        && (ignorarId == null || b.ID_Bloqueio !== Number(ignorarId))
        && new Date(b.Data_Inicio).getTime() < fimMs && new Date(b.Data_Fim).getTime() > iniMs);
    },

    /** TRG_Bloqueio_Agenda — a consulta (início + duração) não pode tocar um período bloqueado. */
    verificaBloqueio(db, iso, duracao = '60 min', user = null) {
      const ini = new Date(iso).getTime();
      const [b] = rules.bloqueiosNoPeriodo(db, ini, ini + rules.duracaoMin(duracao) * 6e4);
      if (!b) return;
      if (user && user.tipo === 'psicologo') {
        throw new RuleError(`Horário dentro de um bloqueio da agenda (${rules.rotuloBloqueio(b)}${b.Motivo ? ` — ${b.Motivo}` : ''}). Edite ou remova o bloqueio para usar este horário.`, 'TRG_Bloqueio_Agenda');
      }
      throw new RuleError(MSG.bloqueioPaciente, 'TRG_Bloqueio_Agenda');
    },

    /**
     * Quanto do expediente de um dia está bloqueado:
     * 'total' (dia indisponível), 'parcial' (alguns horários) ou null.
     */
    coberturaBloqueio(db, dateStr) {
      const dia0 = inicioDoDia(dateStr);
      const ini = dia0 + minutos(EXPEDIENTE.inicio) * 6e4;
      const fim = dia0 + minutos(EXPEDIENTE.fim) * 6e4;
      const bls = rules.bloqueiosNoPeriodo(db, ini, fim);
      if (!bls.length) return { tipo: null, bloqueios: [] };
      const faixas = bls.map((b) => [Math.max(ini, new Date(b.Data_Inicio).getTime()), Math.min(fim, new Date(b.Data_Fim).getTime())]).sort((a, b) => a[0] - b[0]);
      let cursor = ini;
      for (const [a, z] of faixas) { if (a > cursor) break; cursor = Math.max(cursor, z); }
      return { tipo: cursor >= fim - 1000 ? 'total' : 'parcial', bloqueios: bls };
    },

    rotuloBloqueio(b) {
      const i = new Date(b.Data_Inicio), f = new Date(b.Data_Fim);
      const d = (x) => `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}`;
      if (b.DiaInteiro) {
        const dias = Math.round((inicioDoDia(util.isoDate(f)) - inicioDoDia(util.isoDate(i))) / 864e5) + 1;
        return dias > 1 ? `${d(i)} a ${d(f)} · ${dias} dias` : `${d(i)} · dia inteiro`;
      }
      return util.sameDay(i, f) ? `${d(i)} · ${util.fmtTime(i)}–${util.fmtTime(f)}` : `${d(i)} ${util.fmtTime(i)} a ${d(f)} ${util.fmtTime(f)}`;
    },

    /* ---------------- Prazos de 48 h ---------------- */

    /** TRG_Antecedencia_Agendamento — paciente: novo horário ≥ agora + 48 h. */
    verificaAntecedenciaAgendamento(db, iso, user) {
      if (!user || user.tipo !== 'paciente') return;
      const h = rules.prazos(db).AntecedenciaAgendamentoHoras;
      const minimo = Date.now() + h * H;
      if (new Date(iso).getTime() < minimo) {
        throw new RuleError(MSG.agendamento(h, util.fmtDateTime(minimo)), 'TRG_Antecedencia_Agendamento');
      }
    },

    /** Paciente só reagenda se faltarem MAIS de 48 h para a consulta. */
    validaReagendamento(db, consulta, user) {
      const limiteHoras = rules.prazos(db).AntecedenciaReagendamentoHoras;
      if (!user || user.tipo === 'psicologo') return { permitido: true, horasRestantes: Infinity, limiteHoras };
      const horasRestantes = Math.round(util.hoursUntil(consulta.DataHora) * 10) / 10;
      if (horasRestantes <= limiteHoras) return { permitido: false, horasRestantes, limiteHoras, mensagem: MSG.reagendamento(limiteHoras) };
      return { permitido: true, horasRestantes, limiteHoras };
    },

    /** Cancelamento de consulta confirmada pelo paciente (LimiteAlteracaoHoras, padrão 24 h). */
    validaLimiteAlteracao(db, consulta, user) {
      const limiteHoras = rules.prazos(db).LimiteAlteracaoHoras;
      if (user.tipo === 'psicologo') return { permitido: true, horasRestantes: Infinity, limiteHoras };
      const horasRestantes = Math.round(util.hoursUntil(consulta.DataHora) * 10) / 10;
      if (consulta.Status === 'Agendada' && horasRestantes < limiteHoras) {
        return {
          permitido: false, horasRestantes, limiteHoras,
          mensagem: `Cancelamento não permitido: consultas confirmadas exigem antecedência mínima de ${limiteHoras} h (faltam ${fmtH(horasRestantes)} h). Fale com a ${db.psicologo.Nome} pelo chat.`,
        };
      }
      return { permitido: true, horasRestantes, limiteHoras };
    },

    /**
     * Valida um novo horário de uma só vez: duração, data, antecedência de 48 h
     * (paciente), bloqueios da psicóloga e choque de horário.
     */
    validaNovoHorario(db, iso, duracao, ignorarId, user = null) {
      rules.verificaDuracao(duracao);
      rules.verificaDataConsulta(iso);
      rules.verificaAntecedenciaAgendamento(db, iso, user);
      rules.verificaBloqueio(db, iso, duracao, user);
      rules.evitaChoqueHorario(db, iso, duracao, ignorarId);
    },

    /** Lista de horários de um dia com o motivo de indisponibilidade de cada um. */
    horariosDisponiveis(db, dateStr, duracao = '60 min', ignorarId = null, user = null) {
      const fimDia = minutos(EXPEDIENTE.fim);
      const TIPO = { TRG_Verifica_Data_Consulta: 'passado', TRG_Antecedencia_Agendamento: 'antecedencia', TRG_Bloqueio_Agenda: 'bloqueio' };
      const paciente = user && user.tipo === 'paciente';
      const h = rules.prazos(db).AntecedenciaAgendamentoHoras;
      const slots = [];
      for (let t = minutos(EXPEDIENTE.inicio); t + rules.duracaoMin(duracao) <= fimDia; t += EXPEDIENTE.passoMin) {
        const hhmm = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
        const iso = util.combine(dateStr, hhmm);
        let livre = true, motivo = '', tipo = null;
        try { rules.validaNovoHorario(db, iso, duracao, ignorarId, user); } catch (e) {
          livre = false; tipo = TIPO[e.regra] || 'ocupado';
          motivo = paciente ? { passado: 'Horário já passou', antecedencia: `Antecedência mínima de ${h} h`, bloqueio: 'Agenda bloqueada pela psicóloga', ocupado: 'Horário ocupado' }[tipo] : e.message;
        }
        slots.push({ hora: hhmm, iso, livre, motivo, tipo });
      }
      return slots;
    },

    /**
     * Situação de um dia no calendário de agendamento:
     * 'passado' | 'bloqueado' | 'antecedencia' | 'lotado' | 'parcial' | 'livre'.
     */
    situacaoDia(db, dateStr, duracao = '60 min', ignorarId = null, user = null) {
      if (dateStr < util.isoDate()) return { tipo: 'passado', livres: 0 };
      const cob = rules.coberturaBloqueio(db, dateStr);
      if (cob.tipo === 'total') return { tipo: 'bloqueado', livres: 0, bloqueios: cob.bloqueios };
      const slots = rules.horariosDisponiveis(db, dateStr, duracao, ignorarId, user);
      const livres = slots.filter((s) => s.livre).length;
      if (livres) return { tipo: cob.tipo === 'parcial' ? 'parcial' : 'livre', livres, bloqueios: cob.bloqueios };
      if (slots.every((s) => s.tipo === 'passado' || s.tipo === 'antecedencia' || s.tipo === 'bloqueio') && slots.some((s) => s.tipo === 'antecedencia')) return { tipo: 'antecedencia', livres: 0 };
      if (slots.every((s) => s.tipo === 'passado')) return { tipo: 'passado', livres: 0 };
      return { tipo: 'lotado', livres: 0, bloqueios: cob.bloqueios };
    },

    /* ---------------- Confirmação de presença (36 h) ---------------- */

    /**
     * Situação da confirmação de uma consulta confirmada (Agendada) e futura:
     *   CONFIRMADA · AGUARDANDO (antes do lembrete) · LEMBRETE (janela do
     *   lembrete, prazo ainda aberto) · PENDENTE_CONFIRMACAO (prazo vencido).
     */
    situacaoConfirmacao(db, c, agora = Date.now()) {
      if (!c || c.Status !== 'Agendada') return null;
      const t = new Date(c.DataHora).getTime();
      if (t <= agora) return null;
      const { PrazoConfirmacaoHoras: pc, LembreteConfirmacaoHoras: pl } = rules.prazos(db);
      const prazo = t - pc * H;
      const lembrete = prazo - pl * H;
      const base = { prazo, lembrete, prazoHoras: pc, horasParaPrazo: (prazo - agora) / H };
      if (c.StatusConfirmacao === 'CONFIRMADA') return { ...base, codigo: 'CONFIRMADA', tardia: !!c.ConfirmacaoTardia };
      if (agora >= prazo) return { ...base, codigo: 'PENDENTE_CONFIRMACAO' };
      return { ...base, codigo: agora >= lembrete ? 'LEMBRETE' : 'AGUARDANDO' };
    },
  };

  function assertPsicologa(user, acao) {
    if (user.tipo !== 'psicologo') throw new RuleError(`Apenas a psicóloga pode ${acao}.`, 'RBAC');
  }
  function getConsulta(db, id) {
    const c = db.consultas.find((x) => x.ID_Consulta === Number(id));
    if (!c) throw new RuleError('Consulta não encontrada.', 'FK');
    return c;
  }
  function assertDono(db, user, c) {
    if (user.tipo === 'paciente' && c.CPF_Paciente !== user.id) {
      core.audit(db, user, 'ACESSO_NEGADO_LGPD', `Tentativa de alterar a consulta ${c.ID_Consulta} de outro paciente`, false);
      throw new RuleError('Acesso negado: esta consulta pertence a outro paciente.', 'LGPD');
    }
  }
  const quando = (iso) => `${util.fmtDate(iso)} às ${util.fmtTime(iso)}`;

  /** Reinicia a confirmação de presença (nova consulta ou novo horário). */
  function reiniciarConfirmacao(c) {
    Object.assign(c, {
      StatusConfirmacao: c.Status === 'Agendada' ? 'AGUARDANDO' : null,
      ConfirmadaEm: null, ConfirmadaPor: null, ConfirmacaoTardia: false, LembreteConfirmacaoEm: null, AlertaConfirmacaoEm: null,
    });
  }

  /** Converte os campos do formulário de bloqueio em um período [início, fim]. */
  function periodoBloqueio({ diaInteiro = true, dataInicio, dataFim, horaInicio, horaFim }) {
    const inteiro = diaInteiro === true || diaInteiro === 'true' || diaInteiro === 'dia';
    if (!dataInicio || !/^\d{4}-\d{2}-\d{2}$/.test(dataInicio)) throw new RuleError('Informe a data inicial do bloqueio.', 'NOT NULL');
    let ini, fim;
    if (inteiro) {
      const df = dataFim || dataInicio;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(df)) throw new RuleError('Data final inválida.', 'CHK_Bloqueio_Periodo');
      ini = util.parseDate(dataInicio);
      fim = util.parseDate(df); fim.setHours(23, 59, 59, 0);
    } else {
      if (!horaInicio || !horaFim) throw new RuleError('Informe o horário inicial e final do bloqueio.', 'NOT NULL');
      ini = new Date(util.combine(dataInicio, horaInicio));
      fim = new Date(util.combine(dataInicio, horaFim));
    }
    if (!(fim > ini)) throw new RuleError('O fim do bloqueio deve ser posterior ao início.', 'CHK_Bloqueio_Periodo');
    if (fim.getTime() <= Date.now()) throw new RuleError('Não é possível bloquear um período que já passou.', 'CHK_Bloqueio_Periodo');
    if (fim - ini > 366 * 864e5) throw new RuleError('Um bloqueio pode ter no máximo 1 ano.', 'CHK_Bloqueio_Periodo');
    return { ini: ini.toISOString(), fim: fim.toISOString(), inteiro };
  }

  const service = {
    rules, MSG,

    listar(db, user) {
      const list = user.tipo === 'paciente' ? db.consultas.filter((c) => c.CPF_Paciente === user.id) : db.consultas.slice();
      return list.sort((a, b) => new Date(a.DataHora) - new Date(b.DataHora));
    },

    /** Paciente solicita um horário (status inicial: Pendente). */
    solicitar(db, user, { dataHora, duracao = '60 min', modalidade = 'Online', observacoes = '' }) {
      if (user.tipo !== 'paciente') {
        core.audit(db, user, 'BLOQUEIO_CRIACAO_AGENDA', 'Psicóloga tentou criar consulta diretamente', false);
        throw new RuleError('O agendamento é iniciado exclusivamente pelo paciente. A psicóloga confirma, recusa ou sugere outro horário.', 'Fluxo de agenda');
      }
      const pac = P.q.paciente(user.id, db);
      if (!pac || pac.Status !== 'ATIVO') throw new RuleError('Somente pacientes com cadastro aprovado podem solicitar consultas.', 'Status_Paciente');
      try {
        rules.validaNovoHorario(db, dataHora, duracao, null, user);
      } catch (e) {
        core.audit(db, user, e.regra === 'TRG_Antecedencia_Agendamento' ? 'BLOQUEIO_ANTECEDENCIA_48H' : 'FALHA_AGENDAMENTO', e.message, false);
        throw e;
      }
      const c = {
        ID_Consulta: P.nextId('consulta', db),
        DataHora: dataHora, DataHoraSugerida: null, Duracao: duracao, Status: 'Pendente',
        CPF_Paciente: user.id, CRP_Psicologo: db.psicologo.CRP,
        Modalidade: modalidade, Solicitante: 'Paciente', Observacoes: observacoes || null, MotivoCancelamento: null,
      };
      reiniciarConfirmacao(c);
      db.consultas.push(c);
      core.notify(db, db.psicologo.CRP, 'Nova solicitação de agendamento', `${user.nome} solicitou consulta para ${quando(dataHora)} (${modalidade}).`, 'solicitacao_pendente');
      core.audit(db, user, 'SOLICITAR_CONSULTA', `Consulta ${c.ID_Consulta} solicitada para ${dataHora}`, true);
      return c;
    },

    aceitar(db, user, id) {
      assertPsicologa(user, 'aceitar solicitações');
      const c = getConsulta(db, id);
      if (c.Status !== 'Pendente') throw new RuleError('Somente solicitações pendentes podem ser aceitas.', 'Fluxo de agenda');
      rules.verificaDataConsulta(c.DataHora);
      rules.verificaBloqueio(db, c.DataHora, c.Duracao, user);
      rules.evitaChoqueHorario(db, c.DataHora, c.Duracao, c.ID_Consulta);
      c.Status = 'Agendada';
      c.DataHoraSugerida = null;
      reiniciarConfirmacao(c);
      const pc = rules.prazos(db).PrazoConfirmacaoHoras;
      core.notify(db, c.CPF_Paciente, 'Consulta confirmada!', `${db.psicologo.Nome} confirmou sua consulta de ${quando(c.DataHora)}. Lembre-se de confirmar sua presença até ${pc} h antes.`, 'consulta_confirmada');
      core.audit(db, user, 'ACEITAR_SOLICITACAO', `Consulta ${c.ID_Consulta} confirmada`, true);
      return c;
    },

    recusar(db, user, id, motivo) {
      const c = getConsulta(db, id);
      assertDono(db, user, c);
      if (user.tipo === 'psicologo' && c.Status !== 'Pendente') throw new RuleError('Somente solicitações pendentes podem ser recusadas.', 'Fluxo de agenda');
      c.Status = 'Recusada';
      c.DataHoraSugerida = null;
      c.StatusConfirmacao = null;
      c.MotivoCancelamento = motivo || (user.tipo === 'psicologo' ? 'Solicitação recusada pela psicóloga' : 'Proposta recusada pelo paciente');
      if (user.tipo === 'psicologo') {
        core.notify(db, c.CPF_Paciente, 'Solicitação recusada', `Sua solicitação para ${quando(c.DataHora)} não pôde ser aceita. Motivo: ${c.MotivoCancelamento}.`, 'solicitacao_recusada');
      } else {
        core.notify(db, db.psicologo.CRP, 'Proposta recusada', `${user.nome} recusou a proposta de horário. O horário foi liberado.`, 'solicitacao_recusada');
      }
      core.audit(db, user, 'RECUSAR_CONSULTA', `Consulta ${c.ID_Consulta} recusada. Motivo: ${c.MotivoCancelamento}`, true);
      return c;
    },

    contraproposta(db, user, id, novaDataHora, mensagem) {
      assertPsicologa(user, 'sugerir outro horário');
      const c = getConsulta(db, id);
      if (c.Status !== 'Pendente') throw new RuleError('A contraproposta só pode ser feita para solicitações pendentes.', 'Fluxo de agenda');
      rules.verificaDataConsulta(novaDataHora);
      rules.verificaBloqueio(db, novaDataHora, c.Duracao, user);
      rules.evitaChoqueHorario(db, novaDataHora, c.Duracao, c.ID_Consulta);
      c.DataHoraSugerida = novaDataHora;
      c.Status = 'Aguardando_Paciente';
      if (mensagem) c.Observacoes = mensagem;
      core.notify(db, c.CPF_Paciente, 'Nova proposta de horário', `${db.psicologo.Nome} sugeriu ${quando(novaDataHora)}. Confirme na Agenda.`, 'contraproposta_horario');
      core.audit(db, user, 'CONTRAPROPOSTA_CONSULTA', `Consulta ${c.ID_Consulta}: horário sugerido ${novaDataHora}`, true);
      return c;
    },

    responderSugestao(db, user, id, acao, motivo) {
      if (user.tipo !== 'paciente') throw new RuleError('Apenas o paciente responde à proposta de horário.', 'RBAC');
      const c = getConsulta(db, id);
      assertDono(db, user, c);
      if (c.Status !== 'Aguardando_Paciente' || !c.DataHoraSugerida) throw new RuleError('Esta consulta não possui proposta pendente.', 'Fluxo de agenda');
      if (acao === 'recusar') return service.recusar(db, user, id, motivo || 'Paciente recusou a contraproposta de horário');
      rules.verificaDataConsulta(c.DataHoraSugerida);
      rules.verificaBloqueio(db, c.DataHoraSugerida, c.Duracao, user);
      rules.evitaChoqueHorario(db, c.DataHoraSugerida, c.Duracao, c.ID_Consulta);
      c.DataHora = c.DataHoraSugerida;
      c.DataHoraSugerida = null;
      c.Status = 'Agendada';
      reiniciarConfirmacao(c);
      // Horário proposto pela psicóloga dentro da janela de confirmação: o aceite do paciente já vale como confirmação
      if (util.hoursUntil(c.DataHora) <= rules.prazos(db).PrazoConfirmacaoHoras) {
        Object.assign(c, { StatusConfirmacao: 'CONFIRMADA', ConfirmadaEm: new Date().toISOString(), ConfirmadaPor: 'Paciente' });
      }
      core.notify(db, db.psicologo.CRP, 'Proposta aceita pelo paciente', `${user.nome} aceitou o horário de ${quando(c.DataHora)}.`, 'proposta_aceita');
      core.audit(db, user, 'ACEITAR_PROPOSTA', `Consulta ${c.ID_Consulta} agendada para ${c.DataHora}`, true);
      return c;
    },

    cancelar(db, user, id, motivo) {
      const c = getConsulta(db, id);
      assertDono(db, user, c);
      if (!STATUS_ATIVOS.includes(c.Status)) throw new RuleError('Esta consulta não pode mais ser cancelada.', 'Fluxo de agenda');
      const lim = rules.validaLimiteAlteracao(db, c, user);
      if (!lim.permitido) {
        core.audit(db, user, 'BLOQUEIO_LIMITE_AGENDA', `Cancelamento da consulta ${c.ID_Consulta} com ${lim.horasRestantes}h < ${lim.limiteHoras}h`, false);
        throw new RuleError(lim.mensagem, 'TRG_Limite_Alteracao_Agenda');
      }
      c.Status = 'Cancelada';
      c.DataHoraSugerida = null;
      c.StatusConfirmacao = null;
      c.MotivoCancelamento = motivo || `Cancelada pelo(a) ${user.tipo === 'psicologo' ? 'psicóloga' : 'paciente'}`;
      if (user.tipo === 'psicologo') core.notify(db, c.CPF_Paciente, 'Consulta cancelada', `Sua consulta de ${quando(c.DataHora)} foi cancelada. Motivo: ${c.MotivoCancelamento}.`, 'solicitacao_recusada');
      else core.notify(db, db.psicologo.CRP, 'Cancelamento de consulta', `${user.nome} cancelou a consulta de ${quando(c.DataHora)}.`, 'solicitacao_recusada');
      core.audit(db, user, 'CANCELAR_CONSULTA', `Consulta ${c.ID_Consulta} cancelada`, true);
      return c;
    },

    /**
     * Remarcação: pela psicóloga é direta; pelo paciente só com MAIS de 48 h
     * para a consulta atual, o novo horário respeita agora + 48 h e a
     * solicitação volta para "Pendente" (confirmação final da psicóloga).
     */
    remarcar(db, user, id, novaDataHora) {
      const c = getConsulta(db, id);
      assertDono(db, user, c);
      if (!['Pendente', 'Agendada'].includes(c.Status)) throw new RuleError('Somente consultas pendentes ou confirmadas podem ser remarcadas.', 'Fluxo de agenda');
      const lim = rules.validaReagendamento(db, c, user);
      if (!lim.permitido) {
        core.audit(db, user, 'BLOQUEIO_REAGENDAMENTO_48H', `Reagendamento da consulta ${c.ID_Consulta} com ${lim.horasRestantes}h ≤ ${lim.limiteHoras}h`, false);
        throw new RuleError(lim.mensagem, 'TRG_Limite_Alteracao_Agenda');
      }
      rules.validaNovoHorario(db, novaDataHora, c.Duracao, c.ID_Consulta, user);
      const antigo = c.DataHora;
      c.DataHora = novaDataHora;
      if (user.tipo === 'paciente') {
        c.Status = 'Pendente';
        core.notify(db, db.psicologo.CRP, 'Pedido de remarcação', `${user.nome} pediu para remarcar de ${quando(antigo)} para ${quando(novaDataHora)}.`, 'solicitacao_pendente');
      } else {
        core.notify(db, c.CPF_Paciente, 'Consulta remarcada', `Sua consulta foi remarcada para ${quando(novaDataHora)}.`, 'consulta_confirmada');
      }
      reiniciarConfirmacao(c);
      core.audit(db, user, 'REMARCAR_CONSULTA', `Consulta ${c.ID_Consulta}: ${antigo} → ${novaDataHora}`, true);
      return c;
    },

    registrarComparecimento(db, user, id, status) {
      assertPsicologa(user, 'registrar comparecimento');
      const c = getConsulta(db, id);
      if (!['Realizada', 'Faltou'].includes(status)) throw new RuleError('Status inválido (CHK_Status_Consulta).', 'CHK_Status_Consulta');
      if (c.Status !== 'Agendada') throw new RuleError('Somente consultas confirmadas podem ter comparecimento registrado.', 'Fluxo de agenda');
      if (new Date(c.DataHora).getTime() > Date.now()) throw new RuleError('A consulta ainda não começou.', 'Fluxo de agenda');
      c.Status = status;
      core.audit(db, user, 'REGISTRAR_COMPARECIMENTO', `Consulta ${c.ID_Consulta} marcada como ${status}`, true);
      return c;
    },

    /* ---------------- Confirmação de presença (36 h) ---------------- */

    /**
     * O paciente confirma a presença (prazo: 36 h antes). Depois do prazo a
     * confirmação ainda é aceita, mas fica marcada como tardia. A psicóloga
     * também pode registrar a confirmação recebida por telefone/chat.
     */
    confirmarPresenca(db, user, id) {
      const c = getConsulta(db, id);
      assertDono(db, user, c);
      if (c.Status !== 'Agendada') throw new RuleError('Só é possível confirmar presença em consultas já confirmadas pela psicóloga.', 'Fluxo de agenda');
      const s = rules.situacaoConfirmacao(db, c);
      if (!s) throw new RuleError('Esta consulta já começou ou já passou.', 'Fluxo de agenda');
      if (s.codigo === 'CONFIRMADA') throw new RuleError('A presença nesta consulta já foi confirmada.', 'Fluxo de agenda');
      const tardia = s.codigo === 'PENDENTE_CONFIRMACAO';
      Object.assign(c, { StatusConfirmacao: 'CONFIRMADA', ConfirmadaEm: new Date().toISOString(), ConfirmadaPor: user.tipo === 'psicologo' ? 'Psicóloga' : 'Paciente', ConfirmacaoTardia: tardia });
      if (user.tipo === 'paciente') {
        core.notify(db, db.psicologo.CRP, tardia ? 'Presença confirmada após o prazo' : 'Presença confirmada', `${user.nome} confirmou presença na consulta de ${quando(c.DataHora)}${tardia ? ` (após o prazo de ${s.prazoHoras} h)` : ''}.`, 'presenca_confirmada');
      } else {
        core.notify(db, c.CPF_Paciente, 'Presença registrada', `${db.psicologo.Nome} registrou a confirmação da sua consulta de ${quando(c.DataHora)}.`, 'presenca_confirmada');
      }
      core.audit(db, user, 'CONFIRMAR_PRESENCA', `Consulta ${c.ID_Consulta} confirmada por ${c.ConfirmadaPor}${tardia ? ' (após o prazo)' : ''}`, true);
      return c;
    },

    /** Psicóloga reenvia o lembrete de confirmação ao paciente. */
    reenviarLembrete(db, user, id) {
      assertPsicologa(user, 'reenviar lembretes');
      const c = getConsulta(db, id);
      const s = rules.situacaoConfirmacao(db, c);
      if (!s || s.codigo === 'CONFIRMADA') throw new RuleError('Esta consulta não está aguardando confirmação.', 'Fluxo de agenda');
      core.notify(db, c.CPF_Paciente, 'Confirme sua presença', `Sua consulta de ${quando(c.DataHora)} ainda não foi confirmada. Confirme na Agenda ou responda pelo chat.`, 'confirmacao_pendente');
      c.LembreteConfirmacaoEm = new Date().toISOString();
      core.audit(db, user, 'LEMBRETE_CONFIRMACAO', `Lembrete reenviado — consulta ${c.ID_Consulta}`, true);
      return c;
    },

    /**
     * Automação (equivale ao EVT_Confirmacao_Presenca do MySQL):
     *  • na janela do lembrete → notifica o paciente uma vez;
     *  • prazo de 36 h vencido sem confirmação → StatusConfirmacao =
     *    'PENDENTE_CONFIRMACAO' e alerta a psicóloga.
     * Retorna o número de consultas alteradas.
     */
    processarConfirmacoes(db, agora = Date.now()) {
      let n = 0;
      const agoraIso = new Date(agora).toISOString();
      for (const c of db.consultas) {
        const s = rules.situacaoConfirmacao(db, c, agora);
        if (!s || s.codigo === 'CONFIRMADA') continue;
        if (s.codigo === 'LEMBRETE' && !c.LembreteConfirmacaoEm) {
          core.notify(db, c.CPF_Paciente, 'Confirme sua presença', `Sua consulta de ${quando(c.DataHora)} precisa ser confirmada até ${util.fmtDateTime(s.prazo)} (${s.prazoHoras} h antes). Confirme na Agenda.`, 'confirmacao_pendente');
          c.LembreteConfirmacaoEm = agoraIso;
          core.audit(db, null, 'LEMBRETE_CONFIRMACAO', `Lembrete automático — consulta ${c.ID_Consulta}`, true);
          n++;
        }
        if (s.codigo === 'PENDENTE_CONFIRMACAO' && c.StatusConfirmacao !== 'PENDENTE_CONFIRMACAO') {
          c.StatusConfirmacao = 'PENDENTE_CONFIRMACAO';
          c.AlertaConfirmacaoEm = agoraIso;
          core.notify(db, db.psicologo.CRP, 'Presença não confirmada', `${P.q.pacienteNome(c.CPF_Paciente, db)} não confirmou a consulta de ${quando(c.DataHora)} no prazo de ${s.prazoHoras} h. Confirme por contato ou libere a vaga.`, 'confirmacao_atrasada');
          if (!c.LembreteConfirmacaoEm) c.LembreteConfirmacaoEm = agoraIso;
          core.notify(db, c.CPF_Paciente, 'Prazo de confirmação encerrado', `Sua consulta de ${quando(c.DataHora)} não foi confirmada até ${s.prazoHoras} h antes. Confirme agora na Agenda ou fale com a psicóloga — a vaga pode ser liberada.`, 'confirmacao_atrasada');
          core.audit(db, null, 'ALERTA_CONFIRMACAO', `Consulta ${c.ID_Consulta} → PENDENTE_CONFIRMACAO`, true);
          n++;
        }
      }
      return n;
    },

    /** Consultas confirmadas e futuras que ainda aguardam confirmação de presença. */
    aConfirmar(db) {
      const ordem = { PENDENTE_CONFIRMACAO: 0, LEMBRETE: 1, AGUARDANDO: 2 };
      return db.consultas
        .map((c) => ({ c, s: rules.situacaoConfirmacao(db, c) }))
        .filter((x) => x.s && x.s.codigo !== 'CONFIRMADA')
        .sort((a, b) => ordem[a.s.codigo] - ordem[b.s.codigo] || new Date(a.c.DataHora) - new Date(b.c.DataHora));
    },

    /* ---------------- Bloqueios de dias/horários ---------------- */

    listarBloqueios(db, user, { incluirPassados = false } = {}) {
      const agora = Date.now();
      const list = (db.bloqueios || [])
        .filter((b) => b.CRP_Psicologo === db.psicologo.CRP && (incluirPassados || new Date(b.Data_Fim).getTime() > agora))
        .sort((a, b) => new Date(a.Data_Inicio) - new Date(b.Data_Inicio));
      // O paciente vê apenas que a data está indisponível — o motivo é privado
      return user.tipo === 'psicologo' ? list : list.map(({ Motivo, ...b }) => b);
    },

    /** Consultas ativas (pendentes, confirmadas ou com proposta) dentro de um período. */
    consultasAfetadas(db, iniIso, fimIso) {
      const ini = new Date(iniIso).getTime(), fim = new Date(fimIso).getTime();
      const toca = (iso, dur) => { const a = new Date(iso).getTime(); return a < fim && a + rules.duracaoMin(dur) * 6e4 > ini && a + rules.duracaoMin(dur) * 6e4 > Date.now(); };
      return db.consultas.filter((c) => c.CRP_Psicologo === db.psicologo.CRP && STATUS_ATIVOS.includes(c.Status)
        && (toca(c.DataHora, c.Duracao) || (c.Status === 'Aguardando_Paciente' && c.DataHoraSugerida && toca(c.DataHoraSugerida, c.Duracao))))
        .sort((a, b) => new Date(a.DataHora) - new Date(b.DataHora));
    },

    /** Valida os dados do formulário e devolve o período + consultas afetadas (sem gravar). */
    previewBloqueio(db, dados, ignorarId = null) {
      const per = periodoBloqueio(dados);
      const [sobreposto] = rules.bloqueiosNoPeriodo(db, new Date(per.ini).getTime(), new Date(per.fim).getTime(), ignorarId);
      if (sobreposto) throw new RuleError(`Já existe um bloqueio neste período (${rules.rotuloBloqueio(sobreposto)}). Edite o bloqueio existente.`, 'UQ_Bloqueio_Periodo');
      if (String(dados.motivo || '').length > 255) throw new RuleError('O motivo pode ter no máximo 255 caracteres.', 'Motivo');
      return { ...per, afetadas: service.consultasAfetadas(db, per.ini, per.fim) };
    },

    /** Cancela/recusa as consultas atingidas por um bloqueio e avisa os pacientes. */
    liberarAfetadas(db, user, afetadas) {
      afetadas.forEach((c) => {
        const era = c.Status;
        c.Status = era === 'Agendada' ? 'Cancelada' : 'Recusada';
        c.MotivoCancelamento = 'Agenda da psicóloga indisponível neste período';
        c.DataHoraSugerida = null;
        c.StatusConfirmacao = null;
        core.notify(db, c.CPF_Paciente, era === 'Agendada' ? 'Consulta cancelada' : 'Solicitação não pôde ser atendida',
          `A agenda da ${db.psicologo.Nome} ficou indisponível em ${quando(c.DataHora)}. ${era === 'Agendada' ? 'Sua consulta foi cancelada' : 'Sua solicitação foi encerrada'} — escolha um novo horário na Agenda.`, 'agenda_bloqueada');
        core.audit(db, user, 'CANCELAR_CONSULTA', `Consulta ${c.ID_Consulta} (${era}) liberada por bloqueio de agenda`, true);
      });
      return afetadas.length;
    },

    criarBloqueio(db, user, dados) {
      assertPsicologa(user, 'bloquear a agenda');
      const pv = service.previewBloqueio(db, dados);
      const agora = new Date().toISOString();
      const b = {
        ID_Bloqueio: P.nextId('bloqueio', db), CRP_Psicologo: db.psicologo.CRP,
        Data_Inicio: pv.ini, Data_Fim: pv.fim, DiaInteiro: pv.inteiro,
        Motivo: String(dados.motivo || '').trim() || null, CriadoEm: agora, AtualizadoEm: agora,
      };
      db.bloqueios = db.bloqueios || [];
      db.bloqueios.push(b);
      const canceladas = dados.cancelarAfetadas ? service.liberarAfetadas(db, user, pv.afetadas) : 0;
      core.audit(db, user, 'BLOQUEAR_AGENDA', `Bloqueio ${b.ID_Bloqueio}: ${rules.rotuloBloqueio(b)}${b.Motivo ? ` (${b.Motivo})` : ''}${canceladas ? ` · ${canceladas} consulta(s) liberada(s)` : ''}`, true);
      return { bloqueio: b, afetadas: pv.afetadas.length - canceladas, canceladas };
    },

    editarBloqueio(db, user, id, dados) {
      assertPsicologa(user, 'editar bloqueios');
      const b = (db.bloqueios || []).find((x) => x.ID_Bloqueio === Number(id) && x.CRP_Psicologo === db.psicologo.CRP);
      if (!b) throw new RuleError('Bloqueio não encontrado.', 'FK');
      const pv = service.previewBloqueio(db, dados, b.ID_Bloqueio);
      const antes = rules.rotuloBloqueio(b);
      Object.assign(b, { Data_Inicio: pv.ini, Data_Fim: pv.fim, DiaInteiro: pv.inteiro, Motivo: String(dados.motivo || '').trim() || null, AtualizadoEm: new Date().toISOString() });
      const canceladas = dados.cancelarAfetadas ? service.liberarAfetadas(db, user, pv.afetadas) : 0;
      core.audit(db, user, 'EDITAR_BLOQUEIO', `Bloqueio ${b.ID_Bloqueio}: ${antes} → ${rules.rotuloBloqueio(b)}`, true);
      return { bloqueio: b, afetadas: pv.afetadas.length - canceladas, canceladas };
    },

    removerBloqueio(db, user, id) {
      assertPsicologa(user, 'remover bloqueios');
      const i = (db.bloqueios || []).findIndex((x) => x.ID_Bloqueio === Number(id) && x.CRP_Psicologo === db.psicologo.CRP);
      if (i < 0) throw new RuleError('Bloqueio não encontrado.', 'FK');
      const [b] = db.bloqueios.splice(i, 1);
      core.audit(db, user, 'REMOVER_BLOQUEIO', `Bloqueio ${b.ID_Bloqueio} removido: ${rules.rotuloBloqueio(b)}`, true);
      return b;
    },
  };
  P.services.agenda = service;
  if (P.automacoes) P.automacoes.push((db) => service.processarConfirmacoes(db));

  /* =====================================================================
     CONTROLADOR DA PÁGINA
     ===================================================================== */
  if (document.body.dataset.page !== 'agenda') return;

  const { $, esc } = util;
  const ui = P.ui;
  const params = new URLSearchParams(location.search);
  const state = {
    month: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    selected: util.isoDate(new Date()),
    filtro: params.get('filtro') || 'proximas',
    highlight: params.get('id') ? Number(params.get('id')) : null,
    bloqueiosPassados: false,
  };

  const FILTROS = [
    { id: 'proximas', label: 'Próximas' },
    { id: 'pendentes', label: 'Pendentes' },
    { id: 'confirmacao', label: 'A confirmar', roles: ['psicologo'] },
    { id: 'dia', label: 'Dia selecionado' },
    { id: 'historico', label: 'Histórico' },
  ];

  /** Executa uma operação do service, persiste e exibe feedback. */
  function run(fn, okMsg) {
    try {
      const r = fn();
      P.save('agenda');
      if (okMsg) ui.toast(typeof okMsg === 'function' ? okMsg(r) : okMsg, 'success');
      return r;
    } catch (e) {
      P.save('agenda'); // persiste também o registro de auditoria da falha
      ui.toast(e.message, 'error', 6000);
      return null;
    }
  }

  /* ---------- Calendário de agendamento (solicitar, sugerir e remarcar) ----------
     Mostra o mês com cada dia classificado por rules.situacaoDia:
     bloqueado (cinza/listrado) · dentro das 48 h · sem horários · passado. */
  const DIA_INFO = {
    livre: 'horários disponíveis', parcial: 'parte do dia bloqueada', bloqueado: 'agenda bloqueada pela psicóloga',
    antecedencia: 'dentro do prazo mínimo de antecedência', lotado: 'sem horários livres', passado: 'data passada',
  };

  function slotPickerHtml(user) {
    const h = rules.prazos(P.db).AntecedenciaAgendamentoHoras;
    return `
      <div class="field full">
        <label>Data *</label>
        <div class="dp" data-dp>
          <div class="dp-head">
            <button type="button" class="icon-btn sm" data-dp-prev aria-label="Mês anterior">${P.icon('chevron-left', 16)}</button>
            <strong data-dp-title aria-live="polite">—</strong>
            <button type="button" class="icon-btn sm" data-dp-next aria-label="Próximo mês">${P.icon('chevron-right', 16)}</button>
          </div>
          <div class="cal-week"><span>D</span><span>S</span><span>T</span><span>Q</span><span>Q</span><span>S</span><span>S</span></div>
          <div class="dp-grid" data-dp-grid role="grid"></div>
          <div class="dp-legend">
            <span><i class="lg-livre"></i>Disponível</span>
            <span><i class="lg-bloqueado"></i>Bloqueado</span>
            <span><i class="lg-indisp"></i>${user.tipo === 'paciente' ? `Indisponível (&lt; ${h} h)` : 'Indisponível'}</span>
          </div>
        </div>
        <input type="hidden" name="data" required data-label="Data">
      </div>
      <div class="field full">
        <label>Horário disponível * <span class="text-muted fw-500" data-dp-dia></span></label>
        <div class="slot-grid" data-slots></div>
        <input type="hidden" name="hora" required data-label="Horário">
        <div class="hint">${user.tipo === 'paciente'
          ? `Agendamentos exigem pelo menos <strong>${h} h</strong> de antecedência. Dias bloqueados pela psicóloga ficam indisponíveis. Intervalo mínimo de ${INTERVALO_MINIMO_MIN} min entre consultas.`
          : `Dias e horários bloqueados na sua agenda ficam indisponíveis. Intervalo mínimo de ${INTERVALO_MINIMO_MIN} min entre consultas.`}</div>
      </div>`;
  }

  function bindSlotPicker(el, { getDuracao, ignorarId = null }) {
    const user = P.currentUser();
    const dataInput = el.querySelector('[name=data]');
    const horaInput = el.querySelector('[name=hora]');
    const grid = el.querySelector('[data-dp-grid]');
    const title = el.querySelector('[data-dp-title]');
    const box = el.querySelector('[data-slots]');
    const diaLabel = el.querySelector('[data-dp-dia]');
    const hoje = new Date();
    const mesMin = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const mesMax = new Date(hoje.getFullYear(), hoje.getMonth() + 6, 1);
    const pick = { month: mesMin, dia: null };

    const disponivel = (t) => t === 'livre' || t === 'parcial';
    // Primeiro dia com horário livre (até 180 dias)
    for (let i = 0; i < 180 && !pick.dia; i++) {
      const iso = util.isoDate(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + i));
      if (disponivel(rules.situacaoDia(P.db, iso, getDuracao(), ignorarId, user).tipo)) pick.dia = iso;
    }
    if (pick.dia) { const d = util.parseDate(pick.dia); pick.month = new Date(d.getFullYear(), d.getMonth(), 1); }

    const paintSlots = () => {
      horaInput.value = '';
      dataInput.value = pick.dia || '';
      if (!pick.dia) { box.innerHTML = '<div class="text-xs text-muted" style="grid-column:1/-1">Selecione uma data disponível no calendário.</div>'; diaLabel.textContent = ''; return; }
      diaLabel.textContent = `· ${util.capitalize(util.fmtDateLong(pick.dia))}`;
      let slots = rules.horariosDisponiveis(P.db, pick.dia, getDuracao(), ignorarId, user);
      if (user.tipo === 'paciente') slots = slots.filter((s) => s.tipo !== 'passado'); // horários que já passaram ficam ocultos
      const livres = slots.filter((s) => s.livre).length;
      box.innerHTML = slots.map((s) => `<button type="button" class="slot ${s.tipo ? `slot-${s.tipo}` : ''}" data-hora="${s.hora}" ${s.livre ? '' : `disabled title="${esc(s.motivo)}" aria-label="${s.hora} — ${esc(s.motivo)}"`}>${s.hora}</button>`).join('')
        + (livres ? '' : '<div class="text-xs text-danger" style="grid-column:1/-1">Nenhum horário livre nesta data.</div>');
      box.querySelectorAll('.slot:not([disabled])').forEach((b) => b.addEventListener('click', () => {
        box.querySelectorAll('.slot').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
        horaInput.value = b.dataset.hora;
      }));
    };

    const paintCal = () => {
      const m = pick.month;
      title.textContent = `${util.capitalize(util.MESES[m.getMonth()])} ${m.getFullYear()}`;
      el.querySelector('[data-dp-prev]').disabled = m <= mesMin;
      el.querySelector('[data-dp-next]').disabled = m >= mesMax;
      const total = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      let cells = '';
      for (let i = 0; i < m.getDay(); i++) cells += '<span></span>';
      for (let d = 1; d <= total; d++) {
        const iso = util.isoDate(new Date(m.getFullYear(), m.getMonth(), d));
        const sit = rules.situacaoDia(P.db, iso, getDuracao(), ignorarId, user);
        const ok = disponivel(sit.tipo);
        const motivoBloq = user.tipo === 'psicologo' && sit.bloqueios && sit.bloqueios[0] && sit.bloqueios[0].Motivo ? ` (${sit.bloqueios[0].Motivo})` : '';
        const info = `${DIA_INFO[sit.tipo]}${motivoBloq}`;
        cells += `<button type="button" class="dp-day is-${sit.tipo} ${iso === pick.dia ? 'selected' : ''} ${iso === util.isoDate() ? 'today' : ''}" data-dp-day="${iso}" ${ok ? '' : 'disabled aria-disabled="true"'} title="${esc(util.capitalize(info))}" aria-label="${esc(`${util.fmtDateLong(iso)}: ${info}`)}">${d}</button>`;
      }
      grid.innerHTML = cells;
    };

    el.querySelector('[data-dp-prev]').addEventListener('click', () => { pick.month = new Date(pick.month.getFullYear(), pick.month.getMonth() - 1, 1); paintCal(); });
    el.querySelector('[data-dp-next]').addEventListener('click', () => { pick.month = new Date(pick.month.getFullYear(), pick.month.getMonth() + 1, 1); paintCal(); });
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dp-day]:not([disabled])'); if (!b) return;
      pick.dia = b.dataset.dpDay; paintCal(); paintSlots();
    });
    el.addEventListener('prisma:duracao', () => {
      if (pick.dia && !disponivel(rules.situacaoDia(P.db, pick.dia, getDuracao(), ignorarId, user).tipo)) pick.dia = null;
      paintCal(); paintSlots();
    });
    paintCal(); paintSlots();
  }

  /* ---------- Modais ---------- */
  function openSolicitar() {
    ui.formModal({
      title: 'Solicitar consulta',
      subtitle: `A ${P.db.psicologo.Nome} confirmará, recusará ou sugerirá outro horário.`,
      submitLabel: 'Enviar solicitação', submitIcon: 'send', size: 'lg',
      body: `<div class="form-grid">
        <div class="field"><label>Duração</label><select class="select" name="duracao">${Object.keys(DURACOES).map((d) => `<option ${d === '60 min' ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
        <div class="field"><label>Modalidade</label>
          <div class="seg"><label><input type="radio" name="modalidade" value="Online" checked><span>${P.icon('video', 15)} Online</span></label><label><input type="radio" name="modalidade" value="Presencial"><span>${P.icon('pin', 15)} Presencial</span></label></div>
        </div>
        ${slotPickerHtml(P.currentUser())}
        <div class="field full"><label>Motivo / observações</label><textarea class="textarea" name="observacoes" maxlength="400" placeholder="Opcional — conte brevemente o que gostaria de trabalhar."></textarea></div>
      </div>`,
      onOpen(el) {
        const dur = el.querySelector('[name=duracao]');
        bindSlotPicker(el, { getDuracao: () => dur.value });
        dur.addEventListener('change', () => el.dispatchEvent(new Event('prisma:duracao')));
      },
      onSubmit(data) {
        const user = P.currentUser();
        try {
          service.solicitar(P.db, user, { dataHora: util.combine(data.data, data.hora), duracao: data.duracao, modalidade: data.modalidade, observacoes: data.observacoes });
        } finally { P.save('agenda'); }
        ui.toast('Solicitação enviada! Aguarde a confirmação da psicóloga.', 'success');
        state.filtro = 'pendentes';
      },
    });
  }

  function openContraproposta(c) {
    ui.formModal({
      title: 'Sugerir outro horário', size: 'lg',
      subtitle: `${P.q.pacienteNome(c.CPF_Paciente)} · solicitado para ${util.fmtDateTime(c.DataHora)} (${c.Duracao})`,
      submitLabel: 'Enviar proposta', submitIcon: 'swap',
      body: `<div class="form-grid">${slotPickerHtml(P.currentUser())}
        <div class="field full"><label>Mensagem ao paciente</label><textarea class="textarea" name="mensagem" maxlength="400" placeholder="Ex.: Nesse dia estarei em um congresso. Pode ser neste horário?"></textarea></div></div>`,
      onOpen(el) { bindSlotPicker(el, { getDuracao: () => c.Duracao, ignorarId: c.ID_Consulta }); },
      onSubmit(data) {
        service.contraproposta(P.db, P.currentUser(), c.ID_Consulta, util.combine(data.data, data.hora), data.mensagem);
        P.save('agenda');
        ui.toast('Proposta enviada ao paciente.', 'success');
      },
    });
  }

  /** Aviso da regra de 48 h (paciente tentando reagendar tarde demais). */
  function avisoReagendamento(mensagem) {
    ui.modal({
      title: 'Reagendamento indisponível', size: 'sm',
      body: `<div class="alert alert-warning" role="alert">${P.icon('lock', 16)}<span>${esc(mensagem)}</span></div>`,
      actions: [
        { label: 'Fechar', variant: 'btn-ghost' },
        { label: 'Falar com a psicóloga', variant: 'btn-dark', icon: 'message', onClick: () => { location.href = P.url('chat'); } },
      ],
    });
  }

  function openRemarcar(c) {
    const user = P.currentUser();
    const lim = rules.validaReagendamento(P.db, c, user);
    if (!lim.permitido) {
      run(() => service.remarcar(P.db, user, c.ID_Consulta, c.DataHora)); // registra a tentativa na auditoria
      avisoReagendamento(lim.mensagem);
      return;
    }
    ui.formModal({
      title: 'Remarcar consulta', size: 'lg',
      subtitle: `Atual: ${util.fmtDateTime(c.DataHora)} · ${c.Duracao}${user.tipo === 'paciente' ? ' — a nova data precisará ser confirmada pela psicóloga.' : ''}`,
      submitLabel: 'Remarcar', submitIcon: 'calendar',
      body: `<div class="form-grid">${slotPickerHtml(user)}</div>`,
      onOpen(el) { bindSlotPicker(el, { getDuracao: () => c.Duracao, ignorarId: c.ID_Consulta }); },
      onSubmit(data) {
        try { service.remarcar(P.db, P.currentUser(), c.ID_Consulta, util.combine(data.data, data.hora)); } finally { P.save('agenda'); }
        ui.toast(user.tipo === 'paciente' ? 'Pedido de remarcação enviado à psicóloga.' : 'Consulta remarcada.', 'success');
      },
    });
  }

  function openMotivo({ title, label, confirmLabel, onConfirm, variant = 'btn-danger', valor = '', hint = '' }) {
    ui.formModal({
      title, submitLabel: confirmLabel, submitVariant: variant, size: 'sm',
      body: `<div class="field"><label>${esc(label)}</label><textarea class="textarea" name="motivo" maxlength="255" placeholder="Opcional">${esc(valor)}</textarea>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</div>`,
      onSubmit(data) { onConfirm(data.motivo); P.save('agenda'); },
    });
  }

  function openCancelar(c) {
    const user = P.currentUser();
    const lim = rules.validaLimiteAlteracao(P.db, c, user);
    if (!lim.permitido) { run(() => service.cancelar(P.db, user, c.ID_Consulta)); return; }
    openMotivo({
      title: 'Cancelar consulta', label: 'Motivo do cancelamento', confirmLabel: 'Cancelar consulta',
      onConfirm: (m) => { service.cancelar(P.db, P.currentUser(), c.ID_Consulta, m); ui.toast('Consulta cancelada.', 'success'); },
    });
  }

  function openLiberarVaga(c) {
    const pc = rules.prazos(P.db).PrazoConfirmacaoHoras;
    openMotivo({
      title: 'Liberar vaga', label: 'Motivo enviado ao paciente', confirmLabel: 'Cancelar e liberar vaga',
      valor: `Presença não confirmada no prazo de ${pc} h.`,
      hint: 'A consulta é cancelada, o horário volta a ficar disponível e o paciente é notificado.',
      onConfirm: (m) => { service.cancelar(P.db, P.currentUser(), c.ID_Consulta, m); ui.toast('Vaga liberada. O paciente foi notificado.', 'success'); },
    });
  }

  /* ---------- Bloqueio de dias/horários (psicóloga) ---------- */
  function openBloqueio(b = null) {
    const inteiro = b ? b.DiaInteiro : true;
    const di = b ? util.isoDate(b.Data_Inicio) : util.isoDate(new Date(Date.now() + 864e5));
    const df = b ? util.isoDate(b.Data_Fim) : di;
    const hi = b && !b.DiaInteiro ? util.fmtTime(b.Data_Inicio) : '13:00';
    const hf = b && !b.DiaInteiro ? util.fmtTime(b.Data_Fim) : '18:00';
    const MOTIVOS = ['Férias', 'Feriado', 'Congresso', 'Folga', 'Compromisso pessoal', 'Supervisão clínica', 'Curso / capacitação'];
    ui.formModal({
      title: b ? 'Editar bloqueio' : 'Bloquear dias/horários',
      subtitle: 'Os pacientes verão estas datas como indisponíveis no calendário de agendamento.',
      submitLabel: b ? 'Salvar bloqueio' : 'Bloquear', submitIcon: 'lock',
      body: `<div class="form-grid">
        <div class="field full"><label>Tipo de bloqueio</label>
          <div class="seg"><label><input type="radio" name="tipo" value="dia" ${inteiro ? 'checked' : ''}><span>${P.icon('calendar', 15)} Dia(s) inteiro(s)</span></label><label><input type="radio" name="tipo" value="horario" ${inteiro ? '' : 'checked'}><span>${P.icon('clock', 15)} Horário específico</span></label></div>
        </div>
        <div class="field"><label data-lbl-ini>${inteiro ? 'Data inicial *' : 'Data *'}</label><input class="input" type="date" name="dataInicio" value="${di}" min="${util.isoDate()}" required data-label="Data inicial"></div>
        <div class="field" data-when="dia" ${inteiro ? '' : 'hidden'}><label>Data final</label><input class="input" type="date" name="dataFim" value="${df}" min="${util.isoDate()}"><span class="hint">Deixe igual à inicial para um único dia.</span></div>
        <div class="field" data-when="horario" ${inteiro ? 'hidden' : ''}><label>Das</label><input class="input" type="time" name="horaInicio" value="${hi}" step="1800"></div>
        <div class="field" data-when="horario" ${inteiro ? 'hidden' : ''}><label>Até</label><input class="input" type="time" name="horaFim" value="${hf}" step="1800"></div>
        <div class="field full"><label>Motivo (opcional)</label>
          <input class="input" name="motivo" maxlength="255" list="blk-motivos" value="${esc(b && b.Motivo ? b.Motivo : '')}" placeholder="Ex.: Férias, Feriado, Congresso, Compromisso pessoal">
          <datalist id="blk-motivos">${MOTIVOS.map((m) => `<option value="${m}">`).join('')}</datalist>
          <div class="chips mt-8">${MOTIVOS.slice(0, 5).map((m) => `<button type="button" class="chip" data-motivo="${m}">${m}</button>`).join('')}</div>
          <span class="hint">Visível apenas para você. O paciente vê somente que a data está indisponível.</span>
        </div>
        <div class="field full" data-preview aria-live="polite"></div>
      </div>`,
      onOpen(el) {
        const form = el.querySelector('form');
        const tipo = () => form.querySelector('[name=tipo]:checked').value;
        const dados = () => ({ diaInteiro: tipo() === 'dia', dataInicio: form.dataInicio.value, dataFim: form.dataFim.value, horaInicio: form.horaInicio.value, horaFim: form.horaFim.value, motivo: form.motivo.value });
        const prev = el.querySelector('[data-preview]');
        const paint = () => {
          el.querySelectorAll('[data-when]').forEach((f) => { f.hidden = f.dataset.when !== tipo(); });
          el.querySelector('[data-lbl-ini]').textContent = tipo() === 'dia' ? 'Data inicial *' : 'Data *';
          if (form.dataFim.value && form.dataFim.value < form.dataInicio.value) form.dataFim.value = form.dataInicio.value;
          form.dataFim.min = form.dataInicio.value || util.isoDate();
          const marcado = prev.querySelector('[name=cancelarAfetadas]')?.checked;
          let pv;
          try { pv = service.previewBloqueio(P.db, dados(), b ? b.ID_Bloqueio : null); } catch (e) {
            prev.innerHTML = `<div class="alert alert-danger">${P.icon('alert', 16)}<span>${esc(e.message)}</span></div>`; return;
          }
          const resumo = rules.rotuloBloqueio({ Data_Inicio: pv.ini, Data_Fim: pv.fim, DiaInteiro: pv.inteiro });
          prev.innerHTML = `<div class="blk-preview">${P.icon('lock', 15)}<span>Período: <strong>${esc(resumo)}</strong></span></div>`
            + (pv.afetadas.length ? `<div class="alert alert-warning mt-8">${P.icon('alert', 16)}<div class="grow">
                <strong>${pv.afetadas.length} consulta(s) neste período:</strong>
                <ul class="blk-afetadas">${pv.afetadas.map((c) => `<li>${esc(P.q.pacienteNome(c.CPF_Paciente))} · ${util.fmtDateTime(c.DataHora)}${c.Status === 'Aguardando_Paciente' && c.DataHoraSugerida ? ` (proposta: ${util.fmtDateTime(c.DataHoraSugerida)})` : ''} · ${esc(ui.statusLabel ? ui.statusLabel(c.Status) : c.Status)}</li>`).join('')}</ul>
                <label class="check mt-8"><input type="checkbox" name="cancelarAfetadas" value="1" ${marcado ? 'checked' : ''}><span>Cancelar essas consultas e avisar os pacientes</span></label>
                <div class="text-xs mt-4">Se não marcar, elas continuam agendadas e você decide caso a caso.</div>
              </div></div>` : '<div class="text-xs text-success mt-8">Nenhuma consulta ativa neste período.</div>');
        };
        form.addEventListener('input', (e) => { if (e.target.name !== 'cancelarAfetadas') paint(); });
        form.addEventListener('change', (e) => { if (e.target.name !== 'cancelarAfetadas' && e.target.name !== 'motivo') paint(); });
        el.addEventListener('click', (e) => { const m = e.target.closest('[data-motivo]'); if (m) { form.motivo.value = m.dataset.motivo; } });
        paint();
      },
      onSubmit(d, form) {
        const dados = { diaInteiro: d.tipo === 'dia', dataInicio: d.dataInicio, dataFim: d.dataFim, horaInicio: d.horaInicio, horaFim: d.horaFim, motivo: d.motivo, cancelarAfetadas: !!form.querySelector('[name=cancelarAfetadas]:checked') };
        const r = b ? service.editarBloqueio(P.db, P.currentUser(), b.ID_Bloqueio, dados) : service.criarBloqueio(P.db, P.currentUser(), dados);
        P.save('agenda');
        ui.toast(`${b ? 'Bloqueio atualizado' : 'Agenda bloqueada'}: ${rules.rotuloBloqueio(r.bloqueio)}.${r.canceladas ? ` ${r.canceladas} consulta(s) liberada(s) e paciente(s) avisado(s).` : ''}${r.afetadas ? ` Atenção: ${r.afetadas} consulta(s) continuam no período.` : ''}`, r.afetadas ? 'warning' : 'success', 6000);
      },
    });
  }

  function removerBloqueio(b) {
    ui.confirm({
      title: 'Remover bloqueio', confirmLabel: 'Remover', variant: 'btn-danger',
      message: `O período <strong>${esc(rules.rotuloBloqueio(b))}</strong>${b.Motivo ? ` (${esc(b.Motivo)})` : ''} volta a ficar disponível para agendamento.`,
      onConfirm: () => run(() => service.removerBloqueio(P.db, P.currentUser(), b.ID_Bloqueio), 'Bloqueio removido. As datas voltaram a ficar disponíveis.'),
    });
  }

  function renderBloqueios(user) {
    const card = $('#bloqueios-card');
    if (user.tipo !== 'psicologo') { card.hidden = true; return; }
    card.hidden = false;
    const list = service.listarBloqueios(P.db, user, { incluirPassados: state.bloqueiosPassados });
    const agora = Date.now();
    $('#bloqueios-lista').innerHTML = list.length ? list.map((b) => {
      const ini = new Date(b.Data_Inicio).getTime(), fim = new Date(b.Data_Fim).getTime();
      const passado = fim <= agora, andamento = ini <= agora && fim > agora;
      const afetadas = passado ? 0 : service.consultasAfetadas(P.db, b.Data_Inicio, b.Data_Fim).length;
      return `<div class="blk-item ${passado ? 'passado' : ''}">
        <span class="blk-ic">${P.icon('lock', 15)}</span>
        <div class="grow">
          <div class="fw-700 text-sm">${esc(rules.rotuloBloqueio(b))}</div>
          <div class="text-xs text-muted">${esc(b.Motivo || 'Sem motivo informado')}</div>
          ${andamento ? '<span class="badge badge-violet mt-4">Em andamento</span>' : ''}${passado ? '<span class="badge badge-neutral mt-4">Encerrado</span>' : ''}
          ${afetadas ? `<div class="text-xs text-warning fw-600 mt-4">${P.icon('alert', 12)} ${afetadas} consulta(s) no período</div>` : ''}
        </div>
        ${passado ? '' : `<button class="icon-btn sm" data-blk-edit="${b.ID_Bloqueio}" aria-label="Editar bloqueio ${esc(rules.rotuloBloqueio(b))}" title="Editar">${P.icon('edit', 15)}</button>`}
        <button class="icon-btn sm" data-blk-del="${b.ID_Bloqueio}" aria-label="Remover bloqueio ${esc(rules.rotuloBloqueio(b))}" title="Remover">${P.icon('trash', 15)}</button>
      </div>`;
    }).join('') : `<div class="text-sm text-muted">${state.bloqueiosPassados ? 'Nenhum bloqueio registrado.' : 'Nenhum bloqueio futuro. Use “Bloquear” para folgas, feriados ou congressos.'}</div>`;
    $('#bloqueios-passados').textContent = state.bloqueiosPassados ? 'Ocultar anteriores' : 'Ver anteriores';
  }

  /* ---------- Renderização ---------- */
  function filtrar(list) {
    const now = Date.now();
    switch (state.filtro) {
      case 'dia': return list.filter((c) => util.isoDate(c.DataHora) === state.selected);
      case 'pendentes': return list.filter((c) => ['Pendente', 'Aguardando_Paciente'].includes(c.Status));
      case 'confirmacao': return service.aConfirmar(P.db).map((x) => x.c);
      case 'historico': return list.filter((c) => new Date(c.DataHora).getTime() < now || ['Realizada', 'Faltou', 'Cancelada', 'Recusada'].includes(c.Status)).reverse();
      default: return list.filter((c) => new Date(c.DataHora).getTime() >= now - 60 * 6e4 && !['Cancelada', 'Recusada', 'Realizada', 'Faltou'].includes(c.Status));
    }
  }

  function renderCalendar(list) {
    const m = state.month;
    const first = new Date(m.getFullYear(), m.getMonth(), 1);
    const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const today = util.isoDate();
    const busy = new Map();
    list.filter((c) => !['Cancelada', 'Recusada'].includes(c.Status)).forEach((c) => {
      const k = util.isoDate(c.DataHora);
      busy.set(k, (busy.get(k) || 0) + 1);
    });
    let cells = '';
    for (let i = 0; i < first.getDay(); i++) cells += '<span></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = util.isoDate(new Date(m.getFullYear(), m.getMonth(), d));
      const cob = rules.coberturaBloqueio(P.db, iso).tipo;
      const cls = [iso === today ? 'today' : '', iso === state.selected ? 'selected' : '', busy.has(iso) ? 'busy' : '', cob ? `blk-${cob}` : ''].join(' ');
      const extra = `${busy.has(iso) ? `, ${busy.get(iso)} consulta(s)` : ''}${cob === 'total' ? ', agenda bloqueada' : cob === 'parcial' ? ', parte do dia bloqueada' : ''}`;
      cells += `<button class="cal-day ${cls}" data-day="${iso}" aria-label="${util.fmtDateLong(iso)}${extra}">${d}</button>`;
    }
    $('#cal-title').textContent = `${util.capitalize(util.MESES[m.getMonth()])} ${m.getFullYear()}`;
    $('#cal-grid').innerHTML = cells;
  }

  function renderResumo(list) {
    const m = state.month;
    const doMes = list.filter((c) => { const d = new Date(c.DataHora); return d.getMonth() === m.getMonth() && d.getFullYear() === m.getFullYear(); });
    const confirmadas = doMes.filter((c) => ['Agendada', 'Realizada'].includes(c.Status));
    const pendentes = doMes.filter((c) => ['Pendente', 'Aguardando_Paciente'].includes(c.Status));
    const horas = confirmadas.reduce((s, c) => s + rules.duracaoMin(c.Duracao), 0) / 60;
    const semConfirmacao = service.aConfirmar(P.db).filter((x) => x.s.codigo === 'PENDENTE_CONFIRMACAO' && list.includes(x.c)).length;
    $('#resumo-mes').innerHTML = `
      <div class="row-between"><span class="text-2">Total de consultas</span><strong>${doMes.filter((c) => !['Cancelada', 'Recusada'].includes(c.Status)).length}</strong></div>
      <div class="row-between"><span class="text-2">Confirmadas / realizadas</span><strong class="text-success">${confirmadas.length}</strong></div>
      <div class="row-between"><span class="text-2">Pendentes</span><strong class="text-warning">${pendentes.length}</strong></div>
      <div class="row-between"><span class="text-2">Presença não confirmada</span><strong class="${semConfirmacao ? 'text-danger' : ''}">${semConfirmacao}</strong></div>
      <div class="row-between"><span class="text-2">Horas de atendimento</span><strong>${horas.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}h</strong></div>`;
  }

  function renderRegras() {
    const pz = rules.prazos(P.db);
    const li = (icon, html) => `<li>${P.icon(icon, 15)}<span>${html}</span></li>`;
    $('#regras-lista').innerHTML = [
      li('calendar', `Novos agendamentos: mínimo de <strong>${pz.AntecedenciaAgendamentoHoras} h</strong> de antecedência.`),
      li('swap', `Reagendamento pelo paciente: só com mais de <strong>${pz.AntecedenciaReagendamentoHoras} h</strong> para a consulta.`),
      li('check-circle', `Confirmação de presença até <strong>${pz.PrazoConfirmacaoHoras} h</strong> antes (lembrete ${pz.LembreteConfirmacaoHoras} h antes do prazo).`),
      li('lock', `Cancelamento pelo paciente: mínimo de <strong>${pz.LimiteAlteracaoHoras} h</strong> de antecedência.`),
      li('clock', `Intervalo mínimo de <strong>${INTERVALO_MINIMO_MIN} min</strong> entre consultas, considerando a duração.`),
      li('x-circle', 'Sem agendamentos em datas passadas, dias bloqueados ou horários ocupados.'),
    ].join('');
  }

  /** Bloco de confirmação de presença no card da consulta. */
  function confirmacaoHtml(c, user) {
    const s = rules.situacaoConfirmacao(P.db, c);
    if (!s) return '';
    const prazo = util.fmtDateTime(s.prazo);
    if (s.codigo === 'CONFIRMADA') {
      return `<div class="conf-note ok">${P.icon('check-circle', 14)} Presença confirmada${c.ConfirmadaEm ? ` em ${util.fmtDateTime(c.ConfirmadaEm)}` : ''}${c.ConfirmadaPor === 'Psicóloga' ? ' (registrada pela psicóloga)' : ''}${s.tardia ? ' · após o prazo' : ''}.</div>`;
    }
    if (user.tipo === 'paciente') {
      if (s.codigo === 'PENDENTE_CONFIRMACAO') return `<div class="conf-note late">${P.icon('alert', 14)} O prazo para confirmar terminou em ${prazo} (${s.prazoHoras} h antes). Confirme agora ou fale com a psicóloga — a vaga pode ser liberada.</div>`;
      return `<div class="conf-note ${s.codigo === 'LEMBRETE' ? 'warn' : ''}">${P.icon('clock', 14)} Confirme sua presença até <strong>${prazo}</strong> (${s.prazoHoras} h antes da consulta).</div>`;
    }
    if (s.codigo === 'PENDENTE_CONFIRMACAO') return `<div class="conf-note late">${P.icon('alert', 14)} <strong>PENDENTE_CONFIRMACAO</strong> — o paciente não confirmou até ${prazo}. Registre a confirmação ou libere a vaga.</div>`;
    return `<div class="conf-note ${s.codigo === 'LEMBRETE' ? 'warn' : ''}">${P.icon('clock', 14)} Aguardando confirmação do paciente até ${prazo}${c.LembreteConfirmacaoEm ? ` · lembrete enviado ${util.relTime(c.LembreteConfirmacaoEm)}` : ''}.</div>`;
  }

  /** Tag de confirmação (verde/amarela/vermelha) ao lado do status. */
  function confirmacaoBadge(c) {
    const s = rules.situacaoConfirmacao(P.db, c);
    return s ? ui.statusBadge(s.codigo) : '';
  }

  function actionsFor(c, user) {
    const btn = (act, label, variant, icon, extra = '') => `<button class="btn btn-sm ${variant}" data-act="${act}" data-id="${c.ID_Consulta}" ${extra}>${icon ? P.icon(icon, 14) : ''}${label}</button>`;
    const out = [];
    const passou = new Date(c.DataHora).getTime() <= Date.now();
    const conf = rules.situacaoConfirmacao(P.db, c);
    if (user.tipo === 'psicologo') {
      if (c.Status === 'Pendente') out.push(btn('aceitar', 'Aceitar', 'btn-success', 'check'), btn('sugerir', 'Sugerir horário', 'btn-outline', 'swap'), btn('recusar', 'Recusar', 'btn-danger', 'x'));
      if (c.Status === 'Agendada') {
        if (passou) out.push(btn('realizada', 'Realizada', 'btn-success', 'check'), btn('faltou', 'Faltou', 'btn-warning', 'x'));
        else {
          if (conf && conf.codigo !== 'CONFIRMADA') out.push(btn('registrar-confirmacao', 'Registrar confirmação', conf.codigo === 'PENDENTE_CONFIRMACAO' ? 'btn-success' : 'btn-outline', 'check-circle'));
          if (conf && conf.codigo === 'PENDENTE_CONFIRMACAO') out.push(btn('lembrete', 'Reenviar lembrete', 'btn-outline', 'bell'), btn('liberar', 'Liberar vaga', 'btn-danger', 'x'));
          out.push(btn('remarcar', 'Remarcar', 'btn-outline', 'calendar'));
          if (!conf || conf.codigo !== 'PENDENTE_CONFIRMACAO') out.push(btn('cancelar', 'Cancelar', 'btn-ghost', 'x'));
        }
      }
      if (['Agendada', 'Realizada'].includes(c.Status)) out.push(`<a class="btn btn-sm btn-ghost" href="${P.url('anotacoes', `paciente=${encodeURIComponent(c.CPF_Paciente)}`)}">${P.icon('clipboard', 14)}Prontuário</a>`);
    } else {
      if (c.Status === 'Aguardando_Paciente') out.push(btn('aceitar-proposta', 'Aceitar novo horário', 'btn-success', 'check'), btn('recusar-proposta', 'Recusar', 'btn-danger', 'x'));
      if (c.Status === 'Pendente') {
        const re = rules.validaReagendamento(P.db, c, user);
        out.push(btn('remarcar', 'Alterar horário', 'btn-outline', re.permitido ? 'calendar' : 'lock'), btn('cancelar', 'Cancelar solicitação', 'btn-ghost', 'x'));
      }
      if (c.Status === 'Agendada' && !passou) {
        if (conf && conf.codigo !== 'CONFIRMADA') out.push(btn('confirmar-presenca', 'Confirmar presença', 'btn-success', 'check-circle'));
        const re = rules.validaReagendamento(P.db, c, user);
        const ca = rules.validaLimiteAlteracao(P.db, c, user);
        out.push(btn('remarcar', 'Remarcar', 'btn-outline', re.permitido ? 'calendar' : 'lock'), btn('cancelar', 'Cancelar', 'btn-ghost', ca.permitido ? 'x' : 'lock'));
      }
    }
    return out.join('');
  }

  function consultaCard(c, user) {
    const d = new Date(c.DataHora);
    const nome = user.tipo === 'psicologo' ? P.q.pacienteNome(c.CPF_Paciente) : P.db.psicologo.Nome;
    const futura = d.getTime() > Date.now();
    const re = user.tipo === 'paciente' && futura && ['Agendada', 'Pendente'].includes(c.Status) ? rules.validaReagendamento(P.db, c, user) : null;
    const ca = user.tipo === 'paciente' && futura && c.Status === 'Agendada' ? rules.validaLimiteAlteracao(P.db, c, user) : null;
    const fim = new Date(d.getTime() + rules.duracaoMin(c.Duracao) * 6e4);
    const conf = rules.situacaoConfirmacao(P.db, c);
    const bloq = futura && STATUS_ATIVOS.includes(c.Status) && user.tipo === 'psicologo' ? rules.bloqueiosNoPeriodo(P.db, d.getTime(), fim.getTime())[0] : null;
    let travas = '';
    if (re && !re.permitido) travas += `<div class="lock-note">${P.icon('lock', 14)} Reagendamento bloqueado: faltam ${fmtH(re.horasRestantes)} h (mínimo de mais de ${re.limiteHoras} h).</div>`;
    if (ca && !ca.permitido) travas += `<div class="lock-note">${P.icon('lock', 14)} Cancelamento bloqueado: limite de ${ca.limiteHoras} h.</div>`;
    if (re && re.permitido && c.Status === 'Agendada') travas += `<div class="text-xs text-muted mt-8">${P.icon('info', 12)} Você pode reagendar até ${re.limiteHoras} h antes e cancelar até ${ca ? ca.limiteHoras : rules.prazos(P.db).LimiteAlteracaoHoras} h antes da consulta.</div>`;
    return `
      <article class="appt ${c.ID_Consulta === state.highlight ? 'highlight' : ''} status-${c.Status} ${conf ? `conf-${conf.codigo}` : ''}" id="consulta-${c.ID_Consulta}">
        <div class="appt-date"><span>${util.DIAS_CURTOS[d.getDay()]}</span><strong>${d.getDate()}</strong><span>${util.MESES_CURTOS[d.getMonth()]}</span></div>
        <div class="appt-body">
          <div class="row-between wrap">
            <div class="row gap-6">${user.tipo === 'psicologo' ? ui.avatar(nome, 'sm') : ''}<h3 class="appt-name">${esc(nome)}</h3></div>
            <div class="row gap-6 wrap">${confirmacaoBadge(c)}${ui.statusBadge(c.Status)}</div>
          </div>
          ${c.Observacoes ? `<p class="appt-obs">${esc(c.Observacoes)}</p>` : ''}
          <div class="appt-meta">
            <span>${P.icon('clock', 14)} ${util.fmtTime(d)}–${util.fmtTime(fim)} · ${c.Duracao}</span>
            <span class="${c.Modalidade === 'Online' ? 'mod-online' : 'mod-presencial'}">${P.icon(c.Modalidade === 'Online' ? 'video' : 'pin', 14)} ${c.Modalidade}</span>
            <span class="text-muted">#${c.ID_Consulta} · solicitada por ${esc(c.Solicitante === 'Psicóloga' ? 'psicóloga' : 'paciente')}</span>
          </div>
          ${c.Status === 'Aguardando_Paciente' && c.DataHoraSugerida ? `<div class="proposal">${P.icon('swap', 15)}<div><strong>Novo horário sugerido:</strong> ${util.capitalize(util.fmtDateLong(c.DataHoraSugerida))} às ${util.fmtTime(c.DataHoraSugerida)}<div class="text-xs">Solicitado inicialmente para ${util.fmtDateTime(c.DataHora)}${user.tipo === 'psicologo' ? ' · aguardando resposta do paciente' : ''}</div></div></div>` : ''}
          ${bloq ? `<div class="conf-note late">${P.icon('lock', 14)} Esta consulta está dentro de um bloqueio da agenda (${esc(rules.rotuloBloqueio(bloq))}${bloq.Motivo ? ` — ${esc(bloq.Motivo)}` : ''}).</div>` : ''}
          ${c.MotivoCancelamento && ['Recusada', 'Cancelada'].includes(c.Status) ? `<div class="text-xs text-muted mt-8">Motivo: ${esc(c.MotivoCancelamento)}</div>` : ''}
          ${confirmacaoHtml(c, user)}
          ${travas}
          <div class="appt-actions">${actionsFor(c, user)}</div>
        </div>
      </article>`;
  }

  function bannerDia(user) {
    if (state.filtro !== 'dia') return '';
    const cob = rules.coberturaBloqueio(P.db, state.selected);
    if (!cob.tipo) return '';
    if (user.tipo === 'paciente') return `<div class="blk-banner">${P.icon('lock', 16)}<span>${cob.tipo === 'total' ? 'A agenda da psicóloga está bloqueada neste dia.' : 'Parte deste dia está bloqueada na agenda da psicóloga.'}</span></div>`;
    return cob.bloqueios.map((b) => `<div class="blk-banner">${P.icon('lock', 16)}<span class="grow"><strong>Agenda bloqueada:</strong> ${esc(rules.rotuloBloqueio(b))}${b.Motivo ? ` — ${esc(b.Motivo)}` : ''}</span>
      <button class="btn btn-ghost btn-sm" data-blk-edit="${b.ID_Bloqueio}">${P.icon('edit', 14)}Editar</button><button class="btn btn-ghost btn-sm" data-blk-del="${b.ID_Bloqueio}">${P.icon('trash', 14)}Remover</button></div>`).join('');
  }

  function renderList(list, user) {
    const filtered = filtrar(list);
    const titleMap = { dia: util.capitalize(util.fmtDateLong(state.selected)), proximas: 'Próximas consultas', pendentes: 'Pendentes de resposta', historico: 'Histórico', confirmacao: 'Aguardando confirmação de presença' };
    $('#list-title').textContent = titleMap[state.filtro];
    $('#list-sub').textContent = `${filtered.length} consulta${filtered.length === 1 ? '' : 's'}`;
    const aConf = user.tipo === 'psicologo' ? service.aConfirmar(P.db) : [];
    $('#agenda-filtros').innerHTML = FILTROS.filter((f) => !f.roles || f.roles.includes(user.tipo)).map((f) => {
      let n = null, tone = '';
      if (f.id === 'pendentes') n = list.filter((c) => ['Pendente', 'Aguardando_Paciente'].includes(c.Status)).length;
      if (f.id === 'confirmacao') { n = aConf.filter((x) => x.s.codigo === 'PENDENTE_CONFIRMACAO').length; tone = 'danger'; }
      return `<button class="chip ${state.filtro === f.id ? 'active' : ''}" data-filtro="${f.id}">${f.label}${n ? ` <span class="count ${tone}">${n}</span>` : ''}</button>`;
    }).join('');
    $('#agenda-list').innerHTML = bannerDia(user) + (filtered.length
      ? filtered.map((c) => consultaCard(c, user)).join('')
      : ui.empty('calendar', 'Nenhuma consulta aqui', state.filtro === 'dia' ? 'Não há consultas para o dia selecionado.' : state.filtro === 'confirmacao' ? 'Todas as consultas confirmadas já tiveram a presença confirmada.' : 'Nada para exibir com este filtro.'));
    if (state.highlight) {
      const el = $(`#consulta-${state.highlight}`);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); state.highlight = null; }
    }
  }

  function handleAction(act, id) {
    const user = P.currentUser();
    const c = P.q.consulta(id);
    if (!c) return;
    switch (act) {
      case 'aceitar': run(() => service.aceitar(P.db, user, id), 'Consulta confirmada. O paciente foi notificado.'); break;
      case 'sugerir': openContraproposta(c); break;
      case 'recusar': openMotivo({ title: 'Recusar solicitação', label: 'Motivo da recusa (enviado ao paciente)', confirmLabel: 'Recusar', onConfirm: (m) => { service.recusar(P.db, P.currentUser(), id, m); ui.toast('Solicitação recusada. Horário liberado.', 'success'); } }); break;
      case 'remarcar': openRemarcar(c); break;
      case 'cancelar': openCancelar(c); break;
      case 'realizada': run(() => service.registrarComparecimento(P.db, user, id, 'Realizada'), 'Consulta marcada como realizada.'); break;
      case 'faltou': run(() => service.registrarComparecimento(P.db, user, id, 'Faltou'), 'Falta registrada.'); break;
      case 'aceitar-proposta': run(() => service.responderSugestao(P.db, user, id, 'aceitar'), 'Novo horário confirmado!'); break;
      case 'recusar-proposta': openMotivo({ title: 'Recusar proposta', label: 'Motivo (opcional)', confirmLabel: 'Recusar proposta', onConfirm: (m) => { service.responderSugestao(P.db, P.currentUser(), id, 'recusar', m); ui.toast('Proposta recusada.', 'success'); } }); break;
      case 'confirmar-presenca': run(() => service.confirmarPresenca(P.db, user, id), (r) => (r.ConfirmacaoTardia ? 'Presença confirmada (após o prazo). A psicóloga foi avisada.' : 'Presença confirmada. Até lá!')); break;
      case 'registrar-confirmacao': run(() => service.confirmarPresenca(P.db, user, id), 'Confirmação de presença registrada.'); break;
      case 'lembrete': run(() => service.reenviarLembrete(P.db, user, id), 'Lembrete reenviado ao paciente.'); break;
      case 'liberar': openLiberarVaga(c); break;
      default: break;
    }
  }

  function handleBloqueioClick(e) {
    const ed = e.target.closest('[data-blk-edit]');
    const del = e.target.closest('[data-blk-del]');
    if (!ed && !del) return false;
    const id = Number((ed || del).dataset[ed ? 'blkEdit' : 'blkDel']);
    const b = (P.db.bloqueios || []).find((x) => x.ID_Bloqueio === id);
    if (!b) return true;
    if (ed) openBloqueio(b); else removerBloqueio(b);
    return true;
  }

  P.page({
    init() {
      $('#cal-prev').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1); render(); });
      $('#cal-next').addEventListener('click', () => { state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1); render(); });
      $('#cal-today').addEventListener('click', () => { const t = new Date(); state.month = new Date(t.getFullYear(), t.getMonth(), 1); state.selected = util.isoDate(t); state.filtro = 'dia'; render(); });
      $('#cal-grid').addEventListener('click', (e) => {
        const b = e.target.closest('[data-day]'); if (!b) return;
        state.selected = b.dataset.day; state.filtro = 'dia'; render();
      });
      $('#agenda-filtros').addEventListener('click', (e) => {
        const b = e.target.closest('[data-filtro]'); if (!b) return;
        state.filtro = b.dataset.filtro; render();
      });
      $('#agenda-list').addEventListener('click', (e) => {
        if (handleBloqueioClick(e)) return;
        const b = e.target.closest('[data-act]'); if (!b) return;
        handleAction(b.dataset.act, Number(b.dataset.id));
      });
      $('#btn-solicitar').addEventListener('click', openSolicitar);
      $('#btn-bloquear').addEventListener('click', () => openBloqueio());
      $('#bloqueios-lista').addEventListener('click', handleBloqueioClick);
      $('#bloqueios-passados').addEventListener('click', () => { state.bloqueiosPassados = !state.bloqueiosPassados; render(); });
      if (params.has('bloquear') && P.currentUser().tipo === 'psicologo') setTimeout(() => openBloqueio(), 50);
    },
    render,
  });

  function render() {
    const user = P.currentUser();
    const list = service.listar(P.db, user);
    const pz = rules.prazos(P.db);
    $('#btn-solicitar').hidden = user.tipo !== 'paciente';
    $('#agenda-role-note').innerHTML = user.tipo === 'psicologo'
      ? `${P.icon('info', 15)}<span>O agendamento é iniciado <strong>exclusivamente pelo paciente</strong>. Você confirma, recusa ou sugere outro horário, e bloqueia dias ou horários em <strong>Bloqueio de dias/horários</strong>.</span>`
      : `${P.icon('info', 15)}<span>Solicite com pelo menos <strong>${pz.AntecedenciaAgendamentoHoras} h</strong> de antecedência; a confirmação final é da psicóloga. Reagendar só com mais de <strong>${pz.AntecedenciaReagendamentoHoras} h</strong> e confirme sua presença até <strong>${pz.PrazoConfirmacaoHoras} h</strong> antes.</span>`;
    $('#agenda-sub').textContent = user.tipo === 'psicologo' ? 'Gerencie solicitações, confirmações, bloqueios e comparecimentos.' : 'Suas consultas com a psicóloga.';
    if (!FILTROS.some((f) => f.id === state.filtro && (!f.roles || f.roles.includes(user.tipo)))) state.filtro = 'proximas';
    renderCalendar(list);
    renderResumo(list);
    renderRegras();
    renderBloqueios(user);
    renderList(list, user);
  }
})(window.PRISMA);
