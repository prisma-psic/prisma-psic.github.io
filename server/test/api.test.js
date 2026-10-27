/**
 * Testes de integração da API (node:test) contra um MySQL com o database/schema.sql recém-aplicado.
 *   mysql -u root -p -e "DROP DATABASE IF EXISTS prisma_db" && mysql -u root -p < ../database/schema.sql
 *   DB_USER=root DB_PASSWORD=... npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { criarApp } from '../src/app.js';
import { pool } from '../src/config/db.js';

let base, servidor, tokenPsi, tokenAna;
const ANA = '111.222.333-44';
const CRP = '06/12345';

async function api(metodo, rota, { token, json, form, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const r = await fetch(`${base}${rota}`, { method: metodo, headers, body });
  if (raw) return r;
  const texto = await r.text();
  return { status: r.status, corpo: texto ? JSON.parse(texto) : null };
}
const arquivo = (nome, conteudo, tipo = 'application/octet-stream') => {
  const f = new FormData();
  f.append('arquivo', new Blob([conteudo], { type: tipo }), nome);
  return f;
};

before(async () => {
  servidor = criarApp().listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(async () => { servidor.close(); await pool.end(); });

test('health', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.corpo.status, 'ok');
});

test('login: pendente bloqueado com a mensagem exigida; ativo recebe token', async () => {
  const pend = await api('POST', '/api/auth/login', { json: { email: 'lucas.almeida@email.com', senha: 'prisma123' } });
  assert.equal(pend.status, 403);
  assert.equal(pend.corpo.erro, 'Seu cadastro foi realizado com sucesso e está aguardando a aprovação do profissional de psicologia responsável.');
  const errada = await api('POST', '/api/auth/login', { json: { email: 'lucas.almeida@email.com', senha: 'errada123' } });
  assert.equal(errada.status, 401, 'senha errada não revela o status');

  const psi = await api('POST', '/api/auth/login', { json: { email: 'shelley.christina@prisma.com.br', senha: 'prisma123' } });
  assert.equal(psi.status, 200);
  tokenPsi = psi.corpo.token;
  const ana = await api('POST', '/api/auth/login', { json: { email: 'ana.carolina@email.com', senha: 'prisma123' } });
  tokenAna = ana.corpo.token;
  const [[h]] = await pool.query('SELECT SenhaHash FROM Psicologo WHERE CRP = ?', [CRP]);
  assert.match(h.SenhaHash, /^\$2[aby]\$/, 'hash legado migrado para bcrypt');
});

test('prontuário: exige autenticação e perfil de psicólogo', async () => {
  assert.equal((await api('GET', `/api/prontuario/paciente/${ANA}/sessoes`)).status, 401);
  assert.equal((await api('GET', `/api/prontuario/paciente/${ANA}/sessoes`, { token: tokenAna })).status, 403);
});

test('GET /api/prontuario/paciente/:cpf/sessoes — sub-navbar em ordem cronológica', async () => {
  const r = await api('GET', `/api/prontuario/paciente/${ANA}/sessoes`, { token: tokenPsi });
  assert.equal(r.status, 200);
  const rotulos = r.corpo.sessoes.map((s) => s.rotulo);
  assert.match(rotulos[0], /^Sessão #22 - \d\d\/\d\d$/);
  assert.match(rotulos[1], /^Sessão #24 - \d\d\/\d\d$/);
  assert.equal(rotulos.at(-1), 'Sessão Atual - Hoje');
  const datas = r.corpo.sessoes.map((s) => new Date(s.dataHora).getTime());
  assert.deepEqual(datas, [...datas].sort((a, b) => a - b));
  assert.equal(r.corpo.sessoes[1].qtdAnexos, 2);
});

test('GET /api/prontuario/sessao/:idConsulta — somente os dados daquela sessão', async () => {
  const s24 = await api('GET', '/api/prontuario/sessao/101', { token: tokenPsi });
  assert.equal(s24.status, 200);
  assert.equal(s24.corpo.sessao.numero, 24);
  assert.equal(s24.corpo.anotacao.numeroSessao, 24);
  assert.deepEqual(s24.corpo.anexos.map((a) => a.nomeArquivo), ['Registro de pensamentos - semana 24.txt', 'Plano de exposição gradual.txt']);
  assert.ok(s24.corpo.historico.length >= 3);
  const s22 = await api('GET', '/api/prontuario/sessao/95', { token: tokenPsi });
  assert.equal(s22.corpo.anexos.length, 0, 'anexos de outra sessão não aparecem');
  assert.equal((await api('GET', '/api/prontuario/sessao/999999', { token: tokenPsi })).status, 404);
});

test('POST anexo — upload .txt/.pdf/.docx, validação de assinatura e de sessão', async () => {
  const txt = await api('POST', '/api/prontuario/sessao/95/anexo', { token: tokenPsi, form: arquivo('Anotação externa.txt', 'Linha com acentuação: ção\n', 'text/plain') });
  assert.equal(txt.status, 201, JSON.stringify(txt.corpo));
  assert.equal(txt.corpo.nomeArquivo, 'Anotação externa.txt');
  assert.equal(txt.corpo.versao, 1);

  const pdf = await api('POST', '/api/prontuario/sessao/95/anexo', { token: tokenPsi, form: arquivo('relatorio.pdf', '%PDF-1.4\n%%EOF\n', 'application/pdf') });
  assert.equal(pdf.status, 201);
  const docx = await api('POST', '/api/prontuario/sessao/95/anexo', { token: tokenPsi, form: arquivo('plano.docx', Buffer.from([0x50, 0x4B, 0x03, 0x04, 1, 2, 3])) });
  assert.equal(docx.status, 201);

  const falso = await api('POST', '/api/prontuario/sessao/95/anexo', { token: tokenPsi, form: arquivo('virus.pdf', Buffer.from('MZ\x90\x00executavel'), 'application/pdf') });
  assert.equal(falso.status, 422);
  assert.match(falso.corpo.erro, /não corresponde/);
  assert.equal((await api('POST', '/api/prontuario/sessao/95/anexo', { token: tokenPsi, form: arquivo('script.exe', 'MZ') })).status, 422);

  const futura = await api('POST', '/api/prontuario/sessao/105/anexo', { token: tokenPsi, form: arquivo('a.txt', 'x') });
  assert.equal(futura.status, 422, 'sessão futura recusada pelo TRG_Anexo_Valida');

  const nota = await api('POST', '/api/prontuario/sessao/95/anexo', { token: tokenPsi, json: { nomeArquivo: 'Observações', conteudoTexto: 'Texto livre' } });
  assert.equal(nota.status, 201);
  assert.equal(nota.corpo.nomeArquivo, 'Observações.txt');

  const s = await api('GET', '/api/prontuario/sessao/95', { token: tokenPsi });
  assert.equal(s.corpo.anexos.length, 4);
  assert.ok(s.corpo.historico.some((h) => h.acao === 'ANEXO_ENVIADO' && h.detalhes === 'Anotação externa.txt'));
});

test('download, edição de .txt (nova versão) e remoção lógica', async () => {
  const s = await api('GET', '/api/prontuario/sessao/95', { token: tokenPsi });
  const txt = s.corpo.anexos.find((a) => a.nomeArquivo === 'Anotação externa.txt');

  const d = await api('GET', `/api/prontuario/anexo/${txt.idAnexo}/download`, { token: tokenPsi, raw: true });
  assert.equal(d.status, 200);
  assert.match(d.headers.get('content-disposition'), /filename\*=UTF-8''Anota%C3%A7%C3%A3o/);
  assert.equal(await d.text(), 'Linha com acentuação: ção\n');

  const ed = await api('PUT', `/api/prontuario/anexo/${txt.idAnexo}`, { token: tokenPsi, json: { conteudoTexto: 'Conteúdo editado\n' } });
  assert.equal(ed.status, 200);
  assert.equal(ed.corpo.versao, 2);
  const d2 = await api('GET', `/api/prontuario/anexo/${txt.idAnexo}/download`, { token: tokenPsi, raw: true });
  assert.equal(await d2.text(), 'Conteúdo editado\n');

  const pdf = s.corpo.anexos.find((a) => a.extensao === 'pdf');
  const trocaErrada = await api('PUT', `/api/prontuario/anexo/${pdf.idAnexo}`, { token: tokenPsi, form: arquivo('outro.txt', 'x') });
  assert.equal(trocaErrada.status, 422, 'nova versão precisa ter a mesma extensão');

  assert.equal((await api('DELETE', `/api/prontuario/anexo/${pdf.idAnexo}`, { token: tokenPsi, json: { motivo: 'Enviado por engano' } })).status, 204);
  const depois = await api('GET', '/api/prontuario/sessao/95', { token: tokenPsi });
  assert.ok(!depois.corpo.anexos.some((a) => a.idAnexo === pdf.idAnexo));
  assert.ok(depois.corpo.historico.some((h) => h.acao === 'ANEXO_REMOVIDO'));
  assert.ok(depois.corpo.historico.some((h) => h.acao === 'ANEXO_EDITADO' && /versão 2/.test(h.detalhes)));
  await assert.rejects(pool.query('DELETE FROM Registro_Clinico_Anexo WHERE ID_Anexo = ?', [pdf.idAnexo]), /não são excluídos/);
});

test('PUT anotação — cria a anotação da sessão atual', async () => {
  const sessoes = await api('GET', `/api/prontuario/paciente/${ANA}/sessoes`, { token: tokenPsi });
  const atual = sessoes.corpo.sessoes.at(-1);
  const r = await api('PUT', `/api/prontuario/sessao/${atual.idConsulta}/anotacao`, { token: tokenPsi, json: { queixaPrincipal: 'Relata melhora', tarefasParaCasa: '1. RPD', tags: ['ansiedade'] } });
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.equal(r.corpo.queixaPrincipal, 'Relata melhora');
  const s = await api('GET', `/api/prontuario/sessao/${atual.idConsulta}`, { token: tokenPsi });
  assert.ok(s.corpo.historico.some((h) => h.acao === 'REGISTRO_CRIADO'));
});

test('chat: ordem ascendente, nova mensagem no final e sem resposta automática', async () => {
  const antes = await api('GET', `/api/chat/mensagens/${ANA}`, { token: tokenPsi });
  assert.equal(antes.status, 200);
  const t = antes.corpo.mensagens.map((m) => new Date(m.dataEnviado).getTime());
  assert.deepEqual(t, [...t].sort((a, b) => a - b), 'ORDER BY DataEnviado ASC');

  const enviada = await api('POST', '/api/chat/mensagens', { token: tokenPsi, json: { destinatario: ANA, texto: 'Mensagem de teste da API' } });
  assert.equal(enviada.status, 201);
  await new Promise((r) => setTimeout(r, 1500)); // nenhuma resposta sintética deve surgir
  const depois = await api('GET', `/api/chat/mensagens/${ANA}`, { token: tokenPsi });
  assert.equal(depois.corpo.mensagens.length, antes.corpo.mensagens.length + 1);
  assert.equal(depois.corpo.mensagens.at(-1).texto, 'Mensagem de teste da API', 'mais recente no final');

  const novas = await api('GET', `/api/chat/mensagens/${encodeURIComponent(CRP)}?depoisDe=${enviada.corpo.idMensagem - 1}`, { token: tokenAna });
  assert.equal(novas.corpo.mensagens.length, 1);
  assert.equal((await api('GET', '/api/chat/mensagens/222.333.444-55', { token: tokenAna })).status, 403, 'paciente não lê conversa de outro paciente');
  assert.equal((await api('PATCH', `/api/chat/mensagens/${encodeURIComponent(CRP)}/lidas`, { token: tokenAna })).corpo.marcadas >= 1, true);
});

test('arquivos internos não são servidos pelo servidor estático', async () => {
  assert.equal((await fetch(`${base}/server/.env.example`)).status, 404);
  assert.equal((await fetch(`${base}/database/schema.sql`)).status, 404);
  assert.equal((await fetch(`${base}/index.html`)).status, 200);
});
