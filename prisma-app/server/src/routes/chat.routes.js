/**
 * Rotas do CHAT (psicólogo ⇄ paciente) — sem respostas automáticas.
 *
 *   GET   /api/chat/conversas                     contatos + última mensagem + não lidas
 *   GET   /api/chat/mensagens/:usuarioId          conversa em ORDER BY DataEnviado ASC
 *                                                 (?limite, ?antesDe, ?depoisDe)
 *   POST  /api/chat/mensagens                     { destinatario, texto }
 *   PATCH /api/chat/mensagens/:usuarioId/lidas    marca como lidas as recebidas
 *
 * :usuarioId é o CPF do paciente ou o CRP do psicólogo (codifique a "/" do CRP: 06%2F12345).
 */
import { Router } from 'express';
import { autenticar } from '../middleware/auth.js';
import { comUsuario, transacao } from '../config/db.js';
import * as svc from '../services/chat.service.js';

const router = Router();
router.use(autenticar);

router.get('/conversas', async (req, res, next) => {
  try { res.json(await comUsuario(req.usuario, (conn) => svc.listarConversas(conn, req.usuario))); } catch (e) { next(e); }
});

router.get('/mensagens/:usuarioId', async (req, res, next) => {
  try {
    const { limite, antesDe, depoisDe } = req.query;
    res.json(await comUsuario(req.usuario, (conn) => svc.listarMensagens(conn, req.usuario, decodeURIComponent(req.params.usuarioId), { limite, antesDe, depoisDe })));
  } catch (e) { next(e); }
});

router.post('/mensagens', async (req, res, next) => {
  try { res.status(201).json(await transacao(req.usuario, (conn) => svc.enviarMensagem(conn, req.usuario, req.body || {}))); } catch (e) { next(e); }
});

router.patch('/mensagens/:usuarioId/lidas', async (req, res, next) => {
  try {
    const n = await comUsuario(req.usuario, (conn) => svc.marcarLidas(conn, req.usuario, decodeURIComponent(req.params.usuarioId)));
    res.json({ marcadas: n });
  } catch (e) { next(e); }
});

export default router;
