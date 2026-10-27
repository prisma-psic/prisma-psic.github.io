/* =========================================================================
   PRISMA — auth.js
   Service de autenticação e aprovação de cadastros (PRISMA.services.auth).
   Usado por: pages/login.html (login e cadastro), index.html (painel de
   solicitações da psicóloga) e pages/configuracoes.html (cadastros e senha).

   Regras de negócio
     • Todo paciente que se cadastra começa com Status = 'PENDENTE_APROVACAO'
       e NÃO consegue entrar até ser aprovado por um(a) psicólogo(a) ativo(a).
     • Aprovar  → Status 'ATIVO', Data_Aprovacao = agora, CRP_Psicologo_Aprovador = CRP de quem aprovou.
     • Recusar  → Status 'REJEITADO' (o registro é mantido para auditoria/LGPD).
     • Inativar → Status 'INATIVO' (encerra o acesso; pode ser reativado).
     • Psicólogos já cadastrados no sistema estão ATIVOS. Um novo cadastro de
       profissional fica pendente até ser validado por um administrador
       (IsAdmin), para que ninguém obtenha acesso a prontuários sigilosos apenas
       se declarando psicólogo.
     • Unicidade de E-mail, CPF e CRP (espelha UQ_* do schema.sql).

   Senhas: guardadas como "sha256$<salt>$<hash>" (salt aleatório por conta).
   ATENÇÃO: é proteção de protótipo. No back-end, use bcrypt/argon2 no servidor.
   ========================================================================= */
