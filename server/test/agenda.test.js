/**
 * Testes de integração da AGENDA (bloqueios, 48 h e confirmação de 36 h).
 * Requer um banco recém-criado com os dados de demonstração:
 *   mysql -u root -p -e "DROP DATABASE IF EXISTS prisma_db" && mysql -u root -p < ../database/schema.sql && npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { criarApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

let base, servidor, psi, ana, bruno, idBloqueio, idNova;
const MSG_REAG = 'Reagendamentos só podem ser realizados com pelo menos 48 horas de antecedência. Entre em contato diretamente com a psicóloga.';

async function api(metodo, rota, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${base}${rota}`, { method: metodo, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  const t = await r.text();
  return { status: r.status, corpo: t ? JSON.parse(t) : null };
}
const pad = (n) => String(n).padStart(2, '0');
const dia = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const login = async (email) => (await api('POST', '/api/auth/login', { json: { email, senha: 'prisma123' } })).corpo.token;

before(async () => {
  servidor = criarApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  psi = await login('shelley.christina@prisma.com.br');
  ana = await login('ana.carolina@email.com');
  bruno = await login('bruno.ferreira@email.com');
});
after(async () => { servidor.close(); await pool.end(); });

test('bloqueios: psicóloga vê o motivo; paciente vê só o período', async () => {
  const p = await api('GET', '/api/agenda/bloqueios', { token: psi });
  assert.equal(p.status, 200);
  assert.equal(p.corpo.length, 3);
  assert.ok(p.corpo.some((b) => b.motivo === 'Congresso Brasileiro de Psicologia'));
  const a = await api('GET', '/api/agenda/bloqueios', { token: ana });
  assert.equal(a.corpo.length, 3);
  assert.ok(a.corpo.every((b) => !('motivo' in b)), 'motivo é privado');
});

test('bloqueios: criar, validar sobreposição/passado/perfil, editar e remover', async () => {
  const r = await api('POST', '/api/agenda/bloqueios', { token: psi, json: { diaInteiro: true, dataInicio: dia(20), dataFim: dia(21), motivo: 'Férias' } });
  assert.equal(r.status, 201);
  idBloqueio = r.corpo.bloqueio.idBloqueio;
  const sob = await api('POST', '/api/agenda/bloqueios', { token: psi, json: { diaInteiro: false, dataInicio: dia(21), horaInicio: '10:00', horaFim: '12:00' } });
  assert.equal(sob.status, 422);
  assert.match(sob.corpo.erro, /Já existe um bloqueio/);
  const pas = await api('POST', '/api/agenda/bloqueios', { token: psi, json: { dataInicio: dia(-3) } });
  assert.equal(pas.status, 422);
  const inv = await api('POST', '/api/agenda/bloqueios', { token: psi, json: { diaInteiro: false, dataInicio: dia(30), horaInicio: '14:00', horaFim: '13:00' } });
  assert.equal(inv.status, 422);
  const pac = await api('POST', '/api/agenda/bloqueios', { token: ana, json: { dataInicio: dia(30) } });
  assert.equal(pac.status, 403);
  const ed = await api('PUT', `/api/agenda/bloqueios/${idBloqueio}`, { token: psi, json: { diaInteiro: false, dataInicio: dia(20), horaInicio: '13:00', horaFim: '18:00', motivo: 'Compromisso pessoal' } });
  assert.equal(ed.status, 200);
  assert.equal(ed.corpo.bloqueio.diaInteiro, false);
});

test('disponibilidade: dia bloqueado, parcial e dentro das 48 h', async () => {
  const mes = dia(9).slice(0, 7);
  const m = await api('GET', `/api/agenda/disponibilidade?mes=${mes}`, { token: ana });
  assert.equal(m.status, 200);
  assert.equal(m.corpo.dias.find((d) => d.data === dia(9)).situacao, 'bloqueado');
  const amanha = await api('GET', `/api/agenda/disponibilidade?data=${dia(1)}`, { token: ana });
  assert.equal(amanha.corpo.livres, 0);
  assert.ok(amanha.corpo.slots.filter((s) => s.motivo !== 'passado').every((s) => s.motivo === 'antecedencia'));
  const psiAmanha = await api('GET', `/api/agenda/disponibilidade?data=${dia(1)}`, { token: psi });
  assert.ok(psiAmanha.corpo.livres > 0, 'a regra de 48 h vale só para o paciente');
  const parcial = await api('GET', `/api/agenda/disponibilidade?data=${dia(20)}`, { token: ana });
  assert.equal(parcial.corpo.situacao, 'parcial');
  assert.equal(parcial.corpo.slots.find((s) => s.hora === '14:00').motivo, 'bloqueio');
});

test('solicitação: mínimo de 48 h e sem dias bloqueados', async () => {
  const perto = new Date(Date.now() + 30 * 36e5).toISOString();
  const r1 = await api('POST', '/api/agenda/consultas', { token: ana, json: { dataHora: perto } });
  assert.equal(r1.status, 422);
  assert.match(r1.corpo.erro, /pelo menos 48 horas/);
  const r2 = await api('POST', '/api/agenda/consultas', { token: ana, json: { dataHora: `${dia(9)}T10:00` } });
  assert.equal(r2.status, 422);
  assert.match(r2.corpo.erro, /agenda da psicóloga está bloqueada/);
  const r3 = await api('POST', '/api/agenda/consultas', { token: ana, json: { dataHora: `${dia(25)}T10:00`, modalidade: 'Online' } });
  assert.equal(r3.status, 201);
  assert.equal(r3.corpo.status, 'Pendente');
  idNova = r3.corpo.idConsulta;
});

test('reagendamento: bloqueado a menos de 48 h com a mensagem exigida', async () => {
  const r = await api('PATCH', '/api/agenda/consultas/104/remarcar', { token: ana, json: { dataHora: `${dia(26)}T10:00` } });
  assert.equal(r.status, 422);
  assert.equal(r.corpo.erro, MSG_REAG);
  assert.equal(r.corpo.codigo, 'REAGENDAMENTO_48H');
  const ok = await api('PATCH', `/api/agenda/consultas/${idNova}/remarcar`, { token: ana, json: { dataHora: `${dia(26)}T11:00` } });
  assert.equal(ok.status, 200);
  assert.equal(ok.corpo.status, 'Pendente');
  const outro = await api('PATCH', `/api/agenda/consultas/${idNova}/remarcar`, { token: bruno, json: { dataHora: `${dia(27)}T11:00` } });
  assert.equal(outro.status, 403);
});

test('confirmação de presença: painel PENDENTE_CONFIRMACAO e confirmação tardia', async () => {
  const p = await api('GET', '/api/agenda/confirmacoes', { token: psi });
  assert.equal(p.status, 200);
  const c104 = p.corpo.find((c) => c.idConsulta === 104);
  assert.equal(c104.situacao, 'PENDENTE_CONFIRMACAO');
  assert.equal(p.corpo[0].situacao, 'PENDENTE_CONFIRMACAO', 'vencidas primeiro');
  const alheia = await api('POST', '/api/agenda/consultas/105/confirmar-presenca', { token: ana });
  assert.equal(alheia.status, 403);
  const conf = await api('POST', '/api/agenda/consultas/104/confirmar-presenca', { token: ana });
  assert.equal(conf.status, 200);
  assert.equal(conf.corpo.statusConfirmacao, 'CONFIRMADA');
  assert.equal(conf.corpo.confirmadaPor, 'Paciente');
  assert.equal(conf.corpo.confirmacaoTardia, true);
  const dup = await api('POST', '/api/agenda/consultas/104/confirmar-presenca', { token: ana });
  assert.equal(dup.status, 422);
  const depois = await api('GET', '/api/agenda/confirmacoes?situacao=PENDENTE_CONFIRMACAO', { token: psi });
  assert.ok(!depois.corpo.some((c) => c.idConsulta === 104));
  const pac = await api('GET', '/api/agenda/confirmacoes', { token: ana });
  assert.equal(pac.status, 403);
});

test('bloqueio: remover libera o período', async () => {
  const r = await api('DELETE', `/api/agenda/bloqueios/${idBloqueio}`, { token: psi });
  assert.equal(r.status, 204);
  const d = await api('GET', `/api/agenda/disponibilidade?data=${dia(20)}`, { token: ana });
  assert.equal(d.corpo.situacao, 'livre');
  const [[a]] = await pool.query("SELECT COUNT(*) AS n FROM Auditoria WHERE Acao IN ('BLOQUEAR_AGENDA','EDITAR_BLOQUEIO','REMOVER_BLOQUEIO')");
  assert.ok(a.n >= 6);
});
