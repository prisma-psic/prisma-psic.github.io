/**
 * Erros HTTP e tradução dos erros do MySQL para respostas claras.
 *   SIGNAL SQLSTATE '45000' (regras de negócio dos triggers) → 422
 *   ER_DUP_ENTRY → 409 · FK/CHECK → 422
 */
export class HttpError extends Error {
  constructor(status, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}

export const naoEncontrado = (msg = 'Recurso não encontrado.') => new HttpError(404, msg);
export const proibido = (msg = 'Acesso negado.') => new HttpError(403, msg);
export const invalido = (msg, extra) => new HttpError(422, msg, extra);

/** Converte parâmetro de rota em inteiro positivo ou lança 400. */
export function idParam(valor, nome = 'id') {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Parâmetro inválido: ${nome}.`);
  return n;
}

// eslint-disable-next-line no-unused-vars
export function tratadorDeErros(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ erro: err.message, ...err.extra });
  }
  // Multer (upload)
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo acima do tamanho máximo permitido (10 MB).' : `Falha no upload: ${err.message}`;
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ erro: msg });
  }
  // JSON malformado
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido no corpo da requisição.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ erro: 'Corpo da requisição muito grande.' });
  // MySQL
  if (err && err.sqlState === '45000') return res.status(422).json({ erro: err.sqlMessage, regra: 'trigger' });
  if (err && err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Registro duplicado (restrição de unicidade).' });
  if (err && ['ER_NO_REFERENCED_ROW_2', 'ER_ROW_IS_REFERENCED_2'].includes(err.code)) return res.status(422).json({ erro: 'Referência inválida (chave estrangeira).' });
  if (err && err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') return res.status(422).json({ erro: 'Valor fora do domínio permitido (restrição CHECK).' });

  console.error('[PRISMA API] Erro inesperado:', err);
  return res.status(500).json({ erro: 'Erro interno do servidor.' });
}
