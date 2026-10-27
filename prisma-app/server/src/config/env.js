/**
 * Configuração da API a partir de variáveis de ambiente.
 * Node 22+: `node --env-file=.env src/server.js` (ou defina as variáveis no ambiente).
 */
const env = process.env;

function obrigatoria(nome, padraoDev) {
  const v = env[nome] ?? (env.NODE_ENV === 'production' ? undefined : padraoDev);
  if (v === undefined || v === '') throw new Error(`Variável de ambiente obrigatória ausente: ${nome}`);
  return v;
}

export const config = {
  porta: Number(env.PORT || 3000),
  producao: env.NODE_ENV === 'production',
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'prisma_db',
    socketPath: env.DB_SOCKET || undefined,
  },
  jwt: {
    // Em produção o segredo é obrigatório; em desenvolvimento há um padrão apenas local.
    segredo: obrigatoria('JWT_SECRET', 'dev-somente-local-troque-em-producao'),
    expiraEm: env.JWT_EXPIRES_IN || '8h',
  },
  anexoMaxBytes: Math.min(Number(env.ANEXO_MAX_BYTES || 10 * 1024 * 1024), 10 * 1024 * 1024),
  dbTimezone: env.DB_TIMEZONE || '',   // ex.: -03:00 (padrão: fuso local do servidor Node)
  servirFrontend: (env.SERVIR_FRONTEND ?? 'true') === 'true',
};
