/**
 * Prontuário por sessão — consultas SQL.
 * Autorização: o psicólogo acessa as sessões em que é o responsável pela
 * consulta (Consulta.CRP_Psicologo); o administrador da clínica acessa todas.
 */
import { naoEncontrado, proibido, invalido } from '../middleware/erros.js';
import { auditar } from '../config/db.js';
import { validarArquivo, sha256 } from '../utils/arquivos.js';

const podeVer = (usuario, crpResponsavel) => usuario.isAdmin || usuario.id === crpResponsavel;

/** Rótulo da aba da sub-navbar: "Sessão #3 - 10/10" ou "Sessão Atual - Hoje". */
function rotulo(numero, dataHora, atual) {
  if (atual) return 'Sessão Atual - Hoje';
  const d = new Date(dataHora);
  return `Sessão #${numero} - ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Numeração: usa Registro_Clinico.NumeroSessao quando existe (histórico importado);
 * sem registro, a sessão recebe o número da anterior + 1.
 */
function numerar(linhas) {
  let anterior = 0;
  return linhas.map((s) => {
    const numero = s.NumeroSessao || anterior + 1;
    anterior = numero;
    const atual = !!s.Atual;
    return {
      idConsulta: s.ID_Consulta,
      numero,
      rotulo: rotulo(numero, s.DataHora, atual),
      atual,
      dataHora: s.DataHora,
      status: s.Status,
      modalidade: s.Modalidade,
      duracao: s.Duracao,
      idRegistro: s.ID_RC,
      temAnotacao: !!s.ID_RC,
      qtdAnexos: Number(s.QtdAnexos),
    };
  });
}

async function paciente(conn, cpf) {
  const [[p]] = await conn.query('SELECT CPF, Nome, Status, DataNascimento, QueixaPrincipal FROM Paciente WHERE CPF = ?', [cpf]);
  if (!p) throw naoEncontrado('Paciente não encontrado.');
  return p;
}

async function sessoesDoPaciente(conn, usuario, cpf) {
  const [linhas] = await conn.query(
    `SELECT ID_Consulta, CRP_Psicologo, DataHora, Duracao, Status, Modalidade, ID_RC, NumeroSessao, QtdAnexos, Atual
       FROM vw_prontuario_sessoes
      WHERE CPF_Paciente = ?
      ORDER BY DataHora ASC, ID_Consulta ASC`,
    [cpf],
  );
  // A numeração considera todas as sessões do paciente; a lista devolvida só as autorizadas
  return numerar(linhas).filter((s, i) => podeVer(usuario, linhas[i].CRP_Psicologo));
}

/** GET /api/prontuario/paciente/:cpf/sessoes */
export async function listarSessoes(conn, usuario, cpf) {
  const p = await paciente(conn, cpf);
  const sessoes = await sessoesDoPaciente(conn, usuario, cpf);
  if (!sessoes.length && !usuario.isAdmin) {
    const [[vinculo]] = await conn.query('SELECT 1 AS ok FROM Consulta WHERE CPF_Paciente = ? AND CRP_Psicologo = ? LIMIT 1', [cpf, usuario.id]);
    if (!vinculo) throw proibido('Você não é o profissional responsável por este paciente.');
  }
  await auditar(conn, usuario, 'LISTAR_SESSOES_PRONTUARIO', `Paciente ${cpf}`);
  return { paciente: { cpf: p.CPF, nome: p.Nome, status: p.Status }, sessoes };
}

/** Carrega a consulta e confere a autorização do profissional. */
async function consultaAutorizada(conn, usuario, idConsulta) {
  const [[c]] = await conn.query(
    `SELECT c.ID_Consulta, c.CPF_Paciente, c.CRP_Psicologo, c.DataHora, c.DataHoraFim, c.Duracao, c.Status, c.Modalidade, c.Observacoes,
            p.Nome AS PacienteNome
       FROM Consulta c JOIN Paciente p ON p.CPF = c.CPF_Paciente
      WHERE c.ID_Consulta = ?`,
    [idConsulta],
  );
  if (!c) throw naoEncontrado('Sessão não encontrada.');
  if (!podeVer(usuario, c.CRP_Psicologo)) {
    await auditar(conn, usuario, 'ACESSO_NEGADO_PRONTUARIO', `Sessão ${idConsulta} de outro profissional`, false);
    throw proibido('Você não é o profissional responsável por esta sessão.');
  }
  return c;
}

const metaAnexo = `ID_Anexo AS idAnexo, NomeArquivo AS nomeArquivo, Extensao AS extensao, MimeType AS mimeType,
  TamanhoBytes AS tamanhoBytes, HashSHA256 AS hashSha256, Versao AS versao, Descricao AS descricao,
  CRP_Psicologo AS enviadoPor, DataEnvio AS dataEnvio, DataUltMod AS dataUltMod`;

/** GET /api/prontuario/sessao/:idConsulta */
export async function obterSessao(conn, usuario, idConsulta) {
  const c = await consultaAutorizada(conn, usuario, idConsulta);
  const sessoes = await sessoesDoPaciente(conn, usuario, c.CPF_Paciente);
  const info = sessoes.find((s) => s.idConsulta === c.ID_Consulta) || null;

  const [[rc]] = await conn.query(
    `SELECT ID_RC AS idRegistro, NumeroSessao AS numeroSessao, DataCriacao AS dataCriacao, DataUltMod AS dataUltMod, DuracaoMin AS duracaoMin,
            Conteudo AS conteudo, QueixaPrincipal AS queixaPrincipal, IntervencoesRealizadas AS intervencoesRealizadas,
            ProgressoObservado AS progressoObservado, TarefasParaCasa AS tarefasParaCasa, ProximaSessao AS proximaSessao, Tags AS tags
       FROM Registro_Clinico WHERE ID_Consulta = ?`,
    [idConsulta],
  );
  const [anexos] = await conn.query(
    `SELECT ${metaAnexo} FROM Registro_Clinico_Anexo WHERE ID_Consulta = ? AND Removido = FALSE ORDER BY DataEnvio ASC, ID_Anexo ASC`,
    [idConsulta],
  );
  const [historico] = await conn.query(
    `SELECT h.ID_Historico AS id, h.DataHora AS dataHora, h.Acao AS acao, h.UsuarioId AS usuarioId,
            COALESCE(ps.Nome, pa.Nome, h.UsuarioId) AS usuarioNome, h.Detalhes AS detalhes
       FROM Sessao_Historico h
       LEFT JOIN Psicologo ps ON ps.CRP = h.UsuarioId
       LEFT JOIN Paciente pa ON pa.CPF = h.UsuarioId
      WHERE h.ID_Consulta = ?
      ORDER BY h.DataHora DESC, h.ID_Historico DESC`,
    [idConsulta],
  );
  const [documentos] = await conn.query(
    'SELECT ID_Doc AS idDoc, NomeArquivo AS nomeArquivo, Tipo AS tipo, Origem AS origem, DataEnvio AS dataEnvio FROM Documentos WHERE ID_Consulta = ? ORDER BY DataEnvio',
    [idConsulta],
  );
  await auditar(conn, usuario, 'VISUALIZAR_PRONTUARIO', `Sessão da consulta ${idConsulta} (${c.PacienteNome})`);

  return {
    sessao: {
      idConsulta: c.ID_Consulta, numero: info?.numero ?? null, rotulo: info?.rotulo ?? null, atual: info?.atual ?? false,
      dataHora: c.DataHora, dataHoraFim: c.DataHoraFim, duracao: c.Duracao, status: c.Status, modalidade: c.Modalidade,
      observacoes: c.Observacoes, paciente: { cpf: c.CPF_Paciente, nome: c.PacienteNome },
    },
    anotacao: rc ? { ...rc, tags: typeof rc.tags === 'string' ? JSON.parse(rc.tags) : rc.tags || [] } : null,
    anexos,
    historico,
    documentos,
  };
}

/** POST /api/prontuario/sessao/:idConsulta/anexo — arquivo (multipart) ou anotação em texto (JSON). */
export async function anexar(conn, usuario, idConsulta, { nomeArquivo, buffer, descricao }, maxBytes) {
  await consultaAutorizada(conn, usuario, idConsulta);
  const arq = validarArquivo(nomeArquivo, buffer, maxBytes);
  const [r] = await conn.query(
    `INSERT INTO Registro_Clinico_Anexo
       (ID_Consulta, CPF_Paciente, CRP_Psicologo, NomeArquivo, Extensao, MimeType, TamanhoBytes, HashSHA256, Conteudo, Descricao)
     VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?)`, // CPF_Paciente é preenchido pelo TRG_Anexo_Valida a partir da consulta
    [idConsulta, usuario.id, arq.nome, arq.ext, arq.mime, arq.buffer.length, sha256(arq.buffer), arq.buffer, descricao ? String(descricao).slice(0, 255) : null],
  );
  await auditar(conn, usuario, 'ANEXO_PRONTUARIO', `"${arq.nome}" vinculado à sessão ${idConsulta}`);
  const [[meta]] = await conn.query(`SELECT ${metaAnexo} FROM Registro_Clinico_Anexo WHERE ID_Anexo = ?`, [r.insertId]);
  return meta;
}

async function anexoAutorizado(conn, usuario, idAnexo, { comConteudo = false } = {}) {
  const [[a]] = await conn.query(
    `SELECT ID_Anexo, ID_Consulta, NomeArquivo, Extensao, MimeType, TamanhoBytes, HashSHA256, Versao, Removido ${comConteudo ? ', Conteudo' : ''}
       FROM Registro_Clinico_Anexo WHERE ID_Anexo = ?`,
    [idAnexo],
  );
  if (!a || a.Removido) throw naoEncontrado('Arquivo não encontrado.');
  await consultaAutorizada(conn, usuario, a.ID_Consulta);
  return a;
}

/** GET /api/prontuario/anexo/:idAnexo/download */
export async function baixarAnexo(conn, usuario, idAnexo) {
  const a = await anexoAutorizado(conn, usuario, idAnexo, { comConteudo: true });
  await auditar(conn, usuario, 'DOWNLOAD_ANEXO_PRONTUARIO', `Anexo ${idAnexo} (${a.NomeArquivo})`);
  return a;
}

/** PUT /api/prontuario/anexo/:idAnexo — novo conteúdo (.txt editado ou nova versão do arquivo). */
export async function atualizarAnexo(conn, usuario, idAnexo, { buffer, nomeArquivo }, maxBytes) {
  const a = await anexoAutorizado(conn, usuario, idAnexo);
  // Mantém o nome original; a extensão da nova versão precisa ser a mesma
  const arq = validarArquivo(nomeArquivo || a.NomeArquivo, buffer, maxBytes);
  if (arq.ext !== a.Extensao) throw invalido(`A nova versão deve ser um arquivo .${a.Extensao}.`);
  const hash = sha256(arq.buffer);
  if (hash !== a.HashSHA256) {
    // TRG_Anexo_Versao incrementa a versão; TRG_Anexo_Historico_Update registra o evento
    await conn.query('UPDATE Registro_Clinico_Anexo SET Conteudo = ?, TamanhoBytes = ?, HashSHA256 = ? WHERE ID_Anexo = ?', [arq.buffer, arq.buffer.length, hash, idAnexo]);
    await auditar(conn, usuario, 'ANEXO_ATUALIZADO', `Anexo ${idAnexo} (${a.NomeArquivo})`);
  }
  const [[meta]] = await conn.query(`SELECT ${metaAnexo} FROM Registro_Clinico_Anexo WHERE ID_Anexo = ?`, [idAnexo]);
  return meta;
}

/** DELETE /api/prontuario/anexo/:idAnexo — remoção lógica. */
export async function removerAnexo(conn, usuario, idAnexo, motivo) {
  const a = await anexoAutorizado(conn, usuario, idAnexo);
  await conn.query('UPDATE Registro_Clinico_Anexo SET Removido = TRUE, MotivoRemocao = ? WHERE ID_Anexo = ?', [motivo ? String(motivo).slice(0, 255) : null, idAnexo]);
  await auditar(conn, usuario, 'ANEXO_REMOVIDO', `Anexo ${idAnexo} (${a.NomeArquivo})`);
}

/** PUT /api/prontuario/sessao/:idConsulta/anotacao — cria ou atualiza a anotação clínica da sessão. */
export async function salvarAnotacao(conn, usuario, idConsulta, dados) {
  const c = await consultaAutorizada(conn, usuario, idConsulta);
  if (!['Realizada', 'Agendada'].includes(c.Status)) throw invalido('Anotações só podem ser registradas em sessões realizadas ou em andamento.');
  const campos = ['queixaPrincipal', 'intervencoesRealizadas', 'progressoObservado', 'tarefasParaCasa', 'proximaSessao'];
  const v = Object.fromEntries(campos.map((k) => [k, dados[k] == null ? null : String(dados[k]).slice(0, 20000)]));
  const tags = Array.isArray(dados.tags) ? JSON.stringify(dados.tags.map((t) => String(t).slice(0, 40)).slice(0, 20)) : null;
  const duracao = Number.isInteger(dados.duracaoMin) && dados.duracaoMin >= 10 && dados.duracaoMin <= 180 ? dados.duracaoMin : 50;
  const conteudo = String(dados.conteudo || v.queixaPrincipal || '').slice(0, 20000) || '—';

  const [[existe]] = await conn.query('SELECT ID_RC FROM Registro_Clinico WHERE ID_Consulta = ?', [idConsulta]);
  if (existe) {
    await conn.query(
      `UPDATE Registro_Clinico SET Conteudo = ?, QueixaPrincipal = ?, IntervencoesRealizadas = ?, ProgressoObservado = ?,
              TarefasParaCasa = ?, ProximaSessao = ?, Tags = COALESCE(?, Tags), DuracaoMin = ? WHERE ID_RC = ?`,
      [conteudo, v.queixaPrincipal, v.intervencoesRealizadas, v.progressoObservado, v.tarefasParaCasa, v.proximaSessao, tags, duracao, existe.ID_RC],
    );
  } else {
    await conn.query(
      `INSERT INTO Registro_Clinico (Conteudo, QueixaPrincipal, IntervencoesRealizadas, ProgressoObservado, TarefasParaCasa, ProximaSessao, Tags, DuracaoMin, CPF_Paciente, ID_Consulta, CRP_Psicologo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [conteudo, v.queixaPrincipal, v.intervencoesRealizadas, v.progressoObservado, v.tarefasParaCasa, v.proximaSessao, tags || '[]', duracao, c.CPF_Paciente, idConsulta, usuario.id],
    );
  }
  await auditar(conn, usuario, existe ? 'ATUALIZAR_REGISTRO_CLINICO' : 'CRIAR_REGISTRO_CLINICO', `Sessão ${idConsulta}`);
  return (await obterSessao(conn, usuario, idConsulta)).anotacao;
}
