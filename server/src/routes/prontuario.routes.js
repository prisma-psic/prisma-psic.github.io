/**
 * Rotas do PRONTUÁRIO por sessão — acesso exclusivo de psicólogos ativos.
 *
 *   GET    /api/prontuario/paciente/:cpf/sessoes      sessões do paciente (sub-navbar)
 *   GET    /api/prontuario/sessao/:idConsulta         anotação + anexos + histórico da sessão
 *   POST   /api/prontuario/sessao/:idConsulta/anexo   upload (multipart, campo "arquivo") ou nota .txt (JSON)
 *   PUT    /api/prontuario/sessao/:idConsulta/anotacao  cria/atualiza a anotação clínica da sessão
 *   GET    /api/prontuario/anexo/:idAnexo/download    download do arquivo
 *   PUT    /api/prontuario/anexo/:idAnexo             edita o .txt (JSON) ou envia nova versão (multipart)
 *   DELETE /api/prontuario/anexo/:idAnexo             remoção lógica (motivo opcional)
 */
import { Router } from 'express';
import multer from 'multer';
import { autenticar, exigirPerfil } from '../middleware/auth.js';
import { HttpError, idParam, invalido } from '../middleware/erros.js';
import { comUsuario, transacao } from '../config/db.js';
import { config } from '../config/env.js';
import { contentDisposition } from '../utils/arquivos.js';
import * as svc from '../services/prontuario.service.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.anexoMaxBytes, files: 1, fields: 5 } });

router.use(autenticar, exigirPerfil('psicologo'));

const CPF_RE = /^\d{3}\.\d{3}\.\d{3}-\d{2}$/;

router.get('/paciente/:cpf/sessoes', async (req, res, next) => {
  try {
    const cpf = decodeURIComponent(req.params.cpf);
    if (!CPF_RE.test(cpf)) throw new HttpError(400, 'CPF inválido (formato 000.000.000-00).');
    res.json(await comUsuario(req.usuario, (conn) => svc.listarSessoes(conn, req.usuario, cpf)));
  } catch (e) { next(e); }
});

router.get('/sessao/:idConsulta', async (req, res, next) => {
  try {
    const id = idParam(req.params.idConsulta, 'idConsulta');
    res.json(await comUsuario(req.usuario, (conn) => svc.obterSessao(conn, req.usuario, id)));
  } catch (e) { next(e); }
});

/**
 * multipart/form-data: arquivo=<.txt|.doc|.docx|.pdf>, descricao=<opcional>
 * application/json:    { "nomeArquivo": "Observações.txt", "conteudoTexto": "...", "descricao": "..." }
 */
router.post('/sessao/:idConsulta/anexo', upload.single('arquivo'), async (req, res, next) => {
  try {
    const id = idParam(req.params.idConsulta, 'idConsulta');
    let entrada;
    if (req.file) {
      // Nome em UTF-8 (multer entrega latin1 para nomes não ASCII)
      entrada = { nomeArquivo: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), buffer: req.file.buffer, descricao: req.body?.descricao };
    } else if (req.is('application/json') && typeof req.body?.conteudoTexto === 'string') {
      const nome = String(req.body.nomeArquivo || 'Anotação').replace(/\.txt$/i, '');
      entrada = { nomeArquivo: `${nome}.txt`, buffer: Buffer.from(req.body.conteudoTexto || ' ', 'utf8'), descricao: req.body.descricao };
    } else {
      throw invalido('Envie um arquivo no campo "arquivo" (multipart) ou { nomeArquivo, conteudoTexto } em JSON.');
    }
    const anexo = await transacao(req.usuario, (conn) => svc.anexar(conn, req.usuario, id, entrada, config.anexoMaxBytes));
    res.status(201).location(`/api/prontuario/anexo/${anexo.idAnexo}/download`).json(anexo);
  } catch (e) { next(e); }
});

router.put('/sessao/:idConsulta/anotacao', async (req, res, next) => {
  try {
    const id = idParam(req.params.idConsulta, 'idConsulta');
    res.json(await transacao(req.usuario, (conn) => svc.salvarAnotacao(conn, req.usuario, id, req.body || {})));
  } catch (e) { next(e); }
});

router.get('/anexo/:idAnexo/download', async (req, res, next) => {
  try {
    const id = idParam(req.params.idAnexo, 'idAnexo');
    const a = await comUsuario(req.usuario, (conn) => svc.baixarAnexo(conn, req.usuario, id));
    res.set({
      'Content-Type': a.MimeType,
      'Content-Length': a.Conteudo.length,
      'Content-Disposition': contentDisposition(a.NomeArquivo, req.query.inline === '1' && a.Extensao === 'pdf' ? 'inline' : 'attachment'),
      'Cache-Control': 'no-store',
      ETag: `"${a.HashSHA256}"`,
      'X-Anexo-Versao': String(a.Versao),
    });
    res.send(a.Conteudo);
  } catch (e) { next(e); }
});

router.put('/anexo/:idAnexo', upload.single('arquivo'), async (req, res, next) => {
  try {
    const id = idParam(req.params.idAnexo, 'idAnexo');
    let entrada;
    if (req.file) entrada = { nomeArquivo: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), buffer: req.file.buffer };
    else if (typeof req.body?.conteudoTexto === 'string') entrada = { buffer: Buffer.from(req.body.conteudoTexto, 'utf8') };
    else throw invalido('Envie { conteudoTexto } (para .txt) ou um arquivo no campo "arquivo".');
    res.json(await transacao(req.usuario, (conn) => svc.atualizarAnexo(conn, req.usuario, id, entrada, config.anexoMaxBytes)));
  } catch (e) { next(e); }
});

router.delete('/anexo/:idAnexo', async (req, res, next) => {
  try {
    const id = idParam(req.params.idAnexo, 'idAnexo');
    await transacao(req.usuario, (conn) => svc.removerAnexo(conn, req.usuario, id, req.body?.motivo || req.query.motivo));
    res.status(204).end();
  } catch (e) { next(e); }
});

export default router;
