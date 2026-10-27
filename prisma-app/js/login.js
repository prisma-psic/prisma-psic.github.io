/* =========================================================================
   PRISMA — login.js
   Controlador da página de acesso (pages/login.html): login e cadastro.
   As regras ficam em auth.js (PRISMA.services.auth); aqui só há interface.

   Fluxo
     • Cadastro de paciente → status PENDENTE_APROVACAO → volta ao login com aviso.
     • Login de conta pendente/recusada/inativa → acesso negado com mensagem clara.
     • Login ATIVO → cria a sessão e segue para a página solicitada (ou Início).
   ========================================================================= */
(function (P) {
  'use strict';
  if (document.body.dataset.page !== 'login') return;

  const auth = P.services.auth;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const telaLogin = $('tela-login');
  const telaCadastro = $('tela-cadastro');
  const formLogin = $('form-login');
  const formCadastro = $('form-cadastro');
  const loginAviso = $('login-aviso');
  const cadastroAviso = $('cadastro-aviso');

  /** Destino após o login: somente páginas internas do próprio PRISMA */
  function destino() {
    const next = params.get('next') || '';
    const seguro = /^(index\.html|pages\/(agenda|metas|documentos|chat|anotacoes|testes|configuracoes)\.html)$/.test(next);
    return `../${seguro ? next : 'index.html'}`;
  }

  // Já autenticado? Vai direto para o sistema.
  if (P.currentUser()) { location.replace(destino()); return; }

  /* ---------- Mensagens ---------- */
  const ICON = { erro: 'x-circle', sucesso: 'check-circle', pendente: 'clock', info: 'info' };
  function mostrarAviso(el, mensagem, tipo, titulo) {
    el.className = `aviso ${tipo}`;
    el.innerHTML = `${P.icon(ICON[tipo] || 'info', 18)}<div>${titulo ? `<strong>${P.util.esc(titulo)}</strong>` : ''}${P.util.esc(mensagem)}</div>`;
    el.hidden = false;
  }
  function esconderAviso(el) { el.hidden = true; el.innerHTML = ''; }

  function marcarErro(idCampo, mensagem) {
    const campo = $(idCampo); const erro = $(`erro-${idCampo}`);
    if (campo) campo.setAttribute('aria-invalid', 'true');
    if (erro) erro.textContent = mensagem;
  }
  function limparErro(idCampo) {
    const campo = $(idCampo); const erro = $(`erro-${idCampo}`);
    if (campo) campo.removeAttribute('aria-invalid');
    if (erro) erro.textContent = '';
  }
  function limparErros(form) {
    form.querySelectorAll('.campo-erro').forEach((el) => { el.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  }

  /* ---------- Telas ---------- */
  function alternarTela(tela) {
    const cadastro = tela === 'cadastro';
    telaLogin.hidden = cadastro;
    telaCadastro.hidden = !cadastro;
    window.scrollTo(0, 0);
    (cadastro ? $('cad-nome') : $('login-email')).focus();
  }

  const tipoConta = () => (document.querySelector('input[name="tipo-conta"]:checked') || {}).value || 'paciente';
  function atualizarCamposPorTipo() {
    const psi = tipoConta() === 'psicologo';
    $('bloco-psicologo').hidden = !psi;
    $('bloco-nascimento').hidden = psi;
    $('label-tipo-paciente').classList.toggle('selecionado', !psi);
    $('label-tipo-psicologo').classList.toggle('selecionado', psi);
    $('nota-aprovacao-texto').textContent = psi
      ? 'Cadastros profissionais são validados pelo administrador da clínica (conferência do CRP) antes de liberar o acesso aos prontuários.'
      : 'Seu cadastro será analisado pela psicóloga responsável. O acesso é liberado após a aprovação.';
  }

  function forcaSenha(s) {
    let pts = 0;
    if (s.length >= 8) pts++;
    if (s.length >= 12) pts++;
    if (/[a-z]/.test(s) && /[A-Z]/.test(s)) pts++;
    if (/\d/.test(s)) pts++;
    if (/[^A-Za-z0-9]/.test(s)) pts++;
    const bar = $('forca-barra');
    const cores = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#16a34a'];
    bar.style.width = s ? `${Math.max(12, pts * 20)}%` : '0';
    bar.style.background = cores[Math.max(0, pts - 1)];
  }

  /* ---------- Login ---------- */
  async function handleLogin(event) {
    event.preventDefault();
    limparErros(formLogin);
    esconderAviso(loginAviso);
    const email = $('login-email').value.trim().toLowerCase();
    const senha = $('login-senha').value;
    const lembrar = $('lembrar-me').checked;

    let erro = false;
    if (!auth.valid.email(email)) { marcarErro('login-email', 'Informe um e-mail válido.'); erro = true; }
    if (!senha) { marcarErro('login-senha', 'Informe sua senha.'); erro = true; }
    if (erro) return;

    const btn = $('btn-entrar');
    btn.disabled = true; btn.textContent = 'Entrando…';
    try {
      const r = await auth.autenticar(P.db, email, senha);
      if (!r.ok) {
        if (r.codigo === 'PENDENTE') mostrarAviso(loginAviso, r.mensagem, 'pendente', 'Cadastro em análise');
        else if (r.codigo === 'REJEITADO') mostrarAviso(loginAviso, `${r.mensagem}${r.motivo ? ` Motivo: ${r.motivo}` : ''}`, 'erro', 'Acesso não liberado');
        else mostrarAviso(loginAviso, r.mensagem, 'erro');
        if (r.codigo === 'CREDENCIAIS') { $('login-senha').value = ''; $('login-senha').focus(); }
        return;
      }
      P.startSession({ role: r.role, id: r.id }, lembrar);
      location.replace(destino());
    } finally {
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  }

  /* ---------- Cadastro ---------- */
  const CAMPO = { nome: 'cad-nome', cpf: 'cad-cpf', nascimento: 'cad-nascimento', crp: 'cad-crp', especialidade: 'cad-especialidade', abordagem: 'cad-abordagem', email: 'cad-email', telefone: 'cad-telefone', senha: 'cad-senha', confirmar: 'cad-confirmar-senha', termos: 'termos' };

  async function handleCadastro(event) {
    event.preventDefault();
    limparErros(formCadastro);
    esconderAviso(cadastroAviso);
    const tipo = tipoConta();
    const d = {
      tipo,
      nome: $('cad-nome').value.trim(),
      cpf: $('cad-cpf').value.trim(),
      nascimento: $('cad-nascimento').value,
      crp: $('cad-crp').value.trim(),
      especialidade: $('cad-especialidade').value.trim(),
      abordagem: $('cad-abordagem').value.trim(),
      email: $('cad-email').value.trim().toLowerCase(),
      telefone: $('cad-telefone').value.trim(),
      senha: $('cad-senha').value,
      confirmar: $('cad-confirmar-senha').value,
      termos: $('termos').checked,
    };

    const erros = auth.validarCadastro(P.db, d);
    if (Object.keys(erros).length) {
      Object.entries(erros).forEach(([k, msg]) => marcarErro(CAMPO[k], msg));
      mostrarAviso(cadastroAviso, 'Verifique os campos destacados abaixo.', 'erro');
      const first = formCadastro.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }

    const btn = $('btn-cadastrar');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      if (tipo === 'psicologo') await auth.cadastrarPsicologo(P.db, d);
      else await auth.cadastrarPaciente(P.db, d);
      P.save('cadastro');
    } catch (err) {
      if (err.campos) Object.entries(err.campos).forEach(([k, msg]) => marcarErro(CAMPO[k], msg));
      mostrarAviso(cadastroAviso, err.message || 'Não foi possível concluir o cadastro.', 'erro');
      return;
    } finally {
      btn.disabled = false; btn.textContent = 'Criar conta';
    }

    formCadastro.reset();
    forcaSenha('');
    atualizarCamposPorTipo();
    alternarTela('login');
    $('login-email').value = d.email;
    mostrarAviso(loginAviso,
      tipo === 'psicologo'
        ? 'Seu cadastro profissional foi enviado. Você poderá entrar assim que o administrador da clínica validar seus dados.'
        : 'Você poderá entrar assim que o profissional de psicologia responsável aprovar sua solicitação. Acompanhe pelo seu e-mail.',
      'sucesso', 'Cadastro realizado com sucesso!');
  }

  /* ---------- Inicialização ---------- */
  function init() {
    $('link-ir-cadastro').addEventListener('click', (e) => { e.preventDefault(); esconderAviso(loginAviso); alternarTela('cadastro'); });
    $('link-ir-login').addEventListener('click', (e) => { e.preventDefault(); esconderAviso(cadastroAviso); alternarTela('login'); });
    $('link-esqueci-senha').addEventListener('click', (e) => {
      e.preventDefault();
      mostrarAviso(loginAviso, 'A recuperação de senha depende do envio de e-mail pelo servidor e ainda não faz parte desta versão. Fale com a clínica para redefinir o acesso.', 'info');
    });

    document.querySelectorAll('.btn-ver-senha').forEach((b) => b.addEventListener('click', () => {
      const campo = $(b.dataset.alvo);
      const oculta = campo.type === 'password';
      campo.type = oculta ? 'text' : 'password';
      b.textContent = oculta ? 'Ocultar' : 'Mostrar';
    }));

    document.querySelectorAll('input[name="tipo-conta"]').forEach((r) => r.addEventListener('change', atualizarCamposPorTipo));
    atualizarCamposPorTipo();

    $('cad-cpf').addEventListener('input', (e) => { e.target.value = auth.mascaraCpf(e.target.value); });
    $('cad-telefone').addEventListener('input', (e) => { e.target.value = auth.mascaraTelefone(e.target.value); });
    $('cad-senha').addEventListener('input', (e) => forcaSenha(e.target.value));
    $('cad-nascimento').max = P.util.isoDate();

    document.querySelectorAll('#form-login input, #form-cadastro input').forEach((c) => c.addEventListener('input', () => limparErro(c.id)));
    $('termos').addEventListener('change', () => limparErro('termos'));

    document.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => {
      $('login-email').value = b.dataset.demo;
      $('login-senha').value = 'prisma123';
      limparErros(formLogin);
      $('btn-entrar').focus();
    }));

    formLogin.addEventListener('submit', handleLogin);
    formCadastro.addEventListener('submit', handleCadastro);

    const msg = params.get('msg');
    if (msg) mostrarAviso(loginAviso, msg, 'info');
    if (params.get('cadastro') === '1') alternarTela('cadastro');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window.PRISMA);
