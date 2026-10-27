/**
 * Chat — consultas SQL.
 * Mensagens trocadas APENAS entre usuários reais (psicólogo ⇄ paciente);
 * não existe nenhuma resposta automática/sintética.
 * Ordenação: cronológica ASCENDENTE (mais antigas primeiro, mais recentes no final).
 */
import { invalido, naoEncontrado, proibido } from '../middleware/erros.js';

const MAX_TEXTO = 500;

/** Verifica se o usuário logado pode conversar com `outroId` e retorna o contato. */
export async function contatoPermitido(conn, usuario, outroId) {
  if (usuario.tipo === 'paciente') {
    const [[ps]] = await conn.query("SELECT CRP AS id, Nome AS nome FROM Psicologo WHERE CRP = ? AND Status = 'ATIVO'", [outroId]);
    if (!ps) throw proibido('Você só pode conversar com o(a) psicólogo(a) responsável.');
    return ps;
  }
  const [[pa]] = await conn.query('SELECT CPF AS id, Nome AS nome, Status AS status FROM Paciente WHERE CPF = ?', [outroId]);
  if (!pa) throw naoEncontrado('Paciente não encontrado.');
  return pa;
}

/**
 * GET /api/chat/mensagens/:usuarioId
 * Conversa entre o usuário logado e :usuarioId, ORDER BY DataEnviado ASC.
 *   ?limite=50       → as N mensagens mais recentes (devolvidas em ordem ASC)
 *   ?antesDe=<id>    → página anterior (rolagem para cima)
 *   ?depoisDe=<id>   → somente mensagens novas (atualização/polling)
 */
export async function listarMensagens(conn, usuario, outroId, { limite = 50, antesDe = null, depoisDe = null } = {}) {
  const contato = await contatoPermitido(conn, usuario, outroId);
  const lim = Math.min(Math.max(Number(limite) || 50, 1), 200);
  const filtros = [];
  const args = [usuario.id, outroId, outroId, usuario.id];
  if (antesDe) { filtros.push('ID_Mensagem < ?'); args.push(Number(antesDe)); }
  if (depoisDe) { filtros.push('ID_Mensagem > ?'); args.push(Number(depoisDe)); }
  args.push(lim);

  // Subconsulta DESC + LIMIT pega as mais recentes; a consulta externa devolve em ordem ASC.
  const [linhas] = await conn.query(
    `SELECT * FROM (
        SELECT ID_Mensagem AS idMensagem, DataEnviado AS dataEnviado, Texto AS texto,
               Remetente AS remetente, Destinatario AS destinatario, Lida AS lida
          FROM vw_chat_mensagens
         WHERE ((Remetente = ? AND Destinatario = ?) OR (Remetente = ? AND Destinatario = ?))
           ${filtros.length ? `AND ${filtros.join(' AND ')}` : ''}
         ORDER BY DataEnviado DESC, ID_Mensagem DESC
         LIMIT ?
     ) AS ultimas
     ORDER BY dataEnviado ASC, idMensagem ASC`,
    args,
  );
  return {
    contato: { id: contato.id, nome: contato.nome },
    mensagens: linhas.map((m) => ({ ...m, lida: !!m.lida, minha: m.remetente === usuario.id })),
    temAnteriores: linhas.length === lim,
  };
}

/** POST /api/chat/mensagens — { destinatario, texto } */
export async function enviarMensagem(conn, usuario, { destinatario, texto }) {
  const t = String(texto ?? '').trim();
  if (!t) throw invalido('Digite uma mensagem.');
  if (t.length > MAX_TEXTO) throw invalido(`A mensagem excede ${MAX_TEXTO} caracteres.`);
  await contatoPermitido(conn, usuario, String(destinatario || ''));
  // TRG_Valida_Mensagem confere no banco que ambos os lados estão ATIVOS
  const [r] = await conn.query('INSERT INTO Mensagem (Texto, Remetente, Destinatario) VALUES (?, ?, ?)', [t, usuario.id, destinatario]);
  const [[m]] = await conn.query(
    'SELECT ID_Mensagem AS idMensagem, DataEnviado AS dataEnviado, Texto AS texto, Remetente AS remetente, Destinatario AS destinatario, Lida AS lida FROM vw_chat_mensagens WHERE ID_Mensagem = ?',
    [r.insertId],
  );
  return { ...m, lida: !!m.lida, minha: true };
}

/** PATCH /api/chat/mensagens/:usuarioId/lidas — marca como lidas as mensagens recebidas de :usuarioId. */
export async function marcarLidas(conn, usuario, outroId) {
  await contatoPermitido(conn, usuario, outroId);
  const [r] = await conn.query('UPDATE Mensagem SET Lida = TRUE WHERE Remetente = ? AND Destinatario = ? AND Lida = FALSE', [outroId, usuario.id]);
  return r.affectedRows;
}

/** GET /api/chat/conversas — contatos com a última mensagem e contagem de não lidas. */
export async function listarConversas(conn, usuario) {
  const contatosSql = usuario.tipo === 'psicologo'
    ? "SELECT CPF AS id, Nome AS nome FROM Paciente WHERE Status = 'ATIVO'"
    : "SELECT CRP AS id, Nome AS nome FROM Psicologo WHERE Status = 'ATIVO' AND (IsAdmin OR CRP IN (SELECT CRP_Psicologo FROM Consulta WHERE CPF_Paciente = ?))";
  const [contatos] = await conn.query(contatosSql, usuario.tipo === 'psicologo' ? [] : [usuario.id]);
  const [ultimas] = await conn.query(
    `SELECT m.* FROM (
        SELECT IF(Remetente = ?, Destinatario, Remetente) AS contato, ID_Mensagem AS idMensagem, DataEnviado AS dataEnviado, Texto AS texto, Remetente AS remetente,
               ROW_NUMBER() OVER (PARTITION BY IF(Remetente = ?, Destinatario, Remetente) ORDER BY DataEnviado DESC, ID_Mensagem DESC) AS rn
          FROM vw_chat_mensagens WHERE Remetente = ? OR Destinatario = ?
     ) m WHERE m.rn = 1`,
    [usuario.id, usuario.id, usuario.id, usuario.id],
  );
  const [naoLidas] = await conn.query('SELECT Remetente AS contato, COUNT(*) AS n FROM Mensagem WHERE Destinatario = ? AND Lida = FALSE GROUP BY Remetente', [usuario.id]);
  const ult = new Map(ultimas.map((u) => [u.contato, u]));
  const nl = new Map(naoLidas.map((u) => [u.contato, Number(u.n)]));
  return contatos
    .map((c) => {
      const u = ult.get(c.id);
      return { id: c.id, nome: c.nome, ultimaMensagem: u ? { idMensagem: u.idMensagem, dataEnviado: u.dataEnviado, texto: u.texto, minha: u.remetente === usuario.id } : null, naoLidas: nl.get(c.id) || 0 };
    })
    .sort((a, b) => (b.ultimaMensagem?.dataEnviado ?? 0) - (a.ultimaMensagem?.dataEnviado ?? 0) || a.nome.localeCompare(b.nome));
}
