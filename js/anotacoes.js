/* =========================================================================
   PRISMA — anotacoes.js
   Prontuário clínico organizado POR PACIENTE e POR SESSÃO.

   Interface
     • Lista de pacientes → ao escolher um paciente, apenas o prontuário dele
       é exibido (visualização isolada).
     • Sub-navbar de sessões: [Sessão #22 · 25/08] [Sessão #24 · 15/09] [Sessão Atual · Hoje]
       Clicar em uma aba carrega instantaneamente a anotação clínica, o
       histórico e os arquivos anexados SOMENTE daquela sessão.
     • Anexos por sessão: .txt, .doc, .docx e .pdf (upload, download,
       edição de .txt em versões, substituição e remoção lógica).

   Service (mesmo contrato das rotas do backend — server/src/routes/prontuario.routes.js)
     sessoesPaciente(db, user, cpf)      ↔ GET  /api/prontuario/paciente/:cpf/sessoes
     sessao(db, user, idConsulta)         ↔ GET  /api/prontuario/sessao/:idConsulta
     anexar(db, user, idConsulta, arq)    ↔ POST /api/prontuario/sessao/:idConsulta/anexo
     editarTexto / substituir / remover   ↔ PUT/DELETE /api/prontuario/anexo/:idAnexo

   Regras
     • Sigilo: acesso EXCLUSIVO do psicólogo (CFP + LGPD); tentativas do
       paciente são bloqueadas e auditadas (CT02).
     • Sessão = consulta Realizada ou Agendada com data até hoje.
     • Um registro clínico por consulta (UQ_RC_Consulta); DataUltMod automática.
     • Anexos: extensão permitida + assinatura binária do arquivo conferida
       (um .exe renomeado para .pdf é recusado). Nada é apagado fisicamente.
   ========================================================================= */
