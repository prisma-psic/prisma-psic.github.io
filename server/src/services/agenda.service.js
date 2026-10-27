/**
 * Agenda — bloqueios de dias/horários, prazos de 48 h e confirmação de presença (36 h).
 *
 * As regras também existem no banco (triggers da seção 6.15 do schema.sql);
 * aqui elas são checadas antes para devolver mensagens claras e calcular a
 * disponibilidade que o calendário do paciente exibe.
 */
import { invalido, naoEncontrado, proibido } from '../middleware/erros.js';
import { auditar, pool } from '../config/db.js';

const H = 36e5;
const EXPEDIENTE = { inicio: 8 * 60, fim: 21 * 60, passo: 30 };
const INTERVALO_MIN = 20;
const DURACOES = { '30 min': 30, '60 min': 60, '90 min': 90, '120 min': 120 };
const ATIVAS = ['Pendente', 'Agendada', 'Aguardando_Paciente'];

export const MSG = {
  reagendamento: (h) => `Reagendamentos só podem ser realizados com pelo menos ${h} horas de antecedência. Entre em contato diretamente com a psicóloga.`,
  agendamento: (h) => `Novos agendamentos exigem pelo menos ${h} horas de antecedência.`,
  bloqueioPaciente: 'Data indisponível: a agenda da psicóloga está bloqueada neste período. Escolha outra data.',
};

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^\d{2}:\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
const dataLocal = (ymd, hhmm = '00:00', seg = 0) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, seg, 0);
};
const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} às ${pad(d.getHours())}:${pad(d.getMinutes())}`;

function lerDataHora(valor, campo = 'dataHora') {
  const d = new Date(valor);
  if (!valor || Number.isNaN(d.getTime())) throw invalido(`Informe ${campo} em formato ISO (ex.: 2026-10-05T10:00).`);
  d.setSeconds(0, 0);
  return d;
}

/** Psicólogo(a) cuja agenda o usuário enxerga: o próprio CRP, ou o(a) responsável pelo paciente. */
async function crpDaAgenda(conn, usuario, crpInformado) {
  if (usuario.tipo === 'psicologo') return crpInformado && usuario.isAdmin ? crpInformado : usuario.id;
  const [[p]] = await conn.query(
    `SELECT COALESCE(p.CRP_Psicologo_Aprovador,
            (SELECT c.CRP_Psicologo FROM Consulta c WHERE c.CPF_Paciente = p.CPF ORDER BY c.DataHora DESC LIMIT 1)) AS CRP
       FROM Paciente p WHERE p.CPF = ?`, [usuario.id]);
  if (!p || !p.CRP) throw naoEncontrado('Nenhum(a) psicólogo(a) responsável encontrado(a) para este paciente.');
  if (crpInformado && crpInformado !== p.CRP) throw proibido('Você só pode consultar a agenda do(a) seu(sua) psicólogo(a).');
  return p.CRP;
}

async function prazos(conn, crp) {
  const [[ps]] = await conn.query(
    `SELECT LimiteAlteracaoHoras, AntecedenciaAgendamentoHoras, AntecedenciaReagendamentoHoras,
            PrazoConfirmacaoHoras, LembreteConfirmacaoHoras FROM Psicologo WHERE CRP = ?`, [crp]);
  if (!ps) throw naoEncontrado('Psicólogo(a) não encontrado(a).');
  return ps;
}

/* ------------------------------------------------------------------ bloqueios */

/** Converte o corpo da requisição em período [inicio, fim]. */
function periodo({ diaInteiro = true, dataInicio, dataFim, horaInicio, horaFim }) {
  const inteiro = diaInteiro === true || diaInteiro === 'true' || diaInteiro === 1;
  if (!RE_DATA.test(dataInicio || '')) throw invalido('Informe dataInicio no formato AAAA-MM-DD.');
  let inicio, fim;
  if (inteiro) {
    const df = dataFim || dataInicio;
    if (!RE_DATA.test(df)) throw invalido('dataFim deve estar no formato AAAA-MM-DD.');
    inicio = dataLocal(dataInicio);
    fim = dataLocal(df, '23:59', 59);
  } else {
    if (!RE_HORA.test(horaInicio || '') || !RE_HORA.test(horaFim || '')) throw invalido('Informe horaInicio e horaFim no formato HH:MM.');
    inicio = dataLocal(dataInicio, horaInicio);
    fim = dataLocal(dataInicio, horaFim);
  }
  if (!(fim > inicio)) throw invalido('O fim do bloqueio deve ser posterior ao início.');
  return { inicio, fim, inteiro };
}

async function consultasNoPeriodo(conn, crp, inicio, fim) {
  const [linhas] = await conn.query(
    `SELECT c.ID_Consulta AS idConsulta, c.DataHora AS dataHora, c.DataHoraSugerida AS dataHoraSugerida, c.Status AS status,
            c.CPF_Paciente AS cpfPaciente, p.Nome AS paciente
       FROM Consulta c JOIN Paciente p ON p.CPF = c.CPF_Paciente
      WHERE c.CRP_Psicologo = ? AND c.Status IN (?) AND c.DataHoraFim > NOW()
        AND ((c.DataHora < ? AND c.DataHoraFim > ?)
          OR (c.Status = 'Aguardando_Paciente' AND c.DataHoraSugerida < ? AND c.DataHoraSugerida + INTERVAL c.DuracaoMin MINUTE > ?))
      ORDER BY c.DataHora`, [crp, ATIVAS, fim, inicio, fim, inicio]);
  return linhas;
}

export async function listarBloqueios(conn, usuario, { incluirPassados = false, crp } = {}) {
  const alvo = await crpDaAgenda(conn, usuario, crp);
  if (usuario.tipo === 'paciente') {
    // O paciente vê só o período indisponível — o motivo é privado da psicóloga
    const [l] = await conn.query(
      'SELECT ID_Bloqueio AS idBloqueio, Data_Inicio AS dataInicio, Data_Fim AS dataFim, DiaInteiro AS diaInteiro FROM vw_agenda_indisponivel WHERE CRP_Psicologo = ? ORDER BY Data_Inicio', [alvo]);
    return l.map((b) => ({ ...b, diaInteiro: !!b.diaInteiro }));
  }
  const [l] = await conn.query(
    `SELECT ID_Bloqueio AS idBloqueio, Data_Inicio AS dataInicio, Data_Fim AS dataFim, DiaInteiro AS diaInteiro, Motivo AS motivo,
            CriadoEm AS criadoEm, AtualizadoEm AS atualizadoEm,
            (SELECT COUNT(*) FROM Consulta c WHERE c.CRP_Psicologo = b.CRP_Psicologo AND c.Status IN (?)
                AND c.DataHoraFim > NOW() AND c.DataHora < b.Data_Fim AND c.DataHoraFim > b.Data_Inicio) AS consultasNoPeriodo
       FROM BloqueioAgenda b
      WHERE b.CRP_Psicologo = ? ${incluirPassados ? '' : 'AND b.Data_Fim > NOW()'}
      ORDER BY b.Data_Inicio`, [ATIVAS, alvo]);
  return l.map((b) => ({ ...b, diaInteiro: !!b.diaInteiro, consultasNoPeriodo: Number(b.consultasNoPeriodo) }));
}

/** Encerra as consultas atingidas por um bloqueio e avisa os pacientes. */
async function liberarAfetadas(conn, usuario, afetadas) {
  for (const c of afetadas) {
    const novo = c.status === 'Agendada' ? 'Cancelada' : 'Recusada';
    await conn.query(
      "UPDATE Consulta SET Status = ?, DataHoraSugerida = NULL, MotivoCancelamento = 'Agenda da psicóloga indisponível neste período' WHERE ID_Consulta = ?",
      [novo, c.idConsulta]);
    await conn.query('INSERT INTO Notificacao (DestinatarioId, Titulo, Mensagem, Tipo) VALUES (?, ?, ?, ?)', [
      c.cpfPaciente, novo === 'Cancelada' ? 'Consulta cancelada' : 'Solicitação não pôde ser atendida',
      `A agenda da psicóloga ficou indisponível em ${fmt(new Date(c.dataHora))}. Escolha um novo horário na Agenda.`, 'agenda_bloqueada']);
    await auditar(conn, usuario, 'CANCELAR_CONSULTA', `Consulta ${c.idConsulta} (${c.status}) liberada por bloqueio de agenda`);
  }
  return afetadas.length;
}

async function salvarBloqueio(conn, usuario, dados, id = null) {
  if (usuario.tipo !== 'psicologo') throw proibido('Apenas a psicóloga pode bloquear a agenda.');
  const { inicio, fim, inteiro } = periodo(dados);
  const motivo = String(dados.motivo ?? '').trim() || null;
  if (motivo && motivo.length > 255) throw invalido('O motivo pode ter no máximo 255 caracteres.');
  const crp = usuario.id;
  if (id != null) {
    const [[b]] = await conn.query('SELECT ID_Bloqueio FROM BloqueioAgenda WHERE ID_Bloqueio = ? AND CRP_Psicologo = ?', [id, crp]);
    if (!b) throw naoEncontrado('Bloqueio não encontrado.');
    await conn.query('UPDATE BloqueioAgenda SET Data_Inicio = ?, Data_Fim = ?, DiaInteiro = ?, Motivo = ? WHERE ID_Bloqueio = ?', [inicio, fim, inteiro, motivo, id]);
    await auditar(conn, usuario, 'EDITAR_BLOQUEIO', `Bloqueio ${id}: ${fmt(inicio)} a ${fmt(fim)}`);
  } else {
    const [r] = await conn.query('INSERT INTO BloqueioAgenda (CRP_Psicologo, Data_Inicio, Data_Fim, DiaInteiro, Motivo) VALUES (?, ?, ?, ?, ?)', [crp, inicio, fim, inteiro, motivo]);
    id = r.insertId; // a auditoria do INSERT é feita pelo TRG_Bloqueio_Auditoria_Insert
  }
  const afetadas = await consultasNoPeriodo(conn, crp, inicio, fim);
  const canceladas = dados.cancelarAfetadas ? await liberarAfetadas(conn, usuario, afetadas) : 0;
  const [[bloqueio]] = await conn.query(
    'SELECT ID_Bloqueio AS idBloqueio, Data_Inicio AS dataInicio, Data_Fim AS dataFim, DiaInteiro AS diaInteiro, Motivo AS motivo FROM BloqueioAgenda WHERE ID_Bloqueio = ?', [id]);
  return {
    bloqueio: { ...bloqueio, diaInteiro: !!bloqueio.diaInteiro },
    consultasNoPeriodo: canceladas ? [] : afetadas,
    canceladas,
  };
}

export const criarBloqueio = (conn, usuario, dados) => salvarBloqueio(conn, usuario, dados);
export const editarBloqueio = (conn, usuario, id, dados) => salvarBloqueio(conn, usuario, dados, id);

export async function removerBloqueio(conn, usuario, id) {
  if (usuario.tipo !== 'psicologo') throw proibido('Apenas a psicóloga pode remover bloqueios.');
  const [r] = await conn.query('DELETE FROM BloqueioAgenda WHERE ID_Bloqueio = ? AND CRP_Psicologo = ?', [id, usuario.id]);
  if (!r.affectedRows) throw naoEncontrado('Bloqueio não encontrado.');
}

/* ------------------------------------------------------------ disponibilidade */

/**
 * Horários de um dia com o motivo de cada indisponibilidade:
 * 'passado' | 'antecedencia' (paciente, < 48 h) | 'bloqueio' | 'ocupado'.
 */
export async function disponibilidade(conn, usuario, { data, mes, duracao = '60 min', ignorar, crp } = {}) {
  if (!DURACOES[duracao]) throw invalido("duracao deve ser '30 min', '60 min', '90 min' ou '120 min'.");
  const alvo = await crpDaAgenda(conn, usuario, crp);
  const pz = await prazos(conn, alvo);
  let dias;
  if (mes) {
    if (!/^\d{4}-\d{2}$/.test(mes)) throw invalido('mes deve estar no formato AAAA-MM.');
    const [y, m] = mes.split('-').map(Number);
    const total = new Date(y, m, 0).getDate();
    dias = Array.from({ length: total }, (_, i) => `${mes}-${pad(i + 1)}`);
  } else {
    if (!RE_DATA.test(data || '')) throw invalido('Informe data (AAAA-MM-DD) ou mes (AAAA-MM).');
    dias = [data];
  }
  const ini = dataLocal(dias[0]);
  const fim = dataLocal(dias[dias.length - 1], '23:59', 59);
  const [consultas] = await conn.query(
    `SELECT ID_Consulta, DataHora, DataHoraSugerida, DuracaoMin, Status FROM Consulta
      WHERE CRP_Psicologo = ? AND Status IN (?) AND (
            (DataHora < ? + INTERVAL 1 DAY AND DataHoraFim > ? - INTERVAL 1 DAY)
         OR (DataHoraSugerida IS NOT NULL AND DataHoraSugerida < ? + INTERVAL 1 DAY AND DataHoraSugerida > ? - INTERVAL 1 DAY))`,
    [alvo, ATIVAS, fim, ini, fim, ini]);
  const [bloqueios] = await conn.query('SELECT Data_Inicio, Data_Fim FROM BloqueioAgenda WHERE CRP_Psicologo = ? AND Data_Inicio < ? AND Data_Fim > ?', [alvo, fim, ini]);

  const ocupados = [];
  for (const c of consultas) {
    if (ignorar && c.ID_Consulta === Number(ignorar)) continue;
    ocupados.push([new Date(c.DataHora).getTime(), c.DuracaoMin]);
    if (c.Status === 'Aguardando_Paciente' && c.DataHoraSugerida) ocupados.push([new Date(c.DataHoraSugerida).getTime(), c.DuracaoMin]);
  }
  const blq = bloqueios.map((b) => [new Date(b.Data_Inicio).getTime(), new Date(b.Data_Fim).getTime()]);
  const paciente = usuario.tipo === 'paciente';
  const agora = Date.now();
  const minimo = agora + pz.AntecedenciaAgendamentoHoras * H;
  const dur = DURACOES[duracao] * 6e4, gap = INTERVALO_MIN * 6e4;

  const slotsDoDia = (ymd) => {
    const out = [];
    for (let t = EXPEDIENTE.inicio; t + DURACOES[duracao] <= EXPEDIENTE.fim; t += EXPEDIENTE.passo) {
      const hora = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      const a = dataLocal(ymd, hora).getTime(), z = a + dur;
      let motivo = null;
      if (a < agora) motivo = 'passado';
      else if (paciente && a < minimo) motivo = 'antecedencia';
      else if (blq.some(([bi, bf]) => bi < z && bf > a)) motivo = 'bloqueio';
      else if (ocupados.some(([oi, om]) => a === oi || (a < oi + om * 6e4 + gap && z + gap > oi))) motivo = 'ocupado';
      out.push({ hora, dataHora: new Date(a).toISOString(), livre: !motivo, motivo });
    }
    return out;
  };

  const resumoDia = (ymd) => {
    const slots = slotsDoDia(ymd);
    const livres = slots.filter((s) => s.livre).length;
    const semPassado = slots.filter((s) => s.motivo !== 'passado');
    let situacao;
    if (!semPassado.length) situacao = 'passado';
    else if (semPassado.every((s) => s.motivo === 'bloqueio')) situacao = 'bloqueado';
    else if (livres) situacao = semPassado.some((s) => s.motivo === 'bloqueio') ? 'parcial' : 'livre';
    else if (semPassado.some((s) => s.motivo === 'antecedencia')) situacao = 'antecedencia';
    else situacao = 'lotado';
    return { data: ymd, situacao, livres, slots };
  };

  const prazosOut = {
    antecedenciaAgendamentoHoras: pz.AntecedenciaAgendamentoHoras,
    antecedenciaReagendamentoHoras: pz.AntecedenciaReagendamentoHoras,
    prazoConfirmacaoHoras: pz.PrazoConfirmacaoHoras,
    limiteCancelamentoHoras: pz.LimiteAlteracaoHoras,
  };
  if (mes) return { mes, duracao, prazos: prazosOut, dias: dias.map((d) => { const { slots, ...r } = resumoDia(d); return r; }) };
  return { ...resumoDia(dias[0]), duracao, prazos: prazosOut };
}

/* ------------------------------------------------ solicitação e reagendamento */

export async function solicitar(conn, usuario, { dataHora, duracao = '60 min', modalidade = 'Online', observacoes = null } = {}) {
  if (usuario.tipo !== 'paciente') throw proibido('O agendamento é iniciado exclusivamente pelo paciente.');
  if (!DURACOES[duracao]) throw invalido("duracao deve ser '30 min', '60 min', '90 min' ou '120 min'.");
  if (!['Online', 'Presencial'].includes(modalidade)) throw invalido("modalidade deve ser 'Online' ou 'Presencial'.");
  const quando = lerDataHora(dataHora);
  const crp = await crpDaAgenda(conn, usuario);
  const pz = await prazos(conn, crp);
  if (quando.getTime() < Date.now() + pz.AntecedenciaAgendamentoHoras * H) {
    await auditar(pool, usuario, 'BLOQUEIO_ANTECEDENCIA_48H', `Tentativa para ${fmt(quando)}`, false); // fora da transação: a tentativa fica registrada
    throw invalido(MSG.agendamento(pz.AntecedenciaAgendamentoHoras), { regra: 'TRG_Antecedencia_Agendamento' });
  }
  const [r] = await conn.query(
    "INSERT INTO Consulta (DataHora, Duracao, Status, Modalidade, Solicitante, Observacoes, CPF_Paciente, CRP_Psicologo) VALUES (?, ?, 'Pendente', ?, 'Paciente', ?, ?, ?)",
    [quando, duracao, modalidade, observacoes ? String(observacoes).slice(0, 400) : null, usuario.id, crp]);
  await conn.query("INSERT INTO Notificacao (DestinatarioId, Titulo, Mensagem, Tipo) VALUES (?, 'Nova solicitação de agendamento', ?, 'solicitacao_pendente')",
    [crp, `${usuario.nome} solicitou consulta para ${fmt(quando)} (${modalidade}).`]);
  await auditar(conn, usuario, 'SOLICITAR_CONSULTA', `Consulta ${r.insertId} solicitada para ${fmt(quando)}`);
  return obterConsulta(conn, usuario, r.insertId);
}

async function consultaDoUsuario(conn, usuario, id) {
  const [[c]] = await conn.query('SELECT * FROM Consulta WHERE ID_Consulta = ?', [id]);
  if (!c) throw naoEncontrado('Consulta não encontrada.');
  const dono = usuario.tipo === 'paciente' ? c.CPF_Paciente === usuario.id : (usuario.isAdmin || c.CRP_Psicologo === usuario.id);
  if (!dono) throw proibido('Acesso negado: esta consulta pertence a outro usuário.');
  return c;
}

export async function obterConsulta(conn, usuario, id) {
  await consultaDoUsuario(conn, usuario, id);
  const [[c]] = await conn.query(
    `SELECT ID_Consulta AS idConsulta, DataHora AS dataHora, Duracao AS duracao, Status AS status, Modalidade AS modalidade,
            DataHoraSugerida AS dataHoraSugerida, StatusConfirmacao AS statusConfirmacao, PrazoConfirmacao AS prazoConfirmacao,
            ConfirmadaEm AS confirmadaEm, ConfirmadaPor AS confirmadaPor, ConfirmacaoTardia AS confirmacaoTardia,
            ReagendamentoBloqueado AS reagendamentoBloqueado, BloqueadaParaPaciente AS cancelamentoBloqueado, Paciente AS paciente
       FROM vw_agenda WHERE ID_Consulta = ?`, [id]);
  return { ...c, confirmacaoTardia: !!c.confirmacaoTardia, reagendamentoBloqueado: !!c.reagendamentoBloqueado, cancelamentoBloqueado: !!c.cancelamentoBloqueado };
}

/**
 * Reagendamento. Paciente: só com MAIS de 48 h para a consulta atual e o novo
 * horário respeita agora + 48 h; volta para "Pendente" (confirmação da psicóloga).
 * Psicóloga: remarca diretamente (bloqueios e choque continuam valendo).
 */
export async function remarcar(conn, usuario, id, { dataHora } = {}) {
  const c = await consultaDoUsuario(conn, usuario, id);
  if (!['Pendente', 'Agendada'].includes(c.Status)) throw invalido('Somente consultas pendentes ou confirmadas podem ser remarcadas.');
  const nova = lerDataHora(dataHora);
  if (usuario.tipo === 'paciente') {
    const pz = await prazos(conn, c.CRP_Psicologo);
    if (new Date(c.DataHora).getTime() - Date.now() <= pz.AntecedenciaReagendamentoHoras * H) {
      await auditar(pool, usuario, 'BLOQUEIO_REAGENDAMENTO_48H', `Consulta ${id}`, false);
      throw invalido(MSG.reagendamento(pz.AntecedenciaReagendamentoHoras), { regra: 'TRG_Limite_Alteracao_Agenda', codigo: 'REAGENDAMENTO_48H' });
    }
    if (nova.getTime() < Date.now() + pz.AntecedenciaAgendamentoHoras * H) throw invalido(MSG.agendamento(pz.AntecedenciaAgendamentoHoras));
  }
  // Triggers revalidam: bloqueio, choque/intervalo de 20 min, prazos do paciente e reinício da confirmação
  await conn.query(`UPDATE Consulta SET DataHora = ?${usuario.tipo === 'paciente' ? ", Status = 'Pendente'" : ''} WHERE ID_Consulta = ?`, [nova, id]);
  const destino = usuario.tipo === 'paciente' ? c.CRP_Psicologo : c.CPF_Paciente;
  await conn.query('INSERT INTO Notificacao (DestinatarioId, Titulo, Mensagem, Tipo) VALUES (?, ?, ?, ?)', [
    destino, usuario.tipo === 'paciente' ? 'Pedido de remarcação' : 'Consulta remarcada',
    `${usuario.tipo === 'paciente' ? `${usuario.nome} pediu para remarcar de ${fmt(new Date(c.DataHora))} para ${fmt(nova)}.` : `Sua consulta foi remarcada para ${fmt(nova)}.`}`,
    usuario.tipo === 'paciente' ? 'solicitacao_pendente' : 'consulta_confirmada']);
  await auditar(conn, usuario, 'REMARCAR_CONSULTA', `Consulta ${id}: ${fmt(new Date(c.DataHora))} → ${fmt(nova)}`);
  return obterConsulta(conn, usuario, id);
}

/* ------------------------------------------------ confirmação de presença (36 h) */

export async function confirmarPresenca(conn, usuario, id) {
  const c = await consultaDoUsuario(conn, usuario, id);
  if (c.Status !== 'Agendada') throw invalido('Só é possível confirmar presença em consultas já confirmadas pela psicóloga.');
  if (c.StatusConfirmacao === 'CONFIRMADA') throw invalido('A presença nesta consulta já foi confirmada.');
  // TRG_Consulta_Confirmacao_Update registra ConfirmadaEm, ConfirmadaPor e se foi após o prazo
  await conn.query("UPDATE Consulta SET StatusConfirmacao = 'CONFIRMADA' WHERE ID_Consulta = ?", [id]);
  const r = await obterConsulta(conn, usuario, id);
  const destino = usuario.tipo === 'paciente' ? c.CRP_Psicologo : c.CPF_Paciente;
  await conn.query("INSERT INTO Notificacao (DestinatarioId, Titulo, Mensagem, Tipo) VALUES (?, ?, ?, 'presenca_confirmada')", [
    destino, usuario.tipo === 'paciente' ? (r.confirmacaoTardia ? 'Presença confirmada após o prazo' : 'Presença confirmada') : 'Presença registrada',
    `Consulta de ${fmt(new Date(c.DataHora))}: presença confirmada${usuario.tipo === 'paciente' ? ` por ${usuario.nome}` : ' pela psicóloga'}.`]);
  await auditar(conn, usuario, 'CONFIRMAR_PRESENCA', `Consulta ${id} confirmada${r.confirmacaoTardia ? ' (após o prazo)' : ''}`);
  return r;
}

/** Painel da psicóloga: roda a automação e lista as consultas sem confirmação de presença. */
export async function listarConfirmacoes(conn, usuario, { situacao } = {}) {
  if (usuario.tipo !== 'psicologo') throw proibido('Painel exclusivo da psicóloga.');
  await conn.query('CALL sp_processar_confirmacoes()');
  const args = [usuario.id];
  let filtro = '';
  if (situacao) {
    if (!['AGUARDANDO', 'LEMBRETE', 'PENDENTE_CONFIRMACAO'].includes(situacao)) throw invalido('situacao inválida.');
    filtro = 'AND Situacao = ?'; args.push(situacao);
  }
  const [l] = await conn.query(
    `SELECT ID_Consulta AS idConsulta, DataHora AS dataHora, Duracao AS duracao, Modalidade AS modalidade, CPF_Paciente AS cpfPaciente,
            Paciente AS paciente, Telefone AS telefone, PrazoConfirmacao AS prazoConfirmacao, LembreteConfirmacaoEm AS lembreteEnviadoEm,
            Situacao AS situacao
       FROM vw_confirmacoes_pendentes WHERE CRP_Psicologo = ? ${filtro}
      ORDER BY FIELD(Situacao, 'PENDENTE_CONFIRMACAO', 'LEMBRETE', 'AGUARDANDO'), DataHora`, args);
  return l;
}
