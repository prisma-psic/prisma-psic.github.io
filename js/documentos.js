/* =========================================================================
   PRISMA — documentos.js
   Service (gestão de arquivos + emissão de laudos/atestados) + controlador
   da página Documentos.

   Regras:
     • CHK_Origem_Documento .... 'Paciente' | 'Psicóloga' | 'Sistema'
     • LGPD .................... paciente só vê/envia documentos próprios
     • Google Drive API v3 ..... armazenamento em nuvem simulado; se estiver
                                 indisponível, o arquivo cai no "Local Fallback"
                                 e pode ser sincronizado depois (risco R01 / CT01)
     • Laudo_Atestado .......... emitido somente pela psicóloga e vinculado a
                                 uma consulta REALIZADA (FK_Laudo_Consulta)
   ========================================================================= */
(function (P) {
  'use strict';
  const { util, core } = P;
  const { RuleError } = core;

  const TIPOS = ['Administrativo', 'Avaliações', 'Relatórios', 'Testes', 'Tratamento', 'Laudos e Atestados'];
  const LIMITE_MB = 25;
  const LIMITE_CONTEUDO_LOCAL_KB = 400; // arquivos maiores guardam só metadados (limite do localStorage)

  /* =====================================================================
     SERVICE
     ===================================================================== */
  const service = {
    TIPOS, LIMITE_MB,

    listar(db, user, { cpf = null, tipo = null, busca = '' } = {}) {
      let list = db.documentos.slice();
      if (user.tipo === 'paciente') list = list.filter((d) => d.CPF_Paciente === user.id);
      else if (cpf) list = list.filter((d) => d.CPF_Paciente === cpf);
      if (tipo) list = list.filter((d) => d.Tipo === tipo);
      if (busca) {
        const q = util.normalize(busca);
        list = list.filter((d) => util.normalize(`${d.NomeArquivo} ${d.Tipo} ${d.Conteudo} ${P.q.pacienteNome(d.CPF_Paciente, db)}`).includes(q));
      }
      return list.sort((a, b) => (b.DataEnvio > a.DataEnvio ? 1 : b.DataEnvio < a.DataEnvio ? -1 : b.ID_Doc - a.ID_Doc));
    },

    obter(db, user, id) {
      const d = db.documentos.find((x) => x.ID_Doc === Number(id));
      if (!d) throw new RuleError('Documento não encontrado.', 'FK');
      if (user.tipo === 'paciente' && d.CPF_Paciente !== user.id) {
        core.audit(db, user, 'ACESSO_NEGADO_LGPD', `Tentativa de acesso ao documento ${id} de outro paciente`, false);
        throw new RuleError('Acesso negado: documento de outro paciente.', 'LGPD');
      }
      return d;
    },

    setDriveOnline(db, user, online) {
      db.config.driveOnline = !!online;
      core.audit(db, user, 'DRIVE_STATUS', `Google Drive API ${online ? 'online' : 'indisponível (fallback local ativo)'}`, true);
    },

    /** Upload com Google Drive API v3 e fallback local. */
    upload(db, user, { cpf, tipo, nomeArquivo, tamanhoKb = 0, mime = 'application/octet-stream', base64 = null, idConsulta = null, descricao = '' }) {
      const origem = user.tipo === 'psicologo' ? 'Psicóloga' : 'Paciente';
      const cpfFinal = user.tipo === 'paciente' ? user.id : cpf;
      if (!['Paciente', 'Psicóloga', 'Sistema'].includes(origem)) throw new RuleError('Origem inválida (CHK_Origem_Documento).', 'CHK_Origem_Documento');
      if (!cpfFinal || !P.q.pacientesAtivos(db).some((p) => p.CPF === cpfFinal)) throw new RuleError('Selecione o paciente vinculado ao documento.', 'FK_Documentos_Paciente');
      if (!TIPOS.includes(tipo)) throw new RuleError('Tipo de documento inválido.', 'Tipo');
      if (!nomeArquivo) throw new RuleError('Informe o arquivo ou o título do documento.', 'NOT NULL');
      if (tamanhoKb > LIMITE_MB * 1024) throw new RuleError(`O arquivo excede o limite de ${LIMITE_MB} MB.`, 'Tamanho');
      if (idConsulta) {
        const c = P.q.consulta(idConsulta, db);
        if (!c || c.CPF_Paciente !== cpfFinal) throw new RuleError('A consulta vinculada não pertence a este paciente.', 'FK_Documentos_Consulta');
      }

      const id = P.nextId('documento', db);
      const online = db.config.driveOnline;
      const doc = {
        ID_Doc: id, Tipo: tipo, Origem: origem,
        Conteudo: descricao || `Arquivo enviado por ${user.nome}.`,
        DataEnvio: util.isoDate(), CPF_Paciente: cpfFinal, CRP_Psicologo: db.psicologo.CRP,
        ID_Consulta: idConsulta ? Number(idConsulta) : null,
        NomeArquivo: nomeArquivo, TamanhoKb: Math.max(1, Math.round(tamanhoKb)), MimeType: mime,
        ConteudoBase64: base64 && tamanhoKb <= LIMITE_CONTEUDO_LOCAL_KB ? base64 : null,
        Armazenamento: online ? 'Google Drive API v3' : 'Local Fallback',
        DriveFileId: online ? `gdrive_${id}_${Date.now().toString(36)}` : null,
      };
      if (online) db.config.driveUploads++; else db.config.localFallbacks++;
      db.documentos.unshift(doc);

      if (user.tipo === 'paciente') core.notify(db, db.psicologo.CRP, 'Novo documento do paciente', `${user.nome} enviou "${nomeArquivo}".`, 'documento');
      else core.notify(db, cpfFinal, 'Novo documento disponível', `${db.psicologo.Nome} compartilhou "${nomeArquivo}".`, 'documento');
      core.audit(db, user, online ? 'UPLOAD_DRIVE' : 'UPLOAD_FALLBACK_LOCAL', `Documento ${id} (${nomeArquivo}) → ${doc.Armazenamento}`, true);
      return doc;
    },

    /** Contingência do R01: reprocessa os arquivos que ficaram no fallback local. */
    sincronizarFallback(db, user) {
      if (!db.config.driveOnline) throw new RuleError('O Google Drive continua indisponível. Tente novamente mais tarde.', 'R01');
      const pend = db.documentos.filter((d) => d.Armazenamento === 'Local Fallback');
      pend.forEach((d) => { d.Armazenamento = 'Google Drive API v3'; d.DriveFileId = `gdrive_${d.ID_Doc}_${Date.now().toString(36)}`; });
      core.audit(db, user, 'SINCRONIZAR_DRIVE', `${pend.length} arquivo(s) sincronizado(s) com o Google Drive`, true);
      return pend.length;
    },

    excluir(db, user, id) {
      const d = service.obter(db, user, id);
      if (user.tipo === 'paciente' && d.Origem !== 'Paciente') throw new RuleError('Você só pode excluir documentos enviados por você.', 'RBAC');
      db.documentos = db.documentos.filter((x) => x.ID_Doc !== d.ID_Doc);
      core.audit(db, user, 'EXCLUIR_DOCUMENTO', `Documento ${d.ID_Doc} (${d.NomeArquivo}) excluído`, true);
    },

    /* ---------- Laudos e atestados ---------- */
    listarLaudos(db, user) {
      const list = user.tipo === 'paciente' ? db.laudosAtestados.filter((l) => l.CPF_Paciente === user.id) : db.laudosAtestados.slice();
      return list.sort((a, b) => (b.DataEmissao > a.DataEmissao ? 1 : -1));
    },

    consultasElegiveis(db, cpf = null) {
      return db.consultas
        .filter((c) => c.Status === 'Realizada' && (!cpf || c.CPF_Paciente === cpf))
        .sort((a, b) => new Date(b.DataHora) - new Date(a.DataHora));
    },

    modelo(db, tipo, consulta) {
      if (!consulta) return '';
      const pac = P.q.paciente(consulta.CPF_Paciente, db);
      const ini = new Date(consulta.DataHora);
      const fim = new Date(ini.getTime() + (parseInt(consulta.Duracao, 10) || 60) * 6e4);
      if (tipo === 'Atestado') {
        return `Declaro, para os devidos fins, que ${pac.Nome} compareceu a atendimento psicológico no dia ${util.fmtDate(ini)}, no período das ${util.fmtTime(ini)} às ${util.fmtTime(fim)}, na modalidade ${consulta.Modalidade.toLowerCase()}.`;
      }
      return [
        `1. IDENTIFICAÇÃO\nInteressado(a): ${pac.Nome}\nSolicitante: o(a) próprio(a) paciente\nFinalidade: [descrever]`,
        `2. DESCRIÇÃO DA DEMANDA\n${pac.QueixaPrincipal || '[descrever a demanda]'}.`,
        `3. PROCEDIMENTO\nAtendimentos em psicoterapia na abordagem ${db.psicologo.Abordagem}, entrevistas clínicas e instrumentos de rastreio.`,
        '4. ANÁLISE\n[Descrever a análise dos dados obtidos.]',
        '5. CONCLUSÃO\n[Descrever a conclusão.]',
      ].join('\n\n');
    },

    emitirLaudo(db, user, { tipo, titulo, conteudo, idConsulta }) {
      if (user.tipo !== 'psicologo') throw new RuleError('Apenas a psicóloga pode emitir laudos e atestados.', 'RBAC');
      if (!['Laudo', 'Atestado'].includes(tipo)) throw new RuleError("Tipo deve ser 'Laudo' ou 'Atestado'.", 'CHK_Tipo_Laudo');
      const c = P.q.consulta(idConsulta, db);
      if (!c) throw new RuleError('Selecione a consulta relacionada (FK_Laudo_Consulta).', 'FK_Laudo_Consulta');
      if (c.Status !== 'Realizada') throw new RuleError('Laudos e atestados só podem ser emitidos para consultas realizadas.', 'FK_Laudo_Consulta');
      if (!titulo || !conteudo) throw new RuleError('Título e conteúdo são obrigatórios.', 'NOT NULL');

      const la = {
        ID_LA: P.nextId('laudo', db), Tipo: tipo, Titulo: titulo, Conteudo: conteudo, DataEmissao: util.isoDate(),
        ID_Consulta: c.ID_Consulta, CPF_Paciente: c.CPF_Paciente, CRP_Psicologo: db.psicologo.CRP,
      };
      db.laudosAtestados.push(la);
      // Também é arquivado no repositório (Drive ou fallback)
      service.upload(db, user, {
        cpf: c.CPF_Paciente, tipo: 'Laudos e Atestados', nomeArquivo: `${titulo}.pdf`, tamanhoKb: Math.round(conteudo.length / 3) + 60,
        mime: 'application/pdf', idConsulta: c.ID_Consulta, descricao: `${tipo} emitido em ${util.fmtDate(la.DataEmissao)} (ID_LA ${la.ID_LA}).`,
      });
      core.audit(db, user, 'EMISSAO_LAUDO_ATESTADO', `${tipo} ${la.ID_LA} emitido para a consulta ${c.ID_Consulta}`, true);
      return la;
    },

    /** Gera o HTML imprimível (→ "Salvar como PDF" no navegador). */
    htmlImprimivel(db, la) {
      const pac = P.q.paciente(la.CPF_Paciente, db) || { Nome: 'Paciente' };
      const ps = db.psicologo;
      const e = util.esc;
      return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${e(la.Titulo)}</title>
<style>
  @page { size: A4; margin: 22mm 20mm; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; font-size: 12pt; line-height: 1.6; max-width: 720px; margin: 24px auto; padding: 0 16px; }
  header { display:flex; justify-content:space-between; align-items:flex-end; border-bottom: 2px solid #6366f1; padding-bottom: 10px; margin-bottom: 28px; }
  .brand { font-family: Arial, sans-serif; font-weight: 800; letter-spacing: .08em; color: #6366f1; }
  .ps { font-family: Arial, sans-serif; font-size: 9.5pt; text-align: right; color: #444; }
  h1 { text-align: center; font-size: 15pt; letter-spacing: .06em; text-transform: uppercase; margin: 0 0 24px; }
  .content { white-space: pre-wrap; text-align: justify; }
  .sign { margin-top: 72px; text-align: center; }
  .sign .line { width: 280px; border-top: 1px solid #111; margin: 0 auto 6px; }
  footer { margin-top: 48px; font-family: Arial, sans-serif; font-size: 8.5pt; color: #666; border-top: 1px solid #ddd; padding-top: 8px; }
  .noprint { font-family: Arial, sans-serif; text-align: center; margin-bottom: 18px; }
  .noprint button { padding: 8px 16px; border-radius: 8px; border: 0; background: #111; color: #fff; font-weight: 600; cursor: pointer; }
  @media print { .noprint { display: none; } body { margin: 0; } }
</style></head><body>
<div class="noprint"><button onclick="window.print()">Imprimir / Salvar como PDF</button></div>
<header><div class="brand">PRISMA</div><div class="ps">${e(ps.Nome)} — Psicóloga<br>CRP ${e(ps.CRP)} · ${e(ps.Email)}<br>${e(ps.Consultorio || '')}</div></header>
<h1>${e(la.Tipo === 'Laudo' ? 'Laudo Psicológico' : 'Atestado Psicológico')}</h1>
<p><strong>${e(la.Titulo)}</strong><br>Paciente: ${e(pac.Nome)} · Consulta nº ${la.ID_Consulta}</p>
<div class="content">${e(la.Conteudo)}</div>
<p style="margin-top:32px">Santana do Itararé/PR, ${e(util.fmtDateFull(la.DataEmissao))}.</p>
<div class="sign"><div class="line"></div>${e(ps.Nome)}<br>Psicóloga · CRP ${e(ps.CRP)}</div>
<footer>Documento emitido pela plataforma PRISMA · ID_LA ${la.ID_LA} · Uso restrito ao interessado (Resolução CFP nº 06/2019 e LGPD).</footer>
</body></html>`;
    },
  };
  P.services.documentos = service;

  /* =====================================================================
     CONTROLADOR DA PÁGINA
     ===================================================================== */
  if (document.body.dataset.page !== 'documentos') return;

  const { $, esc } = util;
  const ui = P.ui;
  const state = { tipo: null, busca: '', cpf: '', aba: 'docs' };

  function act(fn, ok) {
    try { const r = fn(); P.save('documentos'); if (ok) ui.toast(ok, 'success'); return r; }
    catch (e) { P.save('documentos'); ui.toast(e.message, 'error'); return null; }
  }

  const readFile = (file) => new Promise((resolve) => {
    if (file.size / 1024 > LIMITE_CONTEUDO_LOCAL_KB) { resolve(null); return; }
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });

  function guessTipo(name) {
    const n = util.normalize(name);
    if (/laudo|atestado/.test(n)) return 'Laudos e Atestados';
    if (/teste|inventario|escala|bai|bdi|phq|gad/.test(n)) return 'Testes';
    if (/relatorio/.test(n)) return 'Relatórios';
    if (/avaliacao|anamnese/.test(n)) return 'Avaliações';
    if (/plano|tratamento/.test(n)) return 'Tratamento';
    return 'Administrativo';
  }

  function consultaOptions(cpf) {
    const list = P.db.consultas.filter((c) => c.CPF_Paciente === cpf && ['Realizada', 'Agendada'].includes(c.Status)).sort((a, b) => new Date(b.DataHora) - new Date(a.DataHora));
    return `<option value="">— Nenhuma —</option>${list.map((c) => `<option value="${c.ID_Consulta}">#${c.ID_Consulta} · ${util.fmtDateTime(c.DataHora)} · ${c.Status}</option>`).join('')}`;
  }

  function openUpload(file = null) {
    const user = P.currentUser();
    const db = P.db;
    const cpf0 = user.tipo === 'paciente' ? user.id : (state.cpf || P.q.pacientesAtivos(db)[0].CPF);
    ui.formModal({
      title: 'Enviar documento',
      subtitle: db.config.driveOnline ? 'Será armazenado via Google Drive API v3.' : 'Google Drive indisponível: o arquivo ficará no armazenamento local e será sincronizado depois.',
      submitLabel: 'Enviar', submitIcon: 'upload',
      body: `<div class="form-grid">
        <div class="field full"><label>Arquivo</label>
          <label class="file-pick"><input type="file" name="arquivo" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.txt"><span data-file-label>${file ? esc(file.name) : 'Selecionar arquivo (PDF, DOCX, imagens — até 25 MB)'}</span></label>
        </div>
        <div class="field full"><label>Título do documento *</label><input class="input" name="nome" required data-label="Título" value="${file ? esc(file.name) : ''}" placeholder="Ex.: Termo de consentimento.pdf"></div>
        ${user.tipo === 'psicologo' ? `<div class="field"><label>Paciente vinculado *</label><select class="select" name="cpf" required>${P.q.pacientesAtivos(db).map((p) => `<option value="${esc(p.CPF)}" ${p.CPF === cpf0 ? 'selected' : ''}>${esc(p.Nome)}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label>Tipo de documento</label><select class="select" name="tipo">${TIPOS.map((t) => `<option ${file && guessTipo(file.name) === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field ${user.tipo === 'psicologo' ? 'full' : ''}"><label>Consulta vinculada</label><select class="select" name="idConsulta" data-consultas>${consultaOptions(cpf0)}</select></div>
        <div class="field full"><label>Descrição</label><textarea class="textarea" name="descricao" rows="3" maxlength="500" placeholder="Opcional"></textarea></div>
      </div>`,
      onOpen(el) {
        let current = file;
        el._file = () => current;
        const input = el.querySelector('[name=arquivo]');
        input.addEventListener('change', () => {
          current = input.files[0] || null;
          el.querySelector('[data-file-label]').textContent = current ? `${current.name} · ${util.fmtSize(current.size / 1024)}` : 'Selecionar arquivo';
          if (current) { el.querySelector('[name=nome]').value = current.name; el.querySelector('[name=tipo]').value = guessTipo(current.name); }
        });
        const sel = el.querySelector('[name=cpf]');
        if (sel) sel.addEventListener('change', () => { el.querySelector('[data-consultas]').innerHTML = consultaOptions(sel.value); });
      },
      onSubmit(d, form, el) {
        const f = el._file();
        const doUpload = (base64) => {
          const doc = service.upload(P.db, P.currentUser(), {
            cpf: d.cpf, tipo: d.tipo, nomeArquivo: d.nome, tamanhoKb: f ? f.size / 1024 : Math.max(1, d.nome.length / 10),
            mime: f ? f.type || 'application/octet-stream' : 'text/plain', base64, idConsulta: d.idConsulta || null, descricao: d.descricao,
          });
          P.save('documentos');
          ui.toast(doc.Armazenamento === 'Local Fallback' ? 'Drive indisponível: salvo no armazenamento local (fallback).' : 'Documento enviado ao Google Drive.', doc.Armazenamento === 'Local Fallback' ? 'warning' : 'success');
        };
        if (f && f.size / 1024 > LIMITE_MB * 1024) throw new Error(`O arquivo excede o limite de ${LIMITE_MB} MB.`);
        if (f) { readFile(f).then(doUpload).catch((e) => ui.toast(e.message, 'error')); return true; }
        doUpload(null);
        return true;
      },
    });
  }

  function openEmitir() {
    const db = P.db;
    const elegiveis = service.consultasElegiveis(db);
    if (!elegiveis.length) { ui.toast('Não há consultas realizadas para vincular um laudo ou atestado.', 'warning'); return; }
    ui.formModal({
      title: 'Emitir laudo ou atestado', subtitle: 'Vinculado a uma consulta realizada (FK_Laudo_Consulta). Gera PDF para impressão.',
      submitLabel: 'Emitir documento', submitIcon: 'file-plus', size: 'lg',
      body: `<div class="form-grid">
        <div class="field"><label>Tipo *</label><div class="seg-docs">
          <label><input type="radio" name="tipo" value="Atestado" checked><span>Atestado</span></label>
          <label><input type="radio" name="tipo" value="Laudo"><span>Laudo</span></label></div></div>
        <div class="field"><label>Consulta realizada *</label><select class="select" name="idConsulta" required data-label="Consulta">${elegiveis.map((c) => `<option value="${c.ID_Consulta}">${esc(P.q.pacienteNome(c.CPF_Paciente))} · ${util.fmtDate(c.DataHora)} (#${c.ID_Consulta})</option>`).join('')}</select></div>
        <div class="field full"><label>Título *</label><input class="input" name="titulo" required data-label="Título" maxlength="150"></div>
        <div class="field full"><label>Conteúdo *</label><textarea class="textarea mono-area" name="conteudo" rows="12" required data-label="Conteúdo"></textarea><span class="hint">Estrutura do laudo baseada na Resolução CFP nº 06/2019. Revise antes de emitir.</span></div>
      </div>`,
      onOpen(el) {
        const fill = () => {
          const tipo = el.querySelector('[name=tipo]:checked').value;
          const c = P.q.consulta(el.querySelector('[name=idConsulta]').value);
          el.querySelector('[name=titulo]').value = `${tipo === 'Atestado' ? 'Atestado de Comparecimento' : 'Laudo Psicológico'} — ${P.q.pacienteNome(c.CPF_Paciente)}`;
          el.querySelector('[name=conteudo]').value = service.modelo(P.db, tipo, c);
        };
        el.querySelectorAll('[name=tipo]').forEach((r) => r.addEventListener('change', fill));
        el.querySelector('[name=idConsulta]').addEventListener('change', fill);
        fill();
      },
      onSubmit(d) {
        const la = service.emitirLaudo(P.db, P.currentUser(), { tipo: d.tipo, titulo: d.titulo, conteudo: d.conteudo, idConsulta: d.idConsulta });
        P.save('documentos');
        ui.toast(`${la.Tipo} emitido e arquivado.`, 'success');
        state.aba = 'laudos';
        printLaudo(la);
      },
    });
  }

  function printLaudo(la) {
    const w = window.open('', '_blank');
    if (!w) {
      ui.download(`${la.Titulo}.html`, service.htmlImprimivel(P.db, la), 'text/html;charset=utf-8');
      ui.toast('Pop-up bloqueado: o documento foi baixado em HTML. Abra-o e use "Imprimir → Salvar como PDF".', 'warning', 6000);
      return;
    }
    w.document.open(); w.document.write(service.htmlImprimivel(P.db, la)); w.document.close();
  }

  function viewDoc(id) {
    const user = P.currentUser();
    let d;
    try { d = service.obter(P.db, user, id); } catch (e) { P.save(); ui.toast(e.message, 'error'); return; }
    const c = d.ID_Consulta ? P.q.consulta(d.ID_Consulta) : null;
    const isImg = d.ConteudoBase64 && /^data:image\//.test(d.ConteudoBase64);
    ui.modal({
      title: d.NomeArquivo, subtitle: `${d.Tipo} · enviado em ${util.fmtDate(d.DataEnvio)}`, size: 'lg',
      body: `
        ${isImg ? `<img src="${d.ConteudoBase64}" alt="${esc(d.NomeArquivo)}" style="max-height:320px;margin:0 auto 16px;border-radius:12px">` : ''}
        <div class="doc-meta">
          <div><span>Paciente</span><strong>${esc(P.q.pacienteNome(d.CPF_Paciente))}</strong></div>
          <div><span>Origem do registro</span><strong>${esc(d.Origem)}</strong></div>
          <div><span>Responsável</span><strong>${esc(P.db.psicologo.Nome)} · CRP ${esc(d.CRP_Psicologo || '—')}</strong></div>
          <div><span>Consulta vinculada</span><strong>${c ? `#${c.ID_Consulta} · ${util.fmtDateTime(c.DataHora)}` : '—'}</strong></div>
          <div><span>Armazenamento</span><strong>${esc(d.Armazenamento)}</strong></div>
          <div><span>Identificador na nuvem</span><strong class="mono">${esc(d.DriveFileId || 'pendente de sincronização')}</strong></div>
          <div><span>Tamanho</span><strong>${util.fmtSize(d.TamanhoKb)}</strong></div>
          <div><span>ID_Doc</span><strong class="mono">${d.ID_Doc}</strong></div>
        </div>
        <div class="field mt-16"><span class="label">Descrição / conteúdo</span><p class="doc-content">${esc(d.Conteudo)}</p></div>
        <div class="alert alert-info mt-16">${P.icon('shield', 16)}<span>Arquivo auditado e protegido contra acessos não autorizados (LGPD). Cada visualização é registrada.</span></div>`,
      actions: [
        ...(user.tipo === 'psicologo' || d.Origem === 'Paciente' ? [{ label: 'Excluir', variant: 'btn-ghost', icon: 'trash', onClick: (close) => ui.confirm({ title: 'Excluir documento', message: `Excluir "${esc(d.NomeArquivo)}"? Esta ação não pode ser desfeita.`, confirmLabel: 'Excluir', variant: 'btn-danger', onConfirm: () => { close(); act(() => service.excluir(P.db, P.currentUser(), d.ID_Doc), 'Documento excluído.'); } }) }] : []),
        { label: 'Baixar', variant: 'btn-dark', icon: 'download', onClick: () => downloadDoc(d) },
      ],
    });
    core.audit(P.db, user, 'VISUALIZAR_DOCUMENTO', `Documento ${d.ID_Doc} visualizado`, true);
    P.persist();
  }

  function downloadDoc(d) {
    if (d.ConteudoBase64) {
      const a = document.createElement('a'); a.href = d.ConteudoBase64; a.download = d.NomeArquivo; document.body.appendChild(a); a.click(); a.remove();
    } else {
      const txt = `PRISMA — ${d.NomeArquivo}\n\nTipo: ${d.Tipo}\nPaciente: ${P.q.pacienteNome(d.CPF_Paciente)}\nOrigem: ${d.Origem}\nData de envio: ${util.fmtDate(d.DataEnvio)}\nArmazenamento: ${d.Armazenamento} (${d.DriveFileId || 'local'})\n\n${d.Conteudo}\n\n(Arquivo de demonstração: o conteúdo binário original não é mantido no navegador.)`;
      ui.download(d.NomeArquivo.replace(/\.[a-z0-9]+$/i, '') + '.txt', txt);
    }
    core.audit(P.db, P.currentUser(), 'DOWNLOAD_DOCUMENTO', `Documento ${d.ID_Doc} baixado`, true);
    P.persist();
  }

  function renderDrive(user) {
    const db = P.db;
    const on = db.config.driveOnline;
    const pend = db.documentos.filter((d) => d.Armazenamento === 'Local Fallback').length;
    $('#drive-card').innerHTML = `
      <div class="drive-ic ${on ? 'on' : 'off'}">${P.icon(on ? 'cloud' : 'cloud-off', 20)}</div>
      <div class="grow">
        <div class="fw-700">Google Drive API v3 · ${on ? 'conectado' : 'indisponível'}</div>
        <div class="text-xs text-muted">${on ? 'Novos arquivos vão direto para a nuvem.' : 'Fallback local ativo: os envios continuam funcionando.'} ${pend ? `· <strong class="text-warning">${pend} aguardando sincronização</strong>` : ''}</div>
      </div>
      ${pend && on ? `<button class="btn btn-outline btn-sm" id="btn-sync">${P.icon('refresh', 14)}Sincronizar</button>` : ''}
      ${user.tipo === 'psicologo' ? `<label class="row gap-6 text-xs fw-600" title="Simula queda da API (CT01)"><span class="hide-mobile">Simular queda</span><span class="switch"><input type="checkbox" id="drive-toggle" ${on ? '' : 'checked'}><span></span></span></label>` : ''}`;
    const t = $('#drive-toggle');
    if (t) t.onchange = () => act(() => service.setDriveOnline(P.db, P.currentUser(), !t.checked), t.checked ? 'Google Drive indisponível — fallback local ativado.' : 'Google Drive reconectado.');
    const s = $('#btn-sync');
    if (s) s.onclick = () => { const n = act(() => service.sincronizarFallback(P.db, P.currentUser())); if (n != null) ui.toast(`${n} arquivo(s) sincronizado(s).`, 'success'); };
  }

  const TIPO_COR = { Administrativo: 'neutral', 'Avaliações': 'info', 'Relatórios': 'violet', Testes: 'warning', Tratamento: 'success', 'Laudos e Atestados': 'danger' };

  function renderDocs(user) {
    const db = P.db;
    const base = service.listar(db, user, { cpf: state.cpf || null });
    const counts = {};
    base.forEach((d) => { counts[d.Tipo] = (counts[d.Tipo] || 0) + 1; });
    $('#doc-chips').innerHTML = `<button class="chip ${!state.tipo ? 'active' : ''}" data-tipo="">Todos <span class="count">${base.length}</span></button>`
      + TIPOS.map((t) => `<button class="chip ${state.tipo === t ? 'active' : ''}" data-tipo="${esc(t)}">${t} <span class="count">${counts[t] || 0}</span></button>`).join('');

    const list = service.listar(db, user, { cpf: state.cpf || null, tipo: state.tipo, busca: state.busca });
    $('#doc-count').textContent = `${list.length} documento${list.length === 1 ? '' : 's'}`;
    $('#doc-list').innerHTML = list.length ? list.map((d) => `
      <div class="doc-row" data-view="${d.ID_Doc}" tabindex="0" role="button" aria-label="Abrir ${esc(d.NomeArquivo)}">
        <div class="doc-ic tone-${TIPO_COR[d.Tipo] || 'neutral'}">${P.icon('file', 18)}</div>
        <div class="grow">
          <div class="fw-700 truncate">${esc(d.NomeArquivo)}</div>
          <div class="text-xs text-muted">${esc(d.Tipo)} · ${util.fmtDateShort(d.DataEnvio)} · ${util.fmtSize(d.TamanhoKb)}</div>
        </div>
        ${user.tipo === 'psicologo' ? `<div class="doc-patient hide-mobile">${ui.avatar(P.q.pacienteNome(d.CPF_Paciente), 'sm')}<span class="truncate">${esc(P.q.pacienteNome(d.CPF_Paciente))}</span></div>` : ''}
        <span class="badge ${d.Origem === 'Paciente' ? 'badge-violet' : d.Origem === 'Sistema' ? 'badge-neutral' : 'badge-info'} hide-mobile">${esc(d.Origem)}</span>
        <span class="store ${d.Armazenamento === 'Local Fallback' ? 'local' : ''}" title="${esc(d.Armazenamento)}">${P.icon(d.Armazenamento === 'Local Fallback' ? 'cloud-off' : 'cloud', 15)}</span>
        <button class="icon-btn sm" data-dl="${d.ID_Doc}" aria-label="Baixar">${P.icon('download', 16)}</button>
      </div>`).join('') : ui.empty('file', 'Nenhum documento encontrado', 'Ajuste a busca ou os filtros.');
  }

  function renderLaudos(user) {
    const list = service.listarLaudos(P.db, user);
    $('#laudo-count').textContent = `${list.length}`;
    $('#laudo-list').innerHTML = list.length ? list.map((l) => `
      <div class="doc-row">
        <div class="doc-ic tone-${l.Tipo === 'Laudo' ? 'violet' : 'success'}">${P.icon(l.Tipo === 'Laudo' ? 'award' : 'check-circle', 18)}</div>
        <div class="grow">
          <div class="fw-700 truncate">${esc(l.Titulo)}</div>
          <div class="text-xs text-muted">${esc(l.Tipo)} · emitido em ${util.fmtDate(l.DataEmissao)} · consulta #${l.ID_Consulta}${user.tipo === 'psicologo' ? ` · ${esc(P.q.pacienteNome(l.CPF_Paciente))}` : ''}</div>
        </div>
        <button class="btn btn-outline btn-sm" data-print="${l.ID_LA}">${P.icon('printer', 14)}<span class="hide-mobile">Gerar PDF</span></button>
      </div>`).join('') : ui.empty('award', 'Nenhum laudo ou atestado', user.tipo === 'psicologo' ? 'Emita um documento a partir de uma consulta realizada.' : 'Quando a psicóloga emitir um documento, ele aparecerá aqui.');
  }

  function render() {
    const user = P.currentUser();
    const db = P.db;
    $('#btn-emitir').hidden = user.tipo !== 'psicologo';
    const sel = $('#doc-paciente');
    sel.hidden = user.tipo !== 'psicologo';
    if (user.tipo === 'psicologo') {
      sel.innerHTML = `<option value="">Todos os pacientes</option>${P.q.pacientesAtivos(db).map((p) => `<option value="${esc(p.CPF)}" ${state.cpf === p.CPF ? 'selected' : ''}>${esc(p.Nome)}</option>`).join('')}`;
    } else state.cpf = '';
    $$tabs();
    renderDrive(user);
    renderDocs(user);
    renderLaudos(user);
  }

  function $$tabs() {
    util.$$('[data-aba]').forEach((b) => b.classList.toggle('active', b.dataset.aba === state.aba));
    $('#painel-docs').hidden = state.aba !== 'docs';
    $('#painel-laudos').hidden = state.aba !== 'laudos';
  }

  P.page({
    init() {
      $('#btn-upload').addEventListener('click', () => openUpload());
      $('#btn-emitir').addEventListener('click', openEmitir);
      $('#doc-busca').addEventListener('input', util.debounce((e) => { state.busca = e.target.value; renderDocs(P.currentUser()); }, 150));
      $('#doc-paciente').addEventListener('change', (e) => { state.cpf = e.target.value; render(); });
      $('#doc-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-tipo]'); if (!b) return; state.tipo = b.dataset.tipo || null; renderDocs(P.currentUser()); });
      util.$$('[data-aba]').forEach((b) => b.addEventListener('click', () => { state.aba = b.dataset.aba; $$tabs(); }));
      const list = $('#doc-list');
      list.addEventListener('click', (e) => {
        const dl = e.target.closest('[data-dl]');
        if (dl) { e.stopPropagation(); try { downloadDoc(service.obter(P.db, P.currentUser(), dl.dataset.dl)); } catch (err) { ui.toast(err.message, 'error'); } return; }
        const row = e.target.closest('[data-view]'); if (row) viewDoc(row.dataset.view);
      });
      list.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const row = e.target.closest('[data-view]'); if (row) viewDoc(row.dataset.view); } });
      $('#laudo-list').addEventListener('click', (e) => {
        const b = e.target.closest('[data-print]'); if (!b) return;
        const la = P.db.laudosAtestados.find((l) => l.ID_LA === Number(b.dataset.print));
        if (la) { core.audit(P.db, P.currentUser(), 'GERAR_PDF_LAUDO', `PDF do ${la.Tipo} ${la.ID_LA}`, true); P.save('documentos'); printLaudo(la); }
      });

      // Drag & drop
      const dz = $('#dropzone');
      ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
      dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) openUpload(f); });
      $('#dz-input').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openUpload(f); e.target.value = ''; });
    },
    render,
  });
})(window.PRISMA);
