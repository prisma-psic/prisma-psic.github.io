/**
 * Verificação e geração de hash de senha.
 *   • Formato legado do protótipo: "sha256$<salt>$<hex>" (SHA-256(salt + senha)).
 *   • Formato recomendado: bcrypt ("$2a$…"/"$2b$…"). Senhas legadas são
 *     migradas para bcrypt automaticamente no primeiro login bem-sucedido.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const CUSTO_BCRYPT = 12;

export const gerarHash = (senha) => bcrypt.hash(senha, CUSTO_BCRYPT);
export const precisaMigrar = (hash) => typeof hash === 'string' && hash.startsWith('sha256$');

export async function verificarSenha(senha, hash) {
  if (typeof senha !== 'string' || typeof hash !== 'string') return false;
  if (hash.startsWith('$2')) return bcrypt.compare(senha, hash);
  if (hash.startsWith('sha256$')) {
    const [, salt, esperado] = hash.split('$');
    const calc = crypto.createHash('sha256').update(salt + senha, 'utf8').digest('hex');
    const a = Buffer.from(calc, 'hex');
    const b = Buffer.from(esperado || '', 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false; // ex.: '!' = senha não definida
}

/** Gasta tempo equivalente quando o e-mail não existe (evita enumeração por tempo de resposta). */
const HASH_FICTICIO = bcrypt.hashSync('prisma-conta-inexistente', CUSTO_BCRYPT);
export async function verificacaoFicticia(senha) {
  await bcrypt.compare(String(senha || ''), HASH_FICTICIO);
  return false;
}
