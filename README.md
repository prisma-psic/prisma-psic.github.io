Como executar o PRISMA
Há duas formas de rodar o projeto:
Modo
	Para quê
	Precisa instalar
	A. Só o front-end
	Ver e testar todas as telas
	Nada (só um navegador)
	B. Front-end + API + banco
	Rodar o sistema com o MySQL e a API REST
	MySQL 8.4 e Node.js 22.9+
	Os comandos abaixo foram escritos para Windows e funcionam no Prompt de Comando (cmd) e no terminal do VS Code. As diferenças no PowerShell, Linux e macOS estão indicadas.
________________


A. Só o front-end (sem instalar nada)
1. Abra a pasta prisma-app.
2. Dê dois cliques em index.html. Ele abre no navegador e leva para a tela de login.
3. Entre com uma conta de demonstração. A senha de todas é prisma123:
E-mail
	Perfil
	shelley.christina@prisma.com.br
	Psicóloga (administradora)
	ana.carolina@email.com
	Paciente
	lucas.almeida@email.com
	Paciente aguardando aprovação (o login é bloqueado de propósito)
	Os dados ficam salvos no próprio navegador. Para voltar aos dados iniciais, entre como psicóloga e use Configurações → Privacidade → Restaurar dados de demonstração.
Para testar o chat em tempo real, abra uma janela normal (psicóloga) e uma janela anônima (paciente).
Se o navegador bloquear algo ao abrir por file://, use um servidor local dentro da pasta prisma-app: npx serve . (e abra o endereço mostrado) ou python -m http.server 8080 (e abra http://localhost:8080).
________________


B. Front-end + API + banco de dados
1. Instale os pré-requisitos
* MySQL 8.4 LTS: https://dev.mysql.com/downloads/installer/
   * Na instalação, anote a senha do usuário root.
   * Se o comando mysql não for reconhecido no terminal, adicione C:\Program Files\MySQL\MySQL Server 8.4\bin ao PATH do Windows e abra um terminal novo.
* Node.js 22.9 ou mais recente: https://nodejs.org/. Confira a versão com:
node -v
2. Crie o banco de dados
Abra um terminal na pasta prisma-app e rode:
mysql -u root -p < database\schema.sql
PowerShell não aceita o <. Use: Get-Content database\schema.sql -Encoding UTF8 | mysql -u root -p --default-character-set=utf8mb4
Linux/macOS: mysql -u root -p < database/schema.sql
O que esse script faz:
* cria o banco prisma_db com tabelas, triggers, views, o evento de confirmação e os dados de demonstração;
* não apaga dados: se o banco já existir, ele só atualiza a estrutura e mantém os registros. Pode rodar de novo sempre que o schema.sql mudar.
Para recomeçar do zero com os dados de demonstração (apaga tudo, use só em desenvolvimento):
mysql -u root -p -e "DROP DATABASE prisma_db"
mysql -u root -p < database\schema.sql
3. Crie um usuário do MySQL para a API (recomendado)
Não é obrigatório, mas é melhor que a API não use o root. Entre no MySQL com mysql -u root -p e rode (troque a senha):
CREATE USER 'prisma_api'@'localhost' IDENTIFIED BY 'SuaSenhaForte123!';
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE, CREATE TEMPORARY TABLES ON prisma_db.* TO 'prisma_api'@'localhost';
Saia com exit.
4. Configure a API
Na pasta prisma-app\server:
cd server
copy .env.example .env
PowerShell: Copy-Item .env.example .env · Linux/macOS: cp .env.example .env
Abra o arquivo .env e ajuste:
Variável
	O que colocar
	DB_USER / DB_PASSWORD
	O usuário do passo 3, ou root e a sua senha
	DB_HOST / DB_PORT
	Normalmente 127.0.0.1 e 3306
	JWT_SECRET
	Um texto longo e aleatório (gere com o comando indicado no próprio arquivo)
	PORT
	Porta da API (padrão 3000)
	SERVIR_FRONTEND
	true para a API também abrir as telas no navegador
	5. Instale as dependências e inicie
Ainda na pasta server:
npm install
npm start
Deve aparecer [PRISMA API] ouvindo em http://localhost:3000. O npm start já carrega o .env sozinho.
Com o servidor rodando:
* Sistema: abra http://localhost:3000 e entre com as contas de demonstração (senha prisma123).
* Verificar a conexão com o banco: http://localhost:3000/api/health deve responder {"status":"ok", ...}.
* Parar o servidor: Ctrl + C no terminal.
Para desenvolver, o npm run dev reinicia o servidor a cada alteração de arquivo.
Importante: as telas ainda guardam os dados no navegador, como no modo A. A API e o banco já implementam as mesmas regras e rotas (lista completa no README.md), mas as telas ainda não chamam a API. Para testar as rotas diretamente, use Postman, Insomnia ou a extensão REST Client do VS Code. Faça login em POST /api/auth/login e envie o token no cabeçalho Authorization: Bearer <token>.
________________


Testes
Regras de negócio (no navegador). Entre como psicóloga, abra Testes → Validação do sistema e clique para executar os casos CT01 a CT11. Eles rodam numa cópia dos dados e não alteram nada.
API (integração, 17 testes). Os testes usam os dados de demonstração, por isso recrie o banco antes. Com o .env configurado, na pasta server:
mysql -u root -p -e "DROP DATABASE prisma_db"
mysql -u root -p < ..\database\schema.sql
npm test
O resultado esperado é # pass 17 e # fail 0.
________________


Problemas comuns
Sintoma
	Solução
	'mysql' não é reconhecido como comando
	Adicione a pasta bin do MySQL ao PATH (passo 1) ou use o MySQL Command Line Client
	ERROR 1045 Access denied
	Usuário ou senha errados no comando ou no .env
	/api/health responde Banco de dados indisponível
	O MySQL está parado ou DB_HOST/DB_PORT estão errados. No Windows, confira em Serviços se o MySQL84 está em execução
	EADDRINUSE: address already in use :::3000
	A porta já está em uso: mude PORT no .env ou feche o outro programa
	Erro com --env-file-if-exists
	O Node está desatualizado: instale a versão 22.9 ou mais recente
	Acentos aparecem como ? no terminal do MySQL
	Rode o mysql com --default-character-set=utf8mb4. Os dados no banco estão corretos
	Lembretes de confirmação (36 h) não são gerados sozinhos
	Ligue o agendador de eventos com SET GLOBAL event_scheduler = ON;. Ele já vem ligado por padrão no MySQL 8.4
	Login bloqueado por "muitas tentativas"
	Espere 5 minutos. É a proteção contra força bruta
	Os testes da API falham depois de usar o sistema
	Recrie o banco (comandos da seção Testes) antes do npm test
