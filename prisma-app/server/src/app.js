/**
 * Aplicação Express do PRISMA.
 * Opcionalmente serve o front-end estático (pasta prisma-app/) na mesma origem.
 */
import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config/env.js';
import { pool } from './config/db.js';
import { tratadorDeErros } from './middleware/erros.js';
import authRoutes from './routes/auth.routes.js';
import prontuarioRoutes from './routes/prontuario.routes.js';
import chatRoutes from './routes/chat.routes.js';
import agendaRoutes from './routes/agenda.routes.js';

export function criarApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],      // o front usa um script inline para o tema
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(express.json({ limit: '12mb' }));

  app.get('/api/health', async (req, res) => {
    try {
      const [[r]] = await pool.query('SELECT VERSION() AS versao');
      res.json({ status: 'ok', sistema: 'PRISMA', banco: `MySQL ${r.versao}` });
    } catch {
      res.status(503).json({ status: 'erro', erro: 'Banco de dados indisponível.' });
    }
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/prontuario', prontuarioRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/agenda', agendaRoutes);
  app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

  if (config.servirFrontend) {
    const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    // Nunca expor o código/configuração da API nem os scripts do banco (antes do static!)
    app.use(['/server', '/database'], (req, res) => res.status(404).end());
    app.use(express.static(raiz, { index: 'index.html', dotfiles: 'deny', extensions: ['html'] }));
  }

  app.use(tratadorDeErros);
  return app;
}