(function (P) {
  'use strict';
  const { util, core } = P;
  const { RuleError } = core;

  const CAMPOS = [
    { key: 'QueixaPrincipal', label: 'Queixa principal' },
    { key: 'IntervencoesRealizadas', label: 'Intervenções realizadas' },
    { key: 'ProgressoObservado', label: 'Progresso observado' },
    { key: 'TarefasParaCasa', label: 'Tarefas para casa' },
  ];

  const MODELO_TCC = {
    QueixaPrincipal: 'Paciente relatou…',
    IntervencoesRealizadas: '• Revisão das tarefas da sessão anterior\n• Identificação de pensamentos automáticos\n• Reestruturação cognitiva (questionamento socrático)\n• Técnica comportamental: ',
    ProgressoObservado: 'Paciente demonstrou…',
    TarefasParaCasa: '1. Registro de pensamentos (RPD) — 3x/semana\n2. \n3. ',
  };

  /** Formatos aceitos e assinatura binária ("magic bytes") de cada um */
  const FORMATOS = {
    txt: { mime: 'text/plain', rotulo: 'Texto', editavel: true, assinatura: null },
    doc: { mime: 'application/msword', rotulo: 'Word 97-2003', assinatura: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] },
    docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rotulo: 'Word', assinatura: [0x50, 0x4B, 0x03, 0x04] },
    pdf: { mime: 'application/pdf', rotulo: 'PDF', assinatura: [0x25, 0x50, 0x44, 0x46] },
  };
  /** Limite no protótipo (localStorage). A API aceita até 10 MB (LONGBLOB). */
  const LIMITE_BYTES = 750 * 1024;
  const STATUS_SESSAO = ['Realizada', 'Agendada'];

  const extensaoDe = (nome = '') => (String(nome).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

  /* =====================================================================
     SERVICE
     ===================================================================== */
  const service = {
    CAMPOS, MODELO_TCC, FORMATOS, LIMITE_BYTES, extensaoDe,

    /** Barreira de acesso (RBAC + LGPD). */
    assertAcesso(db, user) {
      if (!user || user.tipo !== 'psicologo') {
        core.audit(db, user, 'ACESSO_BLOQUEADO_PRONTUARIO', 'Tentativa não autorizada de leitura de prontuário clínico', false);
        throw new RuleError('Acesso proibido: registros clínicos e anotações de sessão são sigilosos e exclusivos da psicóloga responsável (Código de Ética do Psicólogo e LGPD).', 'RBAC/LGPD');
      }
    },

    /** Registra um evento no histórico da sessão (Sessao_Historico). */
    historico(db, user, idConsulta, acao, detalhes) {
      db.historicoSessao = db.historicoSessao || [];
      db.historicoSessao.push({
        ID_Historico: P.nextId('historico', db), ID_Consulta: Number(idConsulta), DataHora: new Date().toISOString(),
        Acao: acao, UsuarioId: user ? user.id : 'sistema', Detalhes: detalhes,
      });
    },

    /** Pacientes que possuem prontuário (ativos ou inativos — o prontuário é mantido). */
    pacientesComProntuario(db, user) {
      service.assertAcesso(db, user);
      return db.pacientes
        .filter((p) => ['ATIVO', 'INATIVO'].includes(p.Status))
        .map((p) => {
          const sessoes = service.sessoesPaciente(db, user, p.CPF);
          return { ...p, QtdSessoes: sessoes.length, UltimaSessao: sessoes.length ? sessoes[sessoes.length - 1].DataHora : null };
        })
        .sort((a, b) => a.Nome.localeCompare(b.Nome));
    },

    /**
     * GET /api/prontuario/paciente/:cpf/sessoes
     * Sessões do paciente em ordem cronológica, numeradas: usa o NumeroSessao do
     * registro clínico quando existe; caso contrário, anterior + 1.
     */
    sessoesPaciente(db, user, cpf) {
      service.assertAcesso(db, user);
      const hoje = util.isoDate();
      const lista = db.consultas
        .filter((c) => c.CPF_Paciente === cpf && STATUS_SESSAO.includes(c.Status) && util.isoDate(c.DataHora) <= hoje)
        .sort((a, b) => new Date(a.DataHora) - new Date(b.DataHora));
      let anterior = 0;
      return lista.map((c) => {
        const rc = db.registrosClinicos.find((r) => r.ID_Consulta === c.ID_Consulta) || null;
        const numero = rc && rc.NumeroSessao ? rc.NumeroSessao : anterior + 1;
        anterior = numero;
        const atual = util.isoDate(c.DataHora) === hoje;
        const data = util.fmtDate(c.DataHora).slice(0, 5);
        return {
          ID_Consulta: c.ID_Consulta, Numero: numero, DataHora: c.DataHora, Status: c.Status,
          Modalidade: c.Modalidade, Duracao: c.Duracao, Atual: atual,
          Rotulo: atual ? 'Sessão Atual - Hoje' : `Sessão #${numero} - ${data}`,
          ID_RC: rc ? rc.ID_RC : null,
          QtdAnexos: (db.anexosSessao || []).filter((a) => a.ID_Consulta === c.ID_Consulta && !a.Removido).length,
        };
      });
    },

    /** GET /api/prontuario/sessao/:idConsulta — anotação, anexos (sem conteúdo), histórico e documentos da sessão. */
    sessao(db, user, idConsulta) {
      service.assertAcesso(db, user);
      const consulta = P.q.consulta(idConsulta, db);
      if (!consulta) throw new RuleError('Sessão não encontrada.', 'FK');
      const numero = (service.sessoesPaciente(db, user, consulta.CPF_Paciente).find((s) => s.ID_Consulta === consulta.ID_Consulta) || {}).Numero || null;
      return {
        consulta, numero,
        registro: db.registrosClinicos.find((r) => r.ID_Consulta === consulta.ID_Consulta) || null,
        anexos: (db.anexosSessao || [])
          .filter((a) => a.ID_Consulta === consulta.ID_Consulta && !a.Removido)
          .map(({ ConteudoTexto, ConteudoBase64, ...meta }) => meta)
          .sort((a, b) => (a.DataEnvio > b.DataEnvio ? 1 : -1)),
        historico: (db.historicoSessao || []).filter((h) => h.ID_Consulta === consulta.ID_Consulta)
          .sort((a, b) => (b.DataHora > a.DataHora ? 1 : b.DataHora < a.DataHora ? -1 : b.ID_Historico - a.ID_Historico)),
        documentos: db.documentos.filter((d) => d.ID_Consulta === consulta.ID_Consulta),
      };
    },

    /** Valida extensão, tamanho e assinatura binária de um arquivo. */
    validarArquivo({ nomeArquivo, tamanhoBytes, bytesIniciais }) {
      const ext = extensaoDe(nomeArquivo);
      const fmt = FORMATOS[ext];
      if (!fmt) throw new RuleError('Formato não permitido. Envie arquivos .txt, .doc, .docx ou .pdf.', 'CHK_Anexo_Extensao');
      if (!tamanhoBytes) throw new RuleError('O arquivo está vazio.', 'CHK_Anexo_Tamanho');
      if (tamanhoBytes > LIMITE_BYTES) throw new RuleError(`Arquivo muito grande para o protótipo (máx. ${Math.round(LIMITE_BYTES / 1024)} KB; a API aceita até 10 MB).`, 'CHK_Anexo_Tamanho');
      if (fmt.assinatura && bytesIniciais) {
        const ok = fmt.assinatura.every((b, i) => bytesIniciais[i] === b);
        if (!ok) throw new RuleError(`O conteúdo não corresponde a um arquivo .${ext} válido.`, 'Assinatura do arquivo');
      }
      return { ext, fmt };
    },

    /** POST /api/prontuario/sessao/:idConsulta/anexo */
    anexar(db, user, idConsulta, { nomeArquivo, tamanhoBytes, conteudoTexto = null, conteudoBase64 = null, bytesIniciais = null, descricao = '' }) {
      service.assertAcesso(db, user);
      const c = P.q.consulta(idConsulta, db);
      if (!c) throw new RuleError('Sessão não encontrada.', 'FK_Anexo_Consulta');
      if (!STATUS_SESSAO.includes(c.Status)) throw new RuleError('Anexos só podem ser vinculados a sessões realizadas ou agendadas.', 'TRG_Valida_Anexo');
      const nome = String(nomeArquivo || '').trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 200);
      const { ext, fmt } = service.validarArquivo({ nomeArquivo: nome, tamanhoBytes, bytesIniciais });
      if (ext === 'txt' && conteudoTexto == null) throw new RuleError('Conteúdo de texto ausente.', 'Anexo');
      if (ext !== 'txt' && !conteudoBase64) throw new RuleError('Conteúdo do arquivo ausente.', 'Anexo');
      const agora = new Date().toISOString();
      const anexo = {
        ID_Anexo: P.nextId('anexo', db), ID_Consulta: c.ID_Consulta, CPF_Paciente: c.CPF_Paciente, CRP_Psicologo: user.id,
        NomeArquivo: nome, Extensao: ext, MimeType: fmt.mime, TamanhoBytes: tamanhoBytes,
        ConteudoTexto: ext === 'txt' ? conteudoTexto : null, ConteudoBase64: ext === 'txt' ? null : conteudoBase64,
        Versao: 1, Descricao: descricao || '', Removido: false, DataEnvio: agora, DataUltMod: agora, EnviadoPor: user.id,
      };
      db.anexosSessao = db.anexosSessao || [];
      db.anexosSessao.push(anexo);
      service.historico(db, user, c.ID_Consulta, 'ANEXO_ENVIADO', nome);
      core.audit(db, user, 'ANEXO_PRONTUARIO', `Arquivo "${nome}" vinculado à sessão (consulta ${c.ID_Consulta})`, true);
      return anexo;
    },

    /** Cria uma anotação externa em texto (.txt) diretamente no navegador. */
    criarNotaTexto(db, user, idConsulta, titulo, texto) {
      const base = String(titulo || 'Anotação').trim().replace(/\.txt$/i, '') || 'Anotação';
      return service.anexar(db, user, idConsulta, {
        nomeArquivo: `${base}.txt`, conteudoTexto: texto || '', tamanhoBytes: Math.max(1, new TextEncoder().encode(texto || ' ').length),
        descricao: 'Anotação criada no prontuário',
      });
    },

    obterAnexo(db, user, idAnexo) {
      service.assertAcesso(db, user);
      const a = (db.anexosSessao || []).find((x) => x.ID_Anexo === Number(idAnexo) && !x.Removido);
      if (!a) throw new RuleError('Arquivo não encontrado.', 'FK');
      return a;
    },

    /** PUT /api/prontuario/anexo/:idAnexo — edição do conteúdo de um .txt (nova versão). */
    editarTexto(db, user, idAnexo, texto) {
      const a = service.obterAnexo(db, user, idAnexo);
      if (a.Extensao !== 'txt') throw new RuleError('Somente arquivos .txt podem ser editados no navegador. Para .doc, .docx e .pdf, baixe, edite e substitua o arquivo.', 'Anexo');
      const bytes = new TextEncoder().encode(texto).length;
      if (bytes > LIMITE_BYTES) throw new RuleError('O texto excede o tamanho máximo permitido.', 'CHK_Anexo_Tamanho');
      if (texto === a.ConteudoTexto) return a;
      Object.assign(a, { ConteudoTexto: texto, TamanhoBytes: bytes, Versao: a.Versao + 1, DataUltMod: new Date().toISOString() });
      service.historico(db, user, a.ID_Consulta, 'ANEXO_EDITADO', `${a.NomeArquivo} → versão ${a.Versao}`);
      core.audit(db, user, 'ANEXO_EDITADO', `Anexo ${a.ID_Anexo} (${a.NomeArquivo}) versão ${a.Versao}`, true);
      return a;
    },

    /** Substitui o arquivo por uma nova versão (mesma extensão). */
    substituir(db, user, idAnexo, { nomeArquivo, tamanhoBytes, conteudoTexto = null, conteudoBase64 = null, bytesIniciais = null }) {
      const a = service.obterAnexo(db, user, idAnexo);
      const { ext } = service.validarArquivo({ nomeArquivo, tamanhoBytes, bytesIniciais });
      if (ext !== a.Extensao) throw new RuleError(`A nova versão deve ser um arquivo .${a.Extensao}.`, 'Anexo');
      Object.assign(a, {
        ConteudoTexto: ext === 'txt' ? conteudoTexto : null, ConteudoBase64: ext === 'txt' ? null : conteudoBase64,
        TamanhoBytes: tamanhoBytes, Versao: a.Versao + 1, DataUltMod: new Date().toISOString(),
      });
      service.historico(db, user, a.ID_Consulta, 'ANEXO_SUBSTITUIDO', `${a.NomeArquivo} → versão ${a.Versao}`);
      core.audit(db, user, 'ANEXO_SUBSTITUIDO', `Anexo ${a.ID_Anexo} versão ${a.Versao}`, true);
      return a;
    },

    /** DELETE /api/prontuario/anexo/:idAnexo — remoção lógica (guarda do prontuário). */
    remover(db, user, idAnexo, motivo = '') {
      const a = service.obterAnexo(db, user, idAnexo);
      a.Removido = true;
      a.DataUltMod = new Date().toISOString();
      service.historico(db, user, a.ID_Consulta, 'ANEXO_REMOVIDO', `${a.NomeArquivo}${motivo ? ` — ${motivo}` : ''}`);
      core.audit(db, user, 'ANEXO_REMOVIDO', `Anexo ${a.ID_Anexo} (${a.NomeArquivo}) removido da sessão`, true);
      return a;
    },

    /* ---------- Registro clínico (anotação da sessão) ---------- */
    listar(db, user, { cpf = null, busca = '' } = {}) {
      service.assertAcesso(db, user);
      let list = db.registrosClinicos.slice();
      if (cpf) list = list.filter((r) => r.CPF_Paciente === cpf);
      if (busca) {
        const q = util.normalize(busca);
        list = list.filter((r) => util.normalize([P.q.pacienteNome(r.CPF_Paciente, db), r.Conteudo, r.QueixaPrincipal, r.IntervencoesRealizadas, r.ProgressoObservado, r.TarefasParaCasa, (r.Tags || []).join(' ')].join(' ')).includes(q));
      }
      return list.sort((a, b) => (b.DataCriacao > a.DataCriacao ? 1 : b.DataCriacao < a.DataCriacao ? -1 : b.ID_RC - a.ID_RC));
    },

    obter(db, user, id) {
      service.assertAcesso(db, user);
      const r = db.registrosClinicos.find((x) => x.ID_RC === Number(id));
      if (!r) throw new RuleError('Registro clínico não encontrado.', 'FK');
      return r;
    },

    consultasSemRegistro(db, cpf) {
      const usadas = new Set(db.registrosClinicos.map((r) => r.ID_Consulta));
      return db.consultas
        .filter((c) => c.CPF_Paciente === cpf && STATUS_SESSAO.includes(c.Status) && !usadas.has(c.ID_Consulta))
        .sort((a, b) => new Date(b.DataHora) - new Date(a.DataHora));
    },

    proximoNumeroSessao(db, cpf, idConsulta = null) {
      if (idConsulta) {
        const s = service.sessoesPaciente(db, { tipo: 'psicologo' }, cpf).find((x) => x.ID_Consulta === Number(idConsulta));
        if (s) return s.Numero;
      }
      return db.registrosClinicos.filter((r) => r.CPF_Paciente === cpf).reduce((mx, r) => Math.max(mx, r.NumeroSessao || 0), 0) + 1;
    },

    criar(db, user, { cpf, idConsulta, usarModelo = false }) {
      service.assertAcesso(db, user);
      const c = P.q.consulta(idConsulta, db);
      if (!c) throw new RuleError('Selecione a consulta/sessão vinculada (obrigatório).', 'FK_RC_Consulta');
      if (c.CPF_Paciente !== cpf) throw new RuleError('A consulta selecionada não pertence a este paciente.', 'FK_RC_Consulta');
      if (db.registrosClinicos.some((r) => r.ID_Consulta === c.ID_Consulta)) throw new RuleError('Esta consulta já possui registro clínico.', 'UQ_RC_Consulta');
      const hoje = util.isoDate();
      const prox = db.consultas
        .filter((x) => x.CPF_Paciente === cpf && x.Status === 'Agendada' && new Date(x.DataHora) > new Date(c.DataHora))
        .sort((a, b) => new Date(a.DataHora) - new Date(b.DataHora))[0];
      const pac = P.q.paciente(cpf, db);
      const r = {
        ID_RC: P.nextId('registro', db), DataCriacao: hoje, DataUltMod: hoje,
        CPF_Paciente: cpf, ID_Consulta: c.ID_Consulta, CRP_Psicologo: user.id,
        NumeroSessao: service.proximoNumeroSessao(db, cpf, c.ID_Consulta), DuracaoMin: parseInt(c.Duracao, 10) - 10 || 50,
        Conteudo: '', QueixaPrincipal: '', IntervencoesRealizadas: '', ProgressoObservado: '', TarefasParaCasa: '',
        ProximaSessao: prox ? util.fmtDateTime(prox.DataHora) : 'A definir', Tags: (pac && pac.Tags ? pac.Tags.slice(0, 2) : []),
        ...(usarModelo ? MODELO_TCC : {}),
      };
      db.registrosClinicos.push(r);
      service.historico(db, user, c.ID_Consulta, 'REGISTRO_CRIADO', `Anotação clínica da sessão ${r.NumeroSessao} criada`);
      core.audit(db, user, 'CRIAR_REGISTRO_CLINICO', `Registro ${r.ID_RC} (sessão ${r.NumeroSessao}) criado para a consulta ${c.ID_Consulta}`, true);
      return r;
    },

    /** Atualização + emulação do TRG_Atualiza_Modificacao_RC */
    atualizar(db, user, id, dados) {
      const r = service.obter(db, user, id);
      const permitidos = ['QueixaPrincipal', 'IntervencoesRealizadas', 'ProgressoObservado', 'TarefasParaCasa', 'ProximaSessao', 'Conteudo', 'DuracaoMin', 'Tags'];
      permitidos.forEach((k) => { if (k in dados) r[k] = dados[k]; });
      if (!r.Conteudo) r.Conteudo = (r.QueixaPrincipal || '').slice(0, 160);
      r.DataUltMod = util.isoDate();
      service.historico(db, user, r.ID_Consulta, 'REGISTRO_EDITADO', `Anotação clínica atualizada`);
      core.audit(db, user, 'ATUALIZAR_REGISTRO_CLINICO', `Registro ${r.ID_RC} atualizado (DataUltMod = ${r.DataUltMod})`, true);
      return r;
    },
  };
  P.services.anotacoes = service;

  /* =====================================================================
     CONTROLADOR DA PÁGINA
     ===================================================================== */
  if (document.body.dataset.page !== 'anotacoes') return;

  const { $, esc } = util;
  const ui = P.ui;
  const params = new URLSearchParams(location.search);
  const state = {
    cpf: params.get('paciente') || null,
    consulta: params.get('consulta') ? Number(params.get('consulta')) : null,
    busca: '', editando: false, auditado: null,
  };

  const ACAO_HIST = {
    REGISTRO_CRIADO: ['file-plus', 'Anotação criada'], REGISTRO_EDITADO: ['edit', 'Anotação editada'],
    ANEXO_ENVIADO: ['paperclip', 'Arquivo anexado'], ANEXO_EDITADO: ['edit', 'Arquivo editado'],
    ANEXO_SUBSTITUIDO: ['refresh', 'Nova versão do arquivo'], ANEXO_REMOVIDO: ['trash', 'Arquivo removido'],
  };

  /** Mantém paciente/sessão na URL (recarregar a página preserva a navegação). */
  function syncUrl() {
    const q = new URLSearchParams();
    if (state.cpf) q.set('paciente', state.cpf);
    if (state.consulta) q.set('consulta', state.consulta);
    history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`);
  }

  /** Converte texto com "•"/"-" ou "1." em listas HTML. */
  function formatText(txt) {
    if (!txt || !String(txt).trim()) return '<p class="text-muted">—</p>';
    const lines = String(txt).split('\n');
    let html = '', list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    lines.forEach((raw) => {
      const line = raw.trim();
      if (!line) { close(); return; }
      let m;
      if ((m = line.match(/^[•\-*]\s*(.*)$/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${esc(m[1])}</li>`; }
      else if ((m = line.match(/^\d+[.)]\s*(.*)$/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${esc(m[1])}</li>`; }
      else { close(); html += `<p>${esc(line)}</p>`; }
    });
    close();
    return html;
  }

  const fmtBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1).replace('.', ',')} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
  const idade = (d) => { if (!d) return null; const n = util.parseDate(d); const h = new Date(); let a = h.getFullYear() - n.getFullYear(); if (h < new Date(h.getFullYear(), n.getMonth(), n.getDate())) a--; return a; };

  function act(fn, ok) {
    try {
      const r = fn();
      if (!P.storage.set('prisma:db:v4', P.db)) {
        // Cota do localStorage excedida: desfaz a alteração em memória recarregando o último estado salvo
        P.db = P.storage.get('prisma:db:v4') || P.db;
        throw new Error('O armazenamento do navegador está cheio. Remova anexos grandes ou use a versão com servidor.');
      }
      P.save('prontuario');
      if (ok) ui.toast(ok, 'success');
      return r;
    } catch (e) { ui.toast(e.message, 'error', 6000); return null; }
  }

  /* ---------- Leitura de arquivos ---------- */
  function lerArquivo(file) {
    return new Promise((resolve, reject) => {
      const ext = service.extensaoDe(file.name);
      const r = new FileReader();
      r.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
      r.onload = () => {
        const buf = new Uint8Array(r.result);
        const bytesIniciais = Array.from(buf.slice(0, 8));
        if (ext === 'txt') {
          if (buf.includes(0)) { reject(new Error('O arquivo .txt contém dados binários — não parece ser um arquivo de texto.')); return; }
          let texto;
          try { texto = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { texto = new TextDecoder('windows-1252').decode(buf); }
          resolve({ nomeArquivo: file.name, tamanhoBytes: file.size, conteudoTexto: texto.replace(/^﻿/, ''), bytesIniciais });
          return;
        }
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        resolve({ nomeArquivo: file.name, tamanhoBytes: file.size, conteudoBase64: `data:${service.FORMATOS[ext] ? service.FORMATOS[ext].mime : 'application/octet-stream'};base64,${btoa(bin)}`, bytesIniciais });
      };
      r.readAsArrayBuffer(file);
    });
  }

  async function enviarArquivos(files) {
    const user = P.currentUser();
    for (const file of files) {
      try {
        service.validarArquivo({ nomeArquivo: file.name, tamanhoBytes: file.size }); // validação rápida antes de ler
        const dados = await lerArquivo(file);
        act(() => service.anexar(P.db, P.currentUser() || user, state.consulta, dados), `"${file.name}" anexado à sessão.`);
      } catch (e) { ui.toast(`${file.name}: ${e.message}`, 'error', 6000); }
    }
  }

  function blobDoAnexo(a) {
    if (a.Extensao === 'txt') return new Blob([a.ConteudoTexto], { type: 'text/plain;charset=utf-8' });
    const [meta, b64] = a.ConteudoBase64.split(',');
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: (meta.match(/data:([^;]+)/) || [])[1] || a.MimeType });
  }

  function baixar(id) {
    try {
      const user = P.currentUser();
      const a = service.obterAnexo(P.db, user, id);
      ui.download(a.NomeArquivo, blobDoAnexo(a));
      core.audit(P.db, user, 'DOWNLOAD_ANEXO_PRONTUARIO', `Anexo ${a.ID_Anexo} (${a.NomeArquivo})`, true);
      P.persist();
    } catch (e) { ui.toast(e.message, 'error'); }
  }

  function visualizarPdf(id) {
    const a = service.obterAnexo(P.db, P.currentUser(), id);
    const url = URL.createObjectURL(blobDoAnexo(a));
    const w = window.open(url, '_blank', 'noopener');
    if (!w) ui.download(a.NomeArquivo, blobDoAnexo(a));
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function abrirEditorTexto(id) {
    const a = service.obterAnexo(P.db, P.currentUser(), id);
    ui.formModal({
      title: a.NomeArquivo, subtitle: `Versão ${a.Versao} · editado em ${util.fmtDateTime(a.DataUltMod)} — salvar cria uma nova versão.`,
      size: 'lg', submitLabel: 'Salvar nova versão', submitIcon: 'check',
      body: `<textarea class="textarea editor-txt" name="texto" rows="18" spellcheck="true" aria-label="Conteúdo do arquivo">${esc(a.ConteudoTexto)}</textarea>
        <div class="row-between mt-8 text-xs text-muted"><span data-count></span><span>Formato: texto simples (.txt, UTF-8)</span></div>`,
      onOpen(el) {
        const t = el.querySelector('[name=texto]'); const c = el.querySelector('[data-count]');
        const upd = () => { c.textContent = `${t.value.length.toLocaleString('pt-BR')} caracteres`; };
        t.addEventListener('input', upd); upd();
      },
      onSubmit(d, form) {
        const texto = form.querySelector('[name=texto]').value; // preserva espaços/quebras (formData faz trim)
        const r = act(() => service.editarTexto(P.db, P.currentUser(), a.ID_Anexo, texto), 'Arquivo salvo.');
        if (!r) return false;
      },
    });
  }

  function abrirNovaNota() {
    ui.formModal({
      title: 'Nova anotação em texto', subtitle: 'Será salva como arquivo .txt vinculado a esta sessão.', size: 'lg',
      submitLabel: 'Criar arquivo', submitIcon: 'file-plus',
      body: `<div class="field"><label>Nome do arquivo *</label><input class="input" name="titulo" required data-label="Nome do arquivo" maxlength="120" placeholder="Ex.: Observações pós-sessão"></div>
        <div class="field mt-12"><label>Conteúdo</label><textarea class="textarea editor-txt" name="texto" rows="12"></textarea></div>`,
      onSubmit(d, form) {
        const r = act(() => service.criarNotaTexto(P.db, P.currentUser(), state.consulta, d.titulo, form.querySelector('[name=texto]').value), 'Anotação criada.');
        if (!r) return false;
      },
    });
  }

  function substituirArquivo(id) {
    const a = service.obterAnexo(P.db, P.currentUser(), id);
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = `.${a.Extensao}`;
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const dados = await lerArquivo(f);
        act(() => service.substituir(P.db, P.currentUser(), id, dados), `Nova versão de "${a.NomeArquivo}" salva.`);
      } catch (e) { ui.toast(e.message, 'error'); }
    };
    inp.click();
  }

  function removerArquivo(id) {
    const a = service.obterAnexo(P.db, P.currentUser(), id);
    ui.formModal({
      title: 'Remover arquivo da sessão', subtitle: a.NomeArquivo, size: 'sm', submitLabel: 'Remover', submitVariant: 'btn-danger', submitIcon: 'trash',
      body: `<p class="text-sm text-2 mb-12">O arquivo deixa de aparecer na sessão, mas permanece guardado no prontuário e a remoção fica registrada no histórico.</p>
        <div class="field"><label>Motivo (opcional)</label><input class="input" name="motivo" maxlength="200"></div>`,
      onSubmit(d) { act(() => service.remover(P.db, P.currentUser(), id, d.motivo), 'Arquivo removido da sessão.'); },
    });
  }

  /* ---------- Renderização ---------- */
  function renderPacientes(user) {
    const q = util.normalize(state.busca);
    const lista = service.pacientesComProntuario(P.db, user).filter((p) => !q || util.normalize(`${p.Nome} ${p.CPF}`).includes(q));
    $('#pr-pacientes').innerHTML = lista.length ? lista.map((p) => `
      <button class="pr-paciente ${p.CPF === state.cpf ? 'active' : ''}" data-cpf="${esc(p.CPF)}" aria-pressed="${p.CPF === state.cpf}">
        ${ui.avatar(p.Nome, 'sm')}
        <div class="grow"><div class="fw-700 truncate">${esc(p.Nome)}</div>
          <div class="text-xs sub">${p.QtdSessoes} sessão(ões)${p.UltimaSessao ? ` · última ${util.fmtDate(p.UltimaSessao).slice(0, 5)}` : ''}${p.Status === 'INATIVO' ? ' · inativo' : ''}</div></div>
      </button>`).join('') : ui.empty('users', 'Nenhum paciente encontrado');
  }

  function renderVazio() {
    $('#pr-main').innerHTML = `<div class="card">${ui.empty('clipboard', 'Selecione um paciente', 'O prontuário é exibido por paciente, organizado por sessão.')}</div>`;
  }

  function cabecalhoPaciente(p, sessoes) {
    const totalAnexos = sessoes.reduce((s, x) => s + x.QtdAnexos, 0);
    const metasAtivas = P.db.metas.filter((m) => m.CPF_Paciente === p.CPF && m.Status === 'Ativa').length;
    const id = idade(p.DataNascimento);
    return `
      <section class="card pr-head">
        ${ui.avatar(p.Nome, 'lg')}
        <div class="grow">
          <div class="row wrap gap-6"><h2 class="h2">${esc(p.Nome)}</h2>${p.Status === 'INATIVO' ? ui.statusBadge('INATIVO') : ''}</div>
          <div class="text-sm text-2">CPF ${esc(p.CPF)}${id != null ? ` · ${id} anos` : ''} · ${esc(p.Telefone || '')}</div>
          <div class="text-sm mt-4"><span class="text-muted">Queixa inicial:</span> ${esc(p.QueixaPrincipal || '—')}</div>
        </div>
        <div class="pr-stats">
          <div><strong>${sessoes.length}</strong><span>sessões</span></div>
          <div><strong>${totalAnexos}</strong><span>anexos</span></div>
          <div><a href="${P.url('metas', `paciente=${encodeURIComponent(p.CPF)}`)}"><strong>${metasAtivas}</strong></a><span>metas ativas</span></div>
        </div>
        <div class="pr-links">
          <a class="btn btn-ghost btn-sm" href="${P.url('chat', `com=${encodeURIComponent(p.CPF)}`)}">${P.icon('message', 14)}Chat</a>
          <a class="btn btn-ghost btn-sm" href="${P.url('agenda')}">${P.icon('calendar', 14)}Agenda</a>
        </div>
      </section>`;
  }

  function subNavbar(sessoes) {
    return `
      <div class="session-nav-wrap">
        <button class="icon-btn sm nav-arrow" data-scroll="-1" aria-label="Sessões anteriores">${P.icon('chevron-left', 16)}</button>
        <nav class="session-nav" role="tablist" aria-label="Sessões do paciente" id="session-nav">
          ${sessoes.map((s) => `
            <button role="tab" class="session-tab ${s.ID_Consulta === state.consulta ? 'active' : ''} ${s.Atual ? 'atual' : ''}"
              id="tab-${s.ID_Consulta}" data-sessao="${s.ID_Consulta}" aria-selected="${s.ID_Consulta === state.consulta}"
              aria-controls="pr-sessao" tabindex="${s.ID_Consulta === state.consulta ? 0 : -1}"
              title="${esc(`${util.fmtDateTime(s.DataHora)} · ${s.Modalidade} · ${s.Status}`)}">
              <span class="tab-label">${esc(s.Rotulo)}</span>
              <span class="tab-meta">
                ${s.ID_RC ? `<span class="dot-ok" title="Com anotação"></span>` : '<span class="dot-pend" title="Sem anotação"></span>'}
                ${s.QtdAnexos ? `<span class="tab-clip">${P.icon('paperclip', 11)}${s.QtdAnexos}</span>` : ''}
              </span>
            </button>`).join('')}
        </nav>
        <button class="icon-btn sm nav-arrow" data-scroll="1" aria-label="Próximas sessões">${P.icon('chevron-right', 16)}</button>
      </div>`;
  }

  function cardRegistro(sess) {
    const { registro: r, consulta: c, numero } = sess;
    if (!r) {
      return `<section class="card pr-card">
        <div class="card-head"><h3>${P.icon('clipboard', 16)} Anotação clínica</h3></div>
        <div class="card-body">${ui.empty('file-plus', 'Sessão ainda sem anotação', 'Registre a evolução clínica desta sessão.')}
          <div class="row" style="justify-content:center;gap:8px">
            <button class="btn btn-dark" data-criar="modelo">${P.icon('file-plus', 15)}Criar com modelo TCC</button>
            <button class="btn btn-outline" data-criar="vazio">Criar em branco</button>
          </div></div>
      </section>`;
    }
    if (state.editando) {
      return `<section class="card pr-card">
        <form class="card-body rc-form" id="rc-form">
          <div class="row-between wrap"><h3 class="h3">Editar anotação — Sessão ${numero ?? r.NumeroSessao}</h3>
            <button type="button" class="btn btn-ghost btn-sm" data-modelo>${P.icon('file-plus', 14)}Inserir modelo TCC</button></div>
          <div class="form-grid">
            <div class="field"><label>Duração (min)</label><input class="input" type="number" min="10" max="180" name="DuracaoMin" value="${esc(r.DuracaoMin || 50)}"></div>
            <div class="field"><label>Próxima sessão</label><input class="input" name="ProximaSessao" value="${esc(r.ProximaSessao || '')}"></div>
          </div>
          ${CAMPOS.map((f) => `<div class="field"><label>${f.label}</label><textarea class="textarea" name="${f.key}" rows="${f.key === 'QueixaPrincipal' || f.key === 'ProgressoObservado' ? 3 : 4}">${esc(r[f.key] || '')}</textarea></div>`).join('')}
          <div class="field"><label>Tags <span class="text-muted">(separadas por vírgula)</span></label><input class="input" name="Tags" value="${esc((r.Tags || []).join(', '))}"></div>
          <div class="hint">Use "•" ou "-" para tópicos e "1." para listas numeradas.</div>
          <div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-ghost" data-cancel>Cancelar</button><button class="btn btn-dark" type="submit">${P.icon('check', 15)}Salvar anotação</button></div>
        </form>
      </section>`;
    }
    return `<section class="card pr-card">
      <div class="card-head"><h3>${P.icon('clipboard', 16)} Anotação clínica</h3><button class="btn btn-outline btn-sm" data-edit>${P.icon('edit', 14)}Editar</button></div>
      <article class="rc-body">
        <h2 class="h2">Sessão ${numero ?? r.NumeroSessao} — ${esc(P.q.pacienteNome(c.CPF_Paciente))}</h2>
        <p class="text-sm text-muted">Data: ${util.fmtDate(c.DataHora)} | Duração: ${esc(r.DuracaoMin || 50)} min</p>
        ${CAMPOS.map((f) => `<section class="rc-section"><h4>${f.label}:</h4>${formatText(r[f.key])}</section>`).join('')}
        <p class="text-sm text-muted mt-16">Próxima sessão: ${esc(r.ProximaSessao || '—')}</p>
      </article>
      <footer class="rc-foot">
        <div class="row wrap gap-6">${P.icon('tag', 14)}${(r.Tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="text-xs text-muted">sem tags</span>'}</div>
        <span class="text-xs text-muted mono">Registro_Clinico · ID_RC ${r.ID_RC} · últ. modificação ${util.fmtDate(r.DataUltMod)}</span>
      </footer>
    </section>`;
  }

  function iconeArquivo(ext) {
    return `<span class="file-ic ext-${ext}">${ext.toUpperCase()}</span>`;
  }

  function cardAnexos(sess) {
    const lista = sess.anexos;
    return `<section class="card pr-card" aria-labelledby="anexos-titulo">
      <div class="card-head">
        <h3 id="anexos-titulo">${P.icon('paperclip', 16)} Arquivos da sessão <span class="badge badge-neutral">${lista.length}</span></h3>
        <button class="btn btn-ghost btn-sm" data-nova-nota>${P.icon('file-plus', 14)}Nova nota .txt</button>
      </div>
      <label class="pr-drop" id="pr-drop">
        <input type="file" id="pr-file" multiple accept=".txt,.doc,.docx,.pdf,text/plain,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" class="sr-only">
        ${P.icon('upload', 18)}<span><strong>Anexar arquivo de texto</strong> — arraste aqui ou clique<br><span class="text-xs text-muted">.txt, .doc, .docx ou .pdf · até ${Math.round(LIMITE_BYTES / 1024)} KB neste protótipo</span></span>
      </label>
      <ul class="file-list">
        ${lista.length ? lista.map((a) => `
          <li class="file-item">
            ${iconeArquivo(a.Extensao)}
            <div class="grow">
              <div class="file-name">${esc(a.NomeArquivo)}</div>
              <div class="text-xs text-muted">${fmtBytes(a.TamanhoBytes)} · v${a.Versao} · ${a.Versao > 1 ? `editado ${util.fmtDateTime(a.DataUltMod)}` : `enviado ${util.fmtDateTime(a.DataEnvio)}`}${a.Descricao ? ` · ${esc(a.Descricao)}` : ''}</div>
            </div>
            <div class="file-actions">
              ${a.Extensao === 'txt' ? `<button class="btn btn-outline btn-sm" data-editar-anexo="${a.ID_Anexo}">${P.icon('edit', 13)}Editar texto</button>` : ''}
              ${a.Extensao === 'pdf' ? `<button class="icon-btn sm" data-ver-pdf="${a.ID_Anexo}" title="Visualizar" aria-label="Visualizar PDF">${P.icon('eye', 15)}</button>` : ''}
              <button class="icon-btn sm" data-baixar="${a.ID_Anexo}" title="Baixar" aria-label="Baixar ${esc(a.NomeArquivo)}">${P.icon('download', 15)}</button>
              ${a.Extensao !== 'txt' ? `<button class="btn btn-outline btn-sm" data-substituir="${a.ID_Anexo}" title="Enviar nova versão do arquivo">${P.icon('refresh', 13)}Nova versão</button>` : ''}
              <button class="icon-btn sm" data-remover="${a.ID_Anexo}" title="Remover da sessão" aria-label="Remover ${esc(a.NomeArquivo)}">${P.icon('trash', 15)}</button>
            </div>
          </li>`).join('') : '<li class="file-empty text-sm text-muted">Nenhum arquivo anexado nesta sessão.</li>'}
      </ul>
      ${sess.documentos.length ? `<div class="pr-docs"><div class="eyebrow mb-8">Documentos do repositório vinculados</div>${sess.documentos.map((d) => `<a class="pr-doc" href="${P.url('documentos')}">${P.icon('file', 14)}<span class="truncate">${esc(d.NomeArquivo)}</span><span class="text-xs text-muted">${esc(d.Tipo)}</span></a>`).join('')}</div>` : ''}
    </section>`;
  }

  function cardHistorico(sess) {
    const h = sess.historico;
    return `<section class="card pr-card">
      <div class="card-head"><h3>${P.icon('history', 16)} Histórico da sessão</h3></div>
      <ol class="timeline">
        ${h.length ? h.map((e) => {
          const [ic, label] = ACAO_HIST[e.Acao] || ['info', e.Acao];
          return `<li><span class="tl-ic">${P.icon(ic, 13)}</span><div class="grow"><div class="text-sm fw-600">${label}</div>
            <div class="text-xs text-muted">${esc(e.Detalhes || '')}</div>
            <div class="text-xs text-muted">${util.fmtDateTime(e.DataHora)} · ${esc(P.q.nomeUsuario(e.UsuarioId))}</div></div></li>`;
        }).join('') : '<li class="text-sm text-muted">Sem eventos registrados.</li>'}
        <li><span class="tl-ic muted">${P.icon('calendar', 13)}</span><div class="grow"><div class="text-sm fw-600">Consulta #${sess.consulta.ID_Consulta}</div>
          <div class="text-xs text-muted">${esc(sess.consulta.Observacoes || 'Sessão individual')}</div></div></li>
      </ol>
    </section>`;
  }

  function renderSessao(user) {
    const box = $('#pr-sessao');
    if (!box) return;
    if (state.editando && $('#rc-form')) return; // não perde texto em edição se outra janela alterar o banco
    const sess = service.sessao(P.db, user, state.consulta);
    const c = sess.consulta;
    const fim = new Date(new Date(c.DataHora).getTime() + (parseInt(c.Duracao, 10) || 60) * 6e4);
    box.innerHTML = `
      <div class="pr-sessao-bar">
        <div>
          <div class="eyebrow">${sess.numero ? `Sessão #${sess.numero}` : 'Sessão'}${util.isoDate(c.DataHora) === util.isoDate() ? ' · hoje' : ''}</div>
          <div class="fw-800">${util.capitalize(util.fmtDateLong(c.DataHora))} de ${new Date(c.DataHora).getFullYear()}</div>
          <div class="text-xs text-2">${util.fmtTime(c.DataHora)}–${util.fmtTime(fim)} · ${c.Duracao} · ${c.Modalidade} · consulta #${c.ID_Consulta}</div>
        </div>
        ${ui.statusBadge(c.Status)}
      </div>
      <div class="pr-grid">
        <div class="pr-col">${cardRegistro(sess)}</div>
        <div class="pr-col">${cardAnexos(sess)}${cardHistorico(sess)}</div>
      </div>`;
    bindDrop();
    // Auditoria de leitura do prontuário (uma vez por sessão aberta)
    if (state.auditado !== state.consulta) {
      state.auditado = state.consulta;
      core.audit(P.db, user, 'VISUALIZAR_PRONTUARIO', `Sessão da consulta ${c.ID_Consulta} (${P.q.pacienteNome(c.CPF_Paciente)})`, true);
      P.persist();
    }
  }

  function bindDrop() {
    const dz = $('#pr-drop'); if (!dz) return;
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) enviarArquivos(Array.from(e.dataTransfer.files)); });
    $('#pr-file').addEventListener('change', (e) => { const f = Array.from(e.target.files); e.target.value = ''; if (f.length) enviarArquivos(f); });
  }

  function render() {
    const user = P.currentUser();
    renderPacientes(user);
    const p = state.cpf ? P.q.paciente(state.cpf) : null;
    if (!p || !['ATIVO', 'INATIVO'].includes(p.Status)) { state.cpf = null; state.consulta = null; syncUrl(); renderVazio(); return; }

    const sessoes = service.sessoesPaciente(P.db, user, p.CPF);
    if (!sessoes.some((s) => s.ID_Consulta === state.consulta)) {
      const atual = sessoes.find((s) => s.Atual);
      state.consulta = (atual || sessoes[sessoes.length - 1] || {}).ID_Consulta || null;
      state.editando = false;
    }
    syncUrl();

    const main = $('#pr-main');
    const emEdicao = state.editando && $('#rc-form');
    if (emEdicao) { // atualiza só a navbar/cabeçalho, preservando o formulário
      const nav = $('.session-nav-wrap'); if (nav) nav.outerHTML = subNavbar(sessoes);
      return;
    }
    main.innerHTML = cabecalhoPaciente(p, sessoes) + (sessoes.length
      ? `${subNavbar(sessoes)}<div id="pr-sessao" role="tabpanel" aria-labelledby="tab-${state.consulta}"></div>`
      : `<div class="card mt-16">${ui.empty('calendar', 'Nenhuma sessão até hoje', 'As sessões aparecem aqui a partir da data da consulta.')}</div>`);
    if (sessoes.length) {
      renderSessao(user);
      const ativa = $(`#tab-${state.consulta}`);
      if (ativa) ativa.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }

  function selecionarSessao(id) {
    if (state.editando && $('#rc-form') && !window.confirm('Descartar alterações não salvas da anotação?')) return;
    state.consulta = Number(id); state.editando = false;
    render();
    const t = $(`#tab-${id}`); if (t) t.focus({ preventScroll: true });
  }

  P.page({
    roles: ['psicologo'],
    deniedMessage: 'Registros clínicos e anotações de sessão são sigilosos e de acesso exclusivo da psicóloga responsável (Código de Ética do Psicólogo e LGPD).',
    init() {
      $('#pr-busca').addEventListener('input', util.debounce((e) => { state.busca = e.target.value; renderPacientes(P.currentUser()); }, 150));
      $('#pr-pacientes').addEventListener('click', (e) => {
        const b = e.target.closest('[data-cpf]'); if (!b) return;
        if (state.editando && $('#rc-form') && !window.confirm('Descartar alterações não salvas da anotação?')) return;
        state.cpf = b.dataset.cpf; state.consulta = null; state.editando = false;
        render();
        if (window.innerWidth < 1024) $('#pr-main').scrollIntoView({ behavior: 'smooth' });
      });

      const main = $('#pr-main');
      main.addEventListener('click', (e) => {
        const t = e.target.closest('[data-sessao]'); if (t) { selecionarSessao(t.dataset.sessao); return; }
        const sc = e.target.closest('[data-scroll]'); if (sc) { $('#session-nav').scrollBy({ left: Number(sc.dataset.scroll) * 280, behavior: 'smooth' }); return; }
        const user = P.currentUser();
        const cr = e.target.closest('[data-criar]');
        if (cr) {
          const c = P.q.consulta(state.consulta);
          act(() => service.criar(P.db, user, { cpf: c.CPF_Paciente, idConsulta: c.ID_Consulta, usarModelo: cr.dataset.criar === 'modelo' }), 'Anotação criada.');
          state.editando = true; render(); return;
        }
        if (e.target.closest('[data-edit]')) { state.editando = true; renderSessao(user); return; }
        if (e.target.closest('[data-cancel]')) { state.editando = false; renderSessao(user); return; }
        if (e.target.closest('[data-modelo]')) {
          const f = $('#rc-form');
          Object.entries(MODELO_TCC).forEach(([k, v]) => { const el = f.elements[k]; if (el) el.value = el.value.trim() ? `${el.value}\n${v}` : v; });
          ui.toast('Modelo TCC inserido.', 'info'); return;
        }
        if (e.target.closest('[data-nova-nota]')) { abrirNovaNota(); return; }
        const ed = e.target.closest('[data-editar-anexo]'); if (ed) { abrirEditorTexto(Number(ed.dataset.editarAnexo)); return; }
        const bx = e.target.closest('[data-baixar]'); if (bx) { baixar(Number(bx.dataset.baixar)); return; }
        const vp = e.target.closest('[data-ver-pdf]'); if (vp) { visualizarPdf(Number(vp.dataset.verPdf)); return; }
        const sb = e.target.closest('[data-substituir]'); if (sb) { substituirArquivo(Number(sb.dataset.substituir)); return; }
        const rm = e.target.closest('[data-remover]'); if (rm) { removerArquivo(Number(rm.dataset.remover)); }
      });
      // Navegação por teclado na sub-navbar (setas / Home / End)
      main.addEventListener('keydown', (e) => {
        const tab = e.target.closest('.session-tab'); if (!tab) return;
        const tabs = util.$$('.session-tab'); const i = tabs.indexOf(tab);
        const alvo = { ArrowRight: tabs[i + 1], ArrowLeft: tabs[i - 1], Home: tabs[0], End: tabs[tabs.length - 1] }[e.key];
        if (alvo) { e.preventDefault(); selecionarSessao(alvo.dataset.sessao); }
      });
      main.addEventListener('submit', (e) => {
        if (e.target.id !== 'rc-form') return;
        e.preventDefault();
        const d = util.formData(e.target);
        const r = P.db.registrosClinicos.find((x) => x.ID_Consulta === state.consulta);
        state.editando = false;
        act(() => service.atualizar(P.db, P.currentUser(), r.ID_RC, {
          QueixaPrincipal: d.QueixaPrincipal, IntervencoesRealizadas: d.IntervencoesRealizadas, ProgressoObservado: d.ProgressoObservado,
          TarefasParaCasa: d.TarefasParaCasa, ProximaSessao: d.ProximaSessao, DuracaoMin: Number(d.DuracaoMin) || 50,
          Tags: String(d.Tags || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
        }), 'Anotação salva (DataUltMod atualizada).');
      });
    },
    render,
  });
})(window.PRISMA);