(function (P) {
  'use strict';
  const { util, core } = P;
  const { RuleError } = core;

  const STATUS = { PENDENTE: 'PENDENTE_APROVACAO', ATIVO: 'ATIVO', REJEITADO: 'REJEITADO', INATIVO: 'INATIVO' };
  const MSG = {
    PENDENTE: 'Seu cadastro foi realizado com sucesso e está aguardando a aprovação do profissional de psicologia responsável.',
    PENDENTE_PROF: 'Seu cadastro profissional foi realizado com sucesso e está aguardando a validação do administrador da clínica.',
    REJEITADO: 'Seu cadastro não foi aprovado pelo profissional responsável. Em caso de dúvida, entre em contato com a clínica.',
    INATIVO: 'Esta conta está inativa. Entre em contato com a clínica para reativar o acesso.',
    CREDENCIAIS: 'E-mail ou senha incorretos.',
  };
  const MAX_TENTATIVAS = 5;
  const BLOQUEIO_MIN = 5;
  const TENTATIVAS_KEY = 'prisma:auth:tentativas';

  /* ---------- SHA-256 (Web Crypto, com implementação JS de reserva) ---------- */
  function sha256Js(ascii) {
    // Implementação compacta de SHA-256 (usada quando crypto.subtle não está disponível,
    // ex.: página aberta via http em rede local). Gera o mesmo resultado do Web Crypto.
    const bytes = new TextEncoder().encode(ascii);
    const K = [];
    const H = [];
    let n = 2, c = 0;
    const frac = (x) => ((x - Math.floor(x)) * 4294967296) | 0;
    outer: while (c < 64) {
      for (let d = 2; d * d <= n; d++) if (n % d === 0) { n++; continue outer; }
      if (c < 8) H[c] = frac(Math.pow(n, 1 / 2));
      K[c++] = frac(Math.pow(n, 1 / 3));
      n++;
    }
    const l = bytes.length * 8;
    const withPad = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    withPad.set(bytes); withPad[bytes.length] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 4, l >>> 0); dv.setUint32(withPad.length - 8, Math.floor(l / 4294967296));
    const w = new Array(64);
    const rot = (x, r) => (x >>> r) | (x << (32 - r));
    for (let i = 0; i < withPad.length; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
      for (let t = 16; t < 64; t++) {
        const s0 = rot(w[t - 15], 7) ^ rot(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rot(w[t - 2], 17) ^ rot(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let [a, b, cc, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & cc) ^ (b & cc))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = cc; cc = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + cc) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  async function sha256Hex(texto) {
    if (window.crypto && window.crypto.subtle && window.isSecureContext !== false) {
      try {
        const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch (e) { /* cai na implementação JS */ }
    }
    return sha256Js(texto);
  }

  function novoSalt() {
    const a = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function gerarHashSenha(senha, salt = novoSalt()) {
    return `sha256$${salt}$${await sha256Hex(salt + senha)}`;
  }

  async function verificarSenha(senha, armazenado) {
    if (!armazenado || !armazenado.startsWith('sha256$')) return false;
    const [, salt, hash] = armazenado.split('$');
    const calc = (await gerarHashSenha(senha, salt)).split('$')[2];
    // comparação em tempo constante
    let diff = calc.length ^ hash.length;
    for (let i = 0; i < Math.min(calc.length, hash.length); i++) diff |= calc.charCodeAt(i) ^ hash.charCodeAt(i);
    return diff === 0;
  }

  /* ---------- Validações (espelham as constraints do banco) ---------- */
  const digitos = (v = '') => String(v).replace(/\D/g, '');
  const valid = {
    email: (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim()),
    cpf(cpf) {
      const d = digitos(cpf);
      if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
      const dv = (len) => {
        let soma = 0;
        for (let i = 0; i < len; i++) soma += Number(d[i]) * (len + 1 - i);
        const r = (soma * 10) % 11;
        return r === 10 ? 0 : r;
      };
      return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
    },
    crp: (crp) => /^\d{2}\/\d{3,6}$/.test(String(crp || '').trim()),
    telefone: (t) => [10, 11].includes(digitos(t).length),
    senha: (s) => typeof s === 'string' && s.length >= 8 && /[A-Za-zÀ-ÿ]/.test(s) && /\d/.test(s),
    nascimento(d) {
      if (!d) return false;
      const dt = util.parseDate(d);
      const hoje = new Date();
      return dt <= hoje && dt.getFullYear() >= 1900;
    },
  };
  const mascaraCpf = (v) => {
    const d = digitos(v).slice(0, 11);
    if (d.length <= 3) return d;
    if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
    if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  };
  const mascaraTelefone = (v) => {
    const d = digitos(v).slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  };

  /* ---------- Contas ---------- */
  const psicologos = (db) => [db.psicologo, ...(db.equipe || [])];
  function contaPorEmail(db, email) {
    const e = String(email || '').trim().toLowerCase();
    const ps = psicologos(db).find((x) => x.Email.toLowerCase() === e);
    if (ps) return { role: 'psicologo', conta: ps, id: ps.CRP };
    const pa = db.pacientes.find((x) => x.Email.toLowerCase() === e);
    if (pa) return { role: 'paciente', conta: pa, id: pa.CPF };
    return null;
  }

  /** Verifica unicidade de e-mail, CPF e CRP entre pacientes e psicólogos. Retorna {campo: mensagem}. */
  function conflitos(db, { email, cpf, crp }, ignorar = null) {
    const erros = {};
    const e = String(email || '').trim().toLowerCase();
    const d = digitos(cpf);
    const todos = [...psicologos(db).map((x) => ({ ...x, _id: x.CRP })), ...db.pacientes.map((x) => ({ ...x, _id: x.CPF }))].filter((x) => x._id !== ignorar);
    if (e && todos.some((x) => x.Email.toLowerCase() === e)) erros.email = 'Este e-mail já está cadastrado.';
    if (d && todos.some((x) => x.CPF && digitos(x.CPF) === d)) erros.cpf = 'Este CPF já está cadastrado.';
    if (crp && psicologos(db).some((x) => x.CRP === String(crp).trim() && x.CRP !== ignorar)) erros.crp = 'Este CRP já está cadastrado.';
    return erros;
  }

  /* ---------- Controle de tentativas (mitigação de força bruta — R02) ---------- */
  const tentativas = {
    ler() { return P.storage.get(TENTATIVAS_KEY) || {}; },
    bloqueadoAte(email) { const t = tentativas.ler()[email]; return t && t.ate && t.ate > Date.now() ? t.ate : 0; },
    falha(email) {
      const all = tentativas.ler();
      const t = all[email] || { n: 0 };
      t.n += 1;
      if (t.n >= MAX_TENTATIVAS) { t.ate = Date.now() + BLOQUEIO_MIN * 6e4; t.n = 0; }
      all[email] = t; P.storage.set(TENTATIVAS_KEY, all);
      return t;
    },
    limpar(email) { const all = tentativas.ler(); delete all[email]; P.storage.set(TENTATIVAS_KEY, all); },
  };

  const sistema = { tipo: 'sistema', id: 'sistema', nome: 'Sistema' };
  const quem = (role, id, nome) => ({ tipo: role, id, nome });

  /* =====================================================================
     SERVICE
     ===================================================================== */
  const service = {
    STATUS, MSG, valid, mascaraCpf, mascaraTelefone, digitos, gerarHashSenha, verificarSenha, sha256Hex, sha256Js,

    /**
     * Login. Valida a senha ANTES de revelar o status (evita enumeração de contas).
     * Retorna { ok: true, role, id, nome } ou { ok: false, codigo, mensagem }.
     */
    async autenticar(db, email, senha) {
      const e = String(email || '').trim().toLowerCase();
      const ate = tentativas.bloqueadoAte(e);
      if (ate) {
        const min = Math.max(1, Math.ceil((ate - Date.now()) / 6e4));
        return { ok: false, codigo: 'BLOQUEADO', mensagem: `Muitas tentativas sem sucesso. Tente novamente em ${min} min.` };
      }
      const achado = contaPorEmail(db, e);
      const senhaOk = achado ? await verificarSenha(senha, achado.conta.SenhaHash) : (await sha256Hex('x' + senha), false);
      if (!achado || !senhaOk) {
        const t = tentativas.falha(e);
        core.audit(db, achado ? quem(achado.role, achado.id, achado.conta.Nome) : sistema, 'LOGIN_FALHA', `Tentativa de login sem sucesso (${e})`, false);
        P.persist();
        return { ok: false, codigo: 'CREDENCIAIS', mensagem: t.ate ? `Conta bloqueada por ${BLOQUEIO_MIN} min após ${MAX_TENTATIVAS} tentativas.` : MSG.CREDENCIAIS };
      }
      tentativas.limpar(e);
      const { role, conta, id } = achado;
      const u = quem(role, id, conta.Nome);
      if (conta.Status !== STATUS.ATIVO) {
        const codigo = conta.Status === STATUS.PENDENTE ? 'PENDENTE' : conta.Status === STATUS.REJEITADO ? 'REJEITADO' : 'INATIVO';
        core.audit(db, u, 'LOGIN_BLOQUEADO_STATUS', `Login recusado: cadastro com status ${conta.Status}`, false);
        P.persist();
        const mensagem = codigo === 'PENDENTE' ? (role === 'psicologo' ? MSG.PENDENTE_PROF : MSG.PENDENTE) : MSG[codigo];
        return { ok: false, codigo, mensagem, motivo: conta.MotivoRejeicao || null };
      }
      conta.UltimoLogin = new Date().toISOString();
      core.audit(db, u, role === 'psicologo' ? 'LOGIN_PSICOLOGO' : 'LOGIN_PACIENTE', `Login realizado por ${conta.Nome}`, true);
      P.persist();
      return { ok: true, role, id, nome: conta.Nome };
    },

    /** Cadastro público de paciente → PENDENTE_APROVACAO */
    async cadastrarPaciente(db, { nome, cpf, nascimento, email, telefone, senha, termos }) {
      const erros = service.validarCadastro(db, { tipo: 'paciente', nome, cpf, nascimento, email, telefone, senha, termos });
      if (Object.keys(erros).length) { const err = new RuleError('Verifique os campos destacados.', 'Cadastro'); err.campos = erros; throw err; }
      const agora = new Date().toISOString();
      const paciente = {
        CPF: mascaraCpf(cpf), Nome: nome.trim(), Email: email.trim().toLowerCase(), Telefone: mascaraTelefone(telefone),
        DataNascimento: nascimento, QueixaPrincipal: null, Tags: [],
        Status: STATUS.PENDENTE, Data_Solicitacao: agora, Data_Aprovacao: null, CRP_Psicologo_Aprovador: null,
        ConsentimentoLGPD: !!termos, DataConsentimento: termos ? agora : null,
        SenhaHash: await gerarHashSenha(senha),
      };
      db.pacientes.push(paciente);
      psicologos(db).filter((x) => x.Status === STATUS.ATIVO).forEach((ps) => {
        core.notify(db, ps.CRP, 'Nova solicitação de cadastro', `${paciente.Nome} se cadastrou e aguarda sua aprovação para acessar a plataforma.`, 'cadastro_pendente');
      });
      core.audit(db, quem('paciente', paciente.CPF, paciente.Nome), 'CADASTRO_PACIENTE', 'Cadastro criado com status PENDENTE_APROVACAO', true);
      return paciente;
    },

    /** Cadastro público de psicólogo → PENDENTE_APROVACAO (validação do administrador) */
    async cadastrarPsicologo(db, { nome, cpf, crp, especialidade, abordagem, email, telefone, senha, termos }) {
      const erros = service.validarCadastro(db, { tipo: 'psicologo', nome, cpf, crp, especialidade, abordagem, email, telefone, senha, termos });
      if (Object.keys(erros).length) { const err = new RuleError('Verifique os campos destacados.', 'Cadastro'); err.campos = erros; throw err; }
      const ps = {
        CRP: crp.trim(), Nome: nome.trim(), Especialidade: especialidade.trim(), Abordagem: abordagem.trim(),
        Email: email.trim().toLowerCase(), Telefone: mascaraTelefone(telefone), CPF: mascaraCpf(cpf), LimiteAlteracaoHoras: 24,
        Status: STATUS.PENDENTE, IsAdmin: false, Data_Solicitacao: new Date().toISOString(), Data_Aprovacao: null, CRP_Psicologo_Aprovador: null,
        SenhaHash: await gerarHashSenha(senha),
      };
      db.equipe = db.equipe || [];
      db.equipe.push(ps);
      psicologos(db).filter((x) => x.IsAdmin && x.Status === STATUS.ATIVO).forEach((adm) => {
        core.notify(db, adm.CRP, 'Novo cadastro profissional', `${ps.Nome} (CRP ${ps.CRP}) solicitou acesso como psicólogo(a).`, 'cadastro_pendente');
      });
      core.audit(db, quem('psicologo', ps.CRP, ps.Nome), 'CADASTRO_PSICOLOGO', 'Cadastro profissional aguardando validação do administrador', true);
      return ps;
    },

    /** Retorna {campo: mensagem} — vazio quando válido. */
    validarCadastro(db, d) {
      const erros = {};
      if (!d.nome || d.nome.trim().length < 3 || !/\s/.test(d.nome.trim())) erros.nome = 'Informe o nome completo.';
      if (!valid.cpf(d.cpf)) erros.cpf = 'CPF inválido. Confira os 11 dígitos.';
      if (d.tipo === 'psicologo') {
        if (!valid.crp(d.crp)) erros.crp = 'Informe o CRP no formato 08/12345.';
        if (!d.especialidade || d.especialidade.trim().length < 3) erros.especialidade = 'Informe sua especialidade.';
        if (!d.abordagem || d.abordagem.trim().length < 3) erros.abordagem = 'Informe sua abordagem terapêutica.';
      } else if (!d.nascimento) erros.nascimento = 'Informe a data de nascimento.';
      else if (!valid.nascimento(d.nascimento)) erros.nascimento = 'Data de nascimento inválida.';
      if (!valid.email(d.email)) erros.email = 'Informe um e-mail válido.';
      if (!valid.telefone(d.telefone)) erros.telefone = 'Informe um telefone com DDD.';
      if (!valid.senha(d.senha)) erros.senha = 'A senha precisa ter ao menos 8 caracteres, com letras e números.';
      if (d.confirmar !== undefined && d.senha !== d.confirmar) erros.confirmar = 'As senhas não coincidem.';
      if (!d.termos) erros.termos = 'É necessário aceitar os termos para continuar.';
      Object.assign(erros, Object.fromEntries(Object.entries(conflitos(db, d)).filter(([k]) => !erros[k])));
      return erros;
    },

    /* ---------- Aprovação (psicóloga) ---------- */
    pendentes(db, user) {
      if (!user || user.tipo !== 'psicologo') return { pacientes: [], profissionais: [] };
      const byData = (a, b) => (a.Data_Solicitacao > b.Data_Solicitacao ? 1 : -1);
      return {
        pacientes: db.pacientes.filter((p) => p.Status === STATUS.PENDENTE).sort(byData),
        profissionais: user.isAdmin ? (db.equipe || []).filter((x) => x.Status === STATUS.PENDENTE).sort(byData) : [],
      };
    },

    assertPsicologoAtivo(db, user) {
      const conta = user && user.tipo === 'psicologo' ? P.conta('psicologo', user.id, db) : null;
      if (!conta || conta.Status !== STATUS.ATIVO) {
        core.audit(db, user, 'APROVACAO_NEGADA', 'Tentativa de aprovar/recusar cadastro sem perfil de psicólogo ativo', false);
        throw new RuleError('Somente um(a) psicólogo(a) ativo(a) pode aprovar ou recusar cadastros.', 'RBAC');
      }
      return conta;
    },

    aprovarPaciente(db, user, cpf) {
      const ps = service.assertPsicologoAtivo(db, user);
      const p = P.q.paciente(cpf, db);
      if (!p) throw new RuleError('Paciente não encontrado.', 'FK');
      if (p.Status !== STATUS.PENDENTE) throw new RuleError('Este cadastro não está aguardando aprovação.', 'Status');
      Object.assign(p, { Status: STATUS.ATIVO, Data_Aprovacao: new Date().toISOString(), CRP_Psicologo_Aprovador: ps.CRP, MotivoRejeicao: null });
      core.notify(db, p.CPF, 'Cadastro aprovado 🎉', `Bem-vindo(a) ao PRISMA! Seu cadastro foi aprovado por ${ps.Nome}.`, 'cadastro_aprovado');
      core.audit(db, user, 'APROVAR_CADASTRO_PACIENTE', `Cadastro de ${p.Nome} (${p.CPF}) aprovado — status ATIVO`, true);
      return p;
    },

    recusarPaciente(db, user, cpf, motivo) {
      const ps = service.assertPsicologoAtivo(db, user);
      const p = P.q.paciente(cpf, db);
      if (!p) throw new RuleError('Paciente não encontrado.', 'FK');
      if (p.Status !== STATUS.PENDENTE) throw new RuleError('Este cadastro não está aguardando aprovação.', 'Status');
      Object.assign(p, { Status: STATUS.REJEITADO, Data_Aprovacao: null, CRP_Psicologo_Aprovador: ps.CRP, MotivoRejeicao: (motivo || '').trim() || null });
      core.audit(db, user, 'RECUSAR_CADASTRO_PACIENTE', `Cadastro de ${p.Nome} (${p.CPF}) recusado${motivo ? ` — ${motivo}` : ''}`, true);
      return p;
    },

    /** ATIVO ⇄ INATIVO; REJEITADO → ATIVO (reconsideração) */
    alterarStatusPaciente(db, user, cpf, novo) {
      const ps = service.assertPsicologoAtivo(db, user);
      const p = P.q.paciente(cpf, db);
      if (!p) throw new RuleError('Paciente não encontrado.', 'FK');
      const permitido = { ATIVO: ['INATIVO'], INATIVO: ['ATIVO'], REJEITADO: ['ATIVO'], PENDENTE_APROVACAO: ['ATIVO', 'REJEITADO'] }[p.Status] || [];
      if (!permitido.includes(novo)) throw new RuleError(`Transição de status inválida: ${p.Status} → ${novo}.`, 'CHK_Status_Paciente');
      if (novo === STATUS.ATIVO) Object.assign(p, { Data_Aprovacao: new Date().toISOString(), CRP_Psicologo_Aprovador: ps.CRP, MotivoRejeicao: null });
      const antes = p.Status;
      p.Status = novo;
      core.audit(db, user, 'ALTERAR_STATUS_PACIENTE', `${p.Nome}: ${antes} → ${novo}`, true);
      return p;
    },

    aprovarPsicologo(db, user, crp, aprovar = true, motivo = '') {
      const adm = service.assertPsicologoAtivo(db, user);
      if (!adm.IsAdmin) throw new RuleError('Somente o administrador da clínica valida cadastros profissionais.', 'RBAC');
      const ps = (db.equipe || []).find((x) => x.CRP === crp);
      if (!ps || ps.Status !== STATUS.PENDENTE) throw new RuleError('Cadastro profissional não encontrado ou já analisado.', 'Status');
      Object.assign(ps, aprovar
        ? { Status: STATUS.ATIVO, Data_Aprovacao: new Date().toISOString(), CRP_Psicologo_Aprovador: adm.CRP }
        : { Status: STATUS.REJEITADO, CRP_Psicologo_Aprovador: adm.CRP, MotivoRejeicao: motivo || null });
      core.audit(db, user, aprovar ? 'APROVAR_CADASTRO_PSICOLOGO' : 'RECUSAR_CADASTRO_PSICOLOGO', `${ps.Nome} (CRP ${ps.CRP})`, true);
      return ps;
    },

    async alterarSenha(db, user, atual, nova, confirmar) {
      const conta = P.conta(user.tipo, user.id, db);
      if (!conta) throw new RuleError('Conta não encontrada.', 'FK');
      if (!(await verificarSenha(atual, conta.SenhaHash))) {
        core.audit(db, user, 'ALTERAR_SENHA', 'Senha atual incorreta', false);
        throw new RuleError('A senha atual está incorreta.', 'Senha');
      }
      if (!valid.senha(nova)) throw new RuleError('A nova senha precisa ter ao menos 8 caracteres, com letras e números.', 'Senha');
      if (nova !== confirmar) throw new RuleError('As senhas não coincidem.', 'Senha');
      if (atual === nova) throw new RuleError('A nova senha deve ser diferente da atual.', 'Senha');
      conta.SenhaHash = await gerarHashSenha(nova);
      core.audit(db, user, 'ALTERAR_SENHA', 'Senha alterada', true);
    },
  };
  P.services.auth = service;
})(window.PRISMA);
