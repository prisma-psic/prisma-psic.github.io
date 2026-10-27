/**
 * Rotas da AGENDA — bloqueios, prazos de 48 h e confirmação de presença (36 h).
 *
 *   GET    /api/agenda/bloqueios                      bloqueios futuros (?incluirPassados=1)
 *                                                    · paciente: só o período, sem o motivo
 *   POST   /api/agenda/bloqueios                      { diaInteiro, dataInicio, dataFim?, horaInicio?, horaFim?, motivo?, cancelarAfetadas? }
 *   PUT    /api/agenda/bloqueios/:id                  mesmo corpo do POST
 *   DELETE /api/agenda/bloqueios/:id
 *   GET    /api/agenda/disponibilidade                ?data=AAAA-MM-DD (horários) ou ?mes=AAAA-MM (dias) &duracao=60 min &ignorar=<idConsulta>
 *   POST   /api/agenda/consultas                      paciente solicita { dataHora, duracao, modalidade, observacoes } (mín. 48 h)
 *   PATCH  /api/agenda/consultas/:id/remarcar         { dataHora } (paciente: só com mais de 48 h)
 *   POST   /api/agenda/consultas/:id/confirmar-presenca
 *   GET    /api/agenda/confirmacoes                   painel da psicóloga (?situacao=PENDENTE_CONFIRMACAO|LEMBRETE|AGUARDANDO)
 */
import { Router } from 'express';
import { autenticar } from '../middleware/auth.js';
import { comUsuario, transacao } from '../config/db.js';
import { idParam } from '../middleware/erros.js';
import * as svc from '../services/agenda.service.js';

const router = Router();
router.use(autenticar);

const h = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };

router.get('/bloqueios', h(async (req, res) => {
  const incluirPassados = ['1', 'true'].includes(String(req.query.incluirPassados));
  res.json(await comUsuario(req.usuario, (conn) => svc.listarBloqueios(conn, req.usuario, { incluirPassados, crp: req.query.crp })));
}));

router.post('/bloqueios', h(async (req, res) => {
  res.status(201).json(await transacao(req.usuario, (conn) => svc.criarBloqueio(conn, req.usuario, req.body || {})));
}));

router.put('/bloqueios/:id', h(async (req, res) => {
  const id = idParam(req.params.id);
  res.json(await transacao(req.usuario, (conn) => svc.editarBloqueio(conn, req.usuario, id, req.body || {})));
}));

router.delete('/bloqueios/:id', h(async (req, res) => {
  const id = idParam(req.params.id);
  await transacao(req.usuario, (conn) => svc.removerBloqueio(conn, req.usuario, id));
  res.status(204).end();
}));

router.get('/disponibilidade', h(async (req, res) => {
  const { data, mes, duracao, ignorar, crp } = req.query;
  res.json(await comUsuario(req.usuario, (conn) => svc.disponibilidade(conn, req.usuario, { data, mes, duracao, ignorar, crp })));
}));

router.post('/consultas', h(async (req, res) => {
  res.status(201).json(await transacao(req.usuario, (conn) => svc.solicitar(conn, req.usuario, req.body || {})));
}));

router.patch('/consultas/:id/remarcar', h(async (req, res) => {
  const id = idParam(req.params.id);
  res.json(await transacao(req.usuario, (conn) => svc.remarcar(conn, req.usuario, id, req.body || {})));
}));

router.post('/consultas/:id/confirmar-presenca', h(async (req, res) => {
  const id = idParam(req.params.id);
  res.json(await transacao(req.usuario, (conn) => svc.confirmarPresenca(conn, req.usuario, id)));
}));

router.get('/confirmacoes', h(async (req, res) => {
  res.json(await comUsuario(req.usuario, (conn) => svc.listarConfirmacoes(conn, req.usuario, { situacao: req.query.situacao })));
}));

export default router;
