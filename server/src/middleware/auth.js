/**
 * Autenticação (JWT Bearer) e autorização por perfil.
 * A cada requisição a conta é conferida no banco: se deixou de estar ATIVA
 * (inativada, recusada), o token deixa de valer imediatamente.
 */
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { pool } from '../config/db.js';
import { HttpError, proibido } from './erros.js';

export function emitirToken(conta) {
  return jwt.sign(
    { sub: conta.Identificador, tipo: conta.Tipo, adm: !!conta.IsAdmin },
    config.jwt.segredo,
    { expiresIn: config.jwt.expiraEm, algorithm: 'HS256' },
  );
}

export async function autenticar(req, res, next) {
  try {
    const [esquema, token] = String(req.headers.authorization || '').split(' ');
    if (esquema !== 'Bearer' || !token) throw new HttpError(401, 'Autenticação necessária.');
    let dados;
    try {
      dados = jwt.verify(token, config.jwt.segredo, { algorithms: ['HS256'] });
    } catch {
      throw new HttpError(401, 'Sessão inválida ou expirada. Entre novamente.');
    }
    const [[conta]] = await pool.query(
      'SELECT Tipo, Identificador, Nome, Email, Status, IsAdmin FROM vw_autenticacao WHERE Tipo = ? AND Identificador = ?',
      [dados.tipo, dados.sub],
    );
    if (!conta || conta.Status !== 'ATIVO') throw new HttpError(401, 'Conta sem acesso ativo.');
    req.usuario = { tipo: conta.Tipo, id: conta.Identificador, nome: conta.Nome, email: conta.Email, isAdmin: !!conta.IsAdmin };
    next();
  } catch (e) { next(e); }
}

/** Restringe a rota a um ou mais perfis ('psicologo' | 'paciente'). */
export const exigirPerfil = (...perfis) => (req, res, next) => {
  if (!req.usuario || !perfis.includes(req.usuario.tipo)) {
    return next(proibido('Seu perfil não tem permissão para acessar este recurso.'));
  }
  next();
};
