/**
 * Ponto de entrada da API do PRISMA.
 *   npm install
 *   node --env-file=.env src/server.js      (ou: npm start, com as variáveis no ambiente)
 */
import { criarApp } from './app.js';
import { config } from './config/env.js';
import { pool } from './config/db.js';

const app = criarApp();
const servidor = app.listen(config.porta, () => {
  console.log(`[PRISMA API] ouvindo em http://localhost:${config.porta}`);
});

function encerrar(sinal) {
  console.log(`[PRISMA API] ${sinal} recebido — encerrando…`);
  servidor.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => encerrar('SIGINT'));
process.on('SIGTERM', () => encerrar('SIGTERM'));
