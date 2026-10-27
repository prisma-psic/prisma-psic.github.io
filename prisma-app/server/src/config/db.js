/**
 * Pool de conexões MySQL 8.4 (mysql2/promise).
 *
 * `comUsuario(usuario, fn)` executa `fn(conn)` numa conexão dedicada após
 * informar ao banco quem está operando — os triggers usam essas variáveis:
 *   @prisma_usuario_tipo → TRG_Limite_Alteracao_Agenda (trava de 24 h do paciente)
 *   @prisma_usuario_id   → autoria do Sessao_Historico (prontuário por sessão)
 */
import mysql from 'mysql2/promise';
import { config } from './env.js';

export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'UTF8MB4_0900_AI_CI', // mesma collation do banco (evita "Illegal mix of collations")
  timezone: 'local',
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false,
});

/**
 * O NOW() dos triggers (prazos de 48 h / 36 h) precisa usar o mesmo fuso que a API:
 * cada conexão recebe o fuso de DB_TIMEZONE ou, por padrão, o fuso local do Node.
 */
function fusoLocal() {
  const off = -new Date().getTimezoneOffset();
  const s = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
pool.on('connection', (conn) => { conn.query('SET time_zone = ?', [config.dbTimezone || fusoLocal()]); });

export async function comUsuario(usuario, fn) {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET @prisma_usuario_tipo = ?, @prisma_usuario_id = ?', [usuario?.tipo ?? null, usuario?.id ?? null]);
    return await fn(conn);
  } finally {
    // Limpa as variáveis antes de devolver a conexão ao pool
    await conn.query('SET @prisma_usuario_tipo = NULL, @prisma_usuario_id = NULL').catch(() => {});
    conn.release();
  }
}

/** Executa `fn` numa transação, com o usuário informado ao banco. */
export async function transacao(usuario, fn) {
  return comUsuario(usuario, async (conn) => {
    await conn.beginTransaction();
    try {
      const r = await fn(conn);
      await conn.commit();
      return r;
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  });
}

/** Registra uma linha na trilha de auditoria (LGPD). */
export async function auditar(conn, usuario, acao, detalhes, sucesso = true) {
  await conn.query(
    'INSERT INTO Auditoria (Acao, UsuarioId, UsuarioTipo, Detalhes, Sucesso) VALUES (?, ?, ?, ?, ?)',
    [acao, usuario?.id ?? 'sistema', usuario?.tipo ?? 'sistema', String(detalhes ?? '').slice(0, 500), !!sucesso],
  );
}
