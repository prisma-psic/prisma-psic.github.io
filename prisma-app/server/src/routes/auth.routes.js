/**
 * Autenticação — mesmas regras do front-end (auth.js):
 * somente contas ATIVAS entram; cadastro pendente recebe a mensagem de aguardando aprovação.
 *
 *   POST /api/auth/login   { email, senha } → { token, usuario }
 *   GET  /api/auth/me      usuário do token
 */
import { Router } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { pool, auditar } from '../config/db.js';
import { autenticar, emitirToken } from '../middleware/auth.js';
import { HttpError } from '../middleware/erros.js';
import { verificarSenha, verificacaoFicticia, precisaMigrar, gerarHash } from '../utils/senha.js';

const router = Router();

const MSG = {
  PENDENTE_APROVACAO: 'Seu cadastro foi realizado com sucesso e está aguardando a aprovação do profissional de psicologia responsável.',
  REJEITADO: 'Seu cadastro não foi aprovado pelo profissional responsável. Em caso de dúvida, entre em contato com a clínica.',
  INATIVO: 'Esta conta está inativa. Entre em contato com a clínica para reativar o acesso.',
};

// 5 tentativas por e-mail+IP a cada 5 minutos (mitigação de força bruta — risco R02)
const limitarLogin = rateLimit({
  windowMs: 5 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email || '').toLowerCase()}`,
  skipSuccessfulRequests: true,
  message: { erro: 'Muitas tentativas sem sucesso. Tente novamente em alguns minutos.' },
});

router.post('/login', limitarLogin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const senha = String(req.body?.senha || '');
    if (!email || !senha) throw new HttpError(400, 'Informe e-mail e senha.');

    const [[conta]] = await pool.query('SELECT Tipo, Identificador, Nome, Email, SenhaHash, Status, IsAdmin FROM vw_autenticacao WHERE Email = ?', [email]);
    // A senha é verificada ANTES de revelar o status (evita enumeração de contas)
    const ok = conta ? await verificarSenha(senha, conta.SenhaHash) : await verificacaoFicticia(senha);
    const conn = await pool.getConnection();
    try {
      if (!ok) {
        await auditar(conn, conta ? { tipo: conta.Tipo, id: conta.Identificador } : null, 'LOGIN_FALHA', `Tentativa sem sucesso (${email})`, false);
        throw new HttpError(401, 'E-mail ou senha incorretos.');
      }
      if (conta.Status !== 'ATIVO') {
        await auditar(conn, { tipo: conta.Tipo, id: conta.Identificador }, 'LOGIN_BLOQUEADO_STATUS', `Status ${conta.Status}`, false);
        throw new HttpError(403, MSG[conta.Status] || 'Acesso não liberado.', { codigo: conta.Status });
      }
      // Migra hash legado (SHA-256 do protótipo) para bcrypt
      if (precisaMigrar(conta.SenhaHash)) {
        const tabela = conta.Tipo === 'psicologo' ? 'Psicologo' : 'Paciente';
        const chave = conta.Tipo === 'psicologo' ? 'CRP' : 'CPF';
        await conn.query(`UPDATE ${tabela} SET SenhaHash = ? WHERE ${chave} = ?`, [await gerarHash(senha), conta.Identificador]);
      }
      await conn.query(`UPDATE ${conta.Tipo === 'psicologo' ? 'Psicologo SET UltimoLogin = NOW() WHERE CRP' : 'Paciente SET UltimoLogin = NOW() WHERE CPF'} = ?`, [conta.Identificador]);
      await auditar(conn, { tipo: conta.Tipo, id: conta.Identificador }, conta.Tipo === 'psicologo' ? 'LOGIN_PSICOLOGO' : 'LOGIN_PACIENTE', `Login via API (${conta.Nome})`);
    } finally { conn.release(); }

    res.json({
      token: emitirToken(conta),
      usuario: { tipo: conta.Tipo, id: conta.Identificador, nome: conta.Nome, email: conta.Email, isAdmin: !!conta.IsAdmin },
    });
  } catch (e) { next(e); }
});

router.get('/me', autenticar, (req, res) => res.json(req.usuario));

export default router;
