-- =========================================================================
-- PRISMA — Plataforma de Registro, Interação e Suporte de Metas Assistidas
-- DDL para MySQL 8.4 LTS: tabelas, restrições, triggers, views e dados iniciais
--
-- Execução:   mysql -u root -p < database/schema.sql
--
-- O SCRIPT NÃO APAGA DADOS. Pode ser executado quantas vezes for preciso:
--   • banco inexistente/vazio → cria tudo e carrega os dados de demonstração;
--   • banco já existente (inclusive de versões anteriores do PRISMA) → cria
--     apenas as tabelas/colunas/restrições que faltam, recria rotinas,
--     triggers, views e o evento, e NÃO altera nem duplica os registros.
--   Para recomeçar do zero (somente em desenvolvimento), apague o banco à mão:
--     mysql -u root -p -e 'DROP DATABASE prisma_db'
--
-- Convenções
--   • Nomes de tabelas/colunas seguem o dicionário de dados do projeto
--     (Psicologo, Paciente, Consulta, Registro_Clinico, Metas, Documentos,
--      Laudos_Atestados, Mensagem) + tabelas de apoio desta versão
--     (Meta_Checklist_Item, Notificacao, Teste_Psicologico, Teste_Faixa,
--      Aplicacao_Teste, Auditoria).
--   • Datas/horas em DATETIME (armazenadas em horário local do consultório).
--   • Regra de limite de alteração (24 h configuráveis): a aplicação informa
--     o perfil da sessão antes de alterar consultas:
--         SET @prisma_usuario_tipo = 'paciente';   -- ou 'psicologo'
--     O trigger TRG_Limite_Alteracao_Agenda usa essa variável.
--   • Agenda (seções 2.1 e 6.15): dias/horários bloqueados pela psicóloga
--     (BloqueioAgenda), agendamento pelo paciente com no mínimo 48 h,
--     reagendamento só com mais de 48 h e confirmação de presença até 36 h
--     antes (EVT_Confirmacao_Presenca → StatusConfirmacao 'PENDENTE_CONFIRMACAO').
--   • Toda violação de regra de negócio gera SIGNAL SQLSTATE '45000'.
--   • Autenticação: todo paciente se cadastra com Status 'PENDENTE_APROVACAO'
--     e só entra após ser aprovado por um psicólogo ATIVO (seção 6.11).
--     SenhaHash guarda apenas o hash (protótipo: SHA-256 com salt; no servidor
--     de produção use bcrypt/argon2).
-- =========================================================================

CREATE DATABASE IF NOT EXISTS prisma_db CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE prisma_db;

SET NAMES utf8mb4;
SET time_zone = '-03:00';

-- =========================================================================
-- 0. APOIO À ATUALIZAÇÃO SEM PERDA DE DADOS
--    Rotinas auxiliares (removidas no fim do script) que só criam o que falta.
-- =========================================================================
-- Estado do banco ANTES deste script (usado nos ajustes de dados da seção 4.2)
SET @prisma_havia_sessao_historico = (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Sessao_Historico');

DELIMITER $$

DROP PROCEDURE IF EXISTS prisma_ddl$$
CREATE PROCEDURE prisma_ddl(IN p_sql TEXT)
BEGIN
  SET @prisma_sql = p_sql;
  PREPARE st FROM @prisma_sql;
  EXECUTE st;
  DEALLOCATE PREPARE st;
END$$

-- Adiciona a coluna somente se a tabela existir e a coluna ainda não existir
DROP PROCEDURE IF EXISTS prisma_add_coluna$$
CREATE PROCEDURE prisma_add_coluna(IN p_tabela VARCHAR(64), IN p_coluna VARCHAR(64), IN p_def TEXT, OUT p_criada BOOLEAN)
BEGIN
  SET p_criada = FALSE;
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_tabela AND COLUMN_NAME = p_coluna) THEN
    CALL prisma_ddl(CONCAT('ALTER TABLE `', p_tabela, '` ADD COLUMN `', p_coluna, '` ', p_def));
    SET p_criada = TRUE;
  END IF;
END$$

-- Adiciona CHECK / UNIQUE / FOREIGN KEY somente se ainda não existir
DROP PROCEDURE IF EXISTS prisma_add_restricao$$
CREATE PROCEDURE prisma_add_restricao(IN p_tabela VARCHAR(64), IN p_nome VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
                 WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = p_tabela AND CONSTRAINT_NAME = p_nome) THEN
    CALL prisma_ddl(CONCAT('ALTER TABLE `', p_tabela, '` ADD CONSTRAINT `', p_nome, '` ', p_def));
  END IF;
END$$

-- Recria um CHECK cuja lista de valores cresceu entre versões
DROP PROCEDURE IF EXISTS prisma_trocar_check$$
CREATE PROCEDURE prisma_trocar_check(IN p_tabela VARCHAR(64), IN p_nome VARCHAR(64), IN p_def TEXT)
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = p_tabela AND CONSTRAINT_NAME = p_nome) THEN
    CALL prisma_ddl(CONCAT('ALTER TABLE `', p_tabela, '` DROP CHECK `', p_nome, '`'));
  END IF;
  CALL prisma_ddl(CONCAT('ALTER TABLE `', p_tabela, '` ADD CONSTRAINT `', p_nome, '` ', p_def));
END$$

-- Cria o índice somente se ainda não existir
DROP PROCEDURE IF EXISTS prisma_add_indice$$
CREATE PROCEDURE prisma_add_indice(IN p_tabela VARCHAR(64), IN p_nome VARCHAR(64), IN p_colunas TEXT)
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_tabela AND INDEX_NAME = p_nome) THEN
    CALL prisma_ddl(CONCAT('CREATE INDEX `', p_nome, '` ON `', p_tabela, '` (', p_colunas, ')'));
  END IF;
END$$

DELIMITER ;

-- =========================================================================
-- 1. TABELAS PRINCIPAIS
-- =========================================================================

CREATE TABLE IF NOT EXISTS Psicologo (
  CRP                   VARCHAR(20)   NOT NULL,
  Nome                  VARCHAR(150)  NOT NULL,
  Especialidade         VARCHAR(100)  NULL,
  Abordagem             VARCHAR(100)  NULL,
  Email                 VARCHAR(100)  NOT NULL,
  Telefone              VARCHAR(20)   NULL,
  CPF                   VARCHAR(14)   NULL,
  Consultorio           VARCHAR(255)  NULL,
  Bio                   VARCHAR(500)  NULL,
  LimiteAlteracaoHoras  INT           NOT NULL DEFAULT 24 COMMENT 'Antecedência mínima para o paciente CANCELAR consulta confirmada',
  AntecedenciaAgendamentoHoras    INT NOT NULL DEFAULT 48 COMMENT 'Paciente só agenda a partir de NOW() + X horas',
  AntecedenciaReagendamentoHoras  INT NOT NULL DEFAULT 48 COMMENT 'Paciente só reagenda se faltarem MAIS de X horas',
  PrazoConfirmacaoHoras           INT NOT NULL DEFAULT 36 COMMENT 'Presença confirmada até X horas antes',
  LembreteConfirmacaoHoras        INT NOT NULL DEFAULT 24 COMMENT 'Lembrete enviado X horas antes do prazo de confirmação',
  -- Autenticação e aprovação (psicólogos cadastrados pela clínica já nascem ATIVOS;
  -- o autocadastro de profissional é criado como PENDENTE e validado por um administrador)
  Status                   VARCHAR(20)   NOT NULL DEFAULT 'ATIVO',
  IsAdmin                  BOOLEAN       NOT NULL DEFAULT FALSE,
  SenhaHash                VARCHAR(255)  NOT NULL,
  Data_Solicitacao         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Data_Aprovacao           DATETIME      NULL,
  CRP_Psicologo_Aprovador  VARCHAR(20)   NULL,
  MotivoRejeicao           VARCHAR(255)  NULL,
  UltimoLogin              DATETIME      NULL,
  CONSTRAINT PK_Psicologo PRIMARY KEY (CRP),            -- CRP é chave primária (já é único)
  CONSTRAINT UQ_Psicologo_Email UNIQUE (Email),
  CONSTRAINT UQ_Psicologo_CPF UNIQUE (CPF),
  CONSTRAINT FK_Psicologo_Aprovador FOREIGN KEY (CRP_Psicologo_Aprovador) REFERENCES Psicologo (CRP) ON DELETE SET NULL,
  CONSTRAINT CHK_Status_Psicologo CHECK (Status IN ('PENDENTE_APROVACAO','ATIVO','REJEITADO','INATIVO')),
  CONSTRAINT CHK_LimiteAlteracao CHECK (LimiteAlteracaoHoras BETWEEN 0 AND 168),
  CONSTRAINT CHK_AntecedenciaAgendamento   CHECK (AntecedenciaAgendamentoHoras BETWEEN 0 AND 336),
  CONSTRAINT CHK_AntecedenciaReagendamento CHECK (AntecedenciaReagendamentoHoras BETWEEN 0 AND 336),
  CONSTRAINT CHK_PrazoConfirmacao          CHECK (PrazoConfirmacaoHoras BETWEEN 1 AND 168),
  CONSTRAINT CHK_LembreteConfirmacao       CHECK (LembreteConfirmacaoHoras BETWEEN 1 AND 168),
  CONSTRAINT CHK_Psicologo_Email CHECK (Email LIKE '%_@_%._%')
) ENGINE=InnoDB COMMENT='Profissional responsável e prazos da agenda (cancelamento, agendamento, reagendamento e confirmação)';

CREATE TABLE IF NOT EXISTS Paciente (
  CPF                VARCHAR(14)   NOT NULL,
  Nome               VARCHAR(150)  NOT NULL,
  Email              VARCHAR(100)  NOT NULL,
  Telefone           VARCHAR(20)   NULL,
  DataNascimento     DATE          NULL,
  QueixaPrincipal    VARCHAR(255)  NULL,
  ConsentimentoLGPD  BOOLEAN       NOT NULL DEFAULT FALSE,
  DataConsentimento  DATETIME      NULL,
  -- Autenticação e aprovação obrigatória pelo profissional
  Status                   VARCHAR(20)   NOT NULL DEFAULT 'PENDENTE_APROVACAO',
  Data_Solicitacao         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Data_Aprovacao           DATETIME      NULL,
  CRP_Psicologo_Aprovador  VARCHAR(20)   NULL COMMENT 'Psicólogo que aprovou (ou recusou) o cadastro',
  MotivoRejeicao           VARCHAR(255)  NULL,
  SenhaHash                VARCHAR(255)  NOT NULL,
  UltimoLogin              DATETIME      NULL,
  CONSTRAINT PK_Paciente PRIMARY KEY (CPF),             -- CPF é chave primária (já é único)
  CONSTRAINT UQ_Paciente_Email UNIQUE (Email),
  CONSTRAINT FK_Paciente_Psicologo_Aprovador FOREIGN KEY (CRP_Psicologo_Aprovador) REFERENCES Psicologo (CRP) ON DELETE SET NULL,
  CONSTRAINT CHK_Status_Paciente CHECK (Status IN ('PENDENTE_APROVACAO','ATIVO','REJEITADO','INATIVO')),
  CONSTRAINT CHK_Paciente_CPF CHECK (CHAR_LENGTH(CPF) BETWEEN 11 AND 14),
  CONSTRAINT CHK_Paciente_Email CHECK (Email LIKE '%_@_%._%')
) ENGINE=InnoDB COMMENT='Login liberado somente com Status = ATIVO (aprovado por um psicólogo)';

CALL prisma_add_indice('Paciente', 'IX_Paciente_Status', 'Status, Data_Solicitacao');

-- =========================================================================
-- 2. AGENDA
-- =========================================================================

CREATE TABLE IF NOT EXISTS Consulta (
  ID_Consulta         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  DataHora            DATETIME      NOT NULL,
  DataHoraSugerida    DATETIME      NULL COMMENT 'Contraproposta de horário feita pela psicóloga',
  Duracao             VARCHAR(20)   NOT NULL DEFAULT '60 min',
  DuracaoMin          SMALLINT UNSIGNED AS (CAST(SUBSTRING_INDEX(Duracao, ' ', 1) AS UNSIGNED)) STORED,
  DataHoraFim         DATETIME      AS (DataHora + INTERVAL DuracaoMin MINUTE) STORED,
  Status              VARCHAR(20)   NOT NULL DEFAULT 'Pendente',
  Modalidade          VARCHAR(12)   NOT NULL DEFAULT 'Online',
  Solicitante         VARCHAR(12)   NOT NULL DEFAULT 'Paciente',
  Observacoes         TEXT          NULL,
  MotivoCancelamento  VARCHAR(255)  NULL,
  -- Confirmação de presença (regra das 36 h) — preenchida pelos triggers da seção 6.15
  StatusConfirmacao      VARCHAR(25)   NULL COMMENT 'AGUARDANDO | CONFIRMADA | PENDENTE_CONFIRMACAO (somente consultas Agendadas)',
  ConfirmadaEm           DATETIME      NULL,
  ConfirmadaPor          VARCHAR(12)   NULL,
  ConfirmacaoTardia      BOOLEAN       NOT NULL DEFAULT FALSE COMMENT 'Confirmada depois do prazo de PrazoConfirmacaoHoras',
  LembreteConfirmacaoEm  DATETIME      NULL COMMENT 'Lembrete enviado ao paciente (EVT_Confirmacao_Presenca)',
  AlertaConfirmacaoEm    DATETIME      NULL COMMENT 'Prazo vencido sem confirmação: psicóloga alertada',
  CPF_Paciente        VARCHAR(14)   NOT NULL,
  CRP_Psicologo       VARCHAR(20)   NOT NULL,
  CriadoEm            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  AtualizadoEm        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT PK_Consulta PRIMARY KEY (ID_Consulta),
  CONSTRAINT FK_Consulta_Paciente  FOREIGN KEY (CPF_Paciente)  REFERENCES Paciente (CPF)  ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT FK_Consulta_Psicologo FOREIGN KEY (CRP_Psicologo) REFERENCES Psicologo (CRP) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT CHK_Status_Consulta  CHECK (Status IN ('Pendente','Agendada','Aguardando_Paciente','Realizada','Cancelada','Recusada','Faltou')),
  CONSTRAINT CHK_Duracao_Consulta CHECK (Duracao IN ('30 min','60 min','90 min','120 min')),
  CONSTRAINT CHK_Modalidade       CHECK (Modalidade IN ('Presencial','Online')),
  CONSTRAINT CHK_Solicitante      CHECK (Solicitante IN ('Paciente','Psicóloga')),
  CONSTRAINT CHK_Sugestao_Status  CHECK (DataHoraSugerida IS NULL OR Status = 'Aguardando_Paciente'),
  CONSTRAINT CHK_Status_Confirmacao CHECK (StatusConfirmacao IS NULL OR StatusConfirmacao IN ('AGUARDANDO','CONFIRMADA','PENDENTE_CONFIRMACAO')),
  CONSTRAINT CHK_Confirmada_Por     CHECK (ConfirmadaPor IS NULL OR ConfirmadaPor IN ('Paciente','Psicóloga')),
  INDEX IX_Consulta_Confirmacao (Status, StatusConfirmacao, DataHora),
  INDEX IX_Consulta_Agenda (CRP_Psicologo, DataHora),
  INDEX IX_Consulta_Paciente (CPF_Paciente, DataHora)
) ENGINE=InnoDB COMMENT='Fluxo: Pendente → (Agendada | Recusada | Aguardando_Paciente) → Realizada/Faltou/Cancelada';

-- =========================================================================
-- 2.1 BLOQUEIOS DA AGENDA (folgas, feriados, congressos…)
--     Nenhuma consulta ativa pode tocar um período bloqueado (TRG_Bloqueio_Agenda).
--     Dia inteiro: Data_Inicio = 00:00:00 e Data_Fim = 23:59:59 do último dia.
--     O paciente enxerga apenas o período (vw_agenda_indisponivel), nunca o Motivo.
-- =========================================================================
CREATE TABLE IF NOT EXISTS BloqueioAgenda (
  ID_Bloqueio    INT           NOT NULL AUTO_INCREMENT,
  CRP_Psicologo  VARCHAR(20)   NOT NULL,
  Data_Inicio    DATETIME      NOT NULL,
  Data_Fim       DATETIME      NOT NULL,
  DiaInteiro     BOOLEAN       NOT NULL DEFAULT TRUE,
  Motivo         VARCHAR(255)  NULL COMMENT 'Ex.: Férias, Feriado, Congresso, Compromisso pessoal (privado da psicóloga)',
  CriadoEm       DATETIME      DEFAULT CURRENT_TIMESTAMP,
  AtualizadoEm   DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT PK_BloqueioAgenda PRIMARY KEY (ID_Bloqueio),
  CONSTRAINT FK_Bloqueio_Psicologo FOREIGN KEY (CRP_Psicologo) REFERENCES Psicologo (CRP) ON DELETE CASCADE,
  CONSTRAINT CHK_Bloqueio_Periodo CHECK (Data_Fim > Data_Inicio),
  CONSTRAINT CHK_Bloqueio_Duracao CHECK (Data_Fim <= Data_Inicio + INTERVAL 366 DAY),
  INDEX IX_Bloqueio_Periodo (CRP_Psicologo, Data_Inicio, Data_Fim)
) ENGINE=InnoDB COMMENT='Dias/horários bloqueados pela psicóloga — indisponíveis para agendamento';

-- =========================================================================
-- 3. PRONTUÁRIO, METAS E DOCUMENTOS
-- =========================================================================

CREATE TABLE IF NOT EXISTS Registro_Clinico (
  ID_RC                   INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  DataCriacao             DATE          NOT NULL DEFAULT (CURRENT_DATE),
  DataUltMod              DATE          NOT NULL DEFAULT (CURRENT_DATE),
  NumeroSessao            SMALLINT UNSIGNED NULL,
  DuracaoMin              SMALLINT UNSIGNED NOT NULL DEFAULT 50,
  Conteudo                TEXT          NOT NULL,
  QueixaPrincipal         TEXT          NULL,
  IntervencoesRealizadas  TEXT          NULL,
  ProgressoObservado      TEXT          NULL,
  TarefasParaCasa         TEXT          NULL,
  ProximaSessao           VARCHAR(60)   NULL,
  Tags                    JSON          NULL,
  CPF_Paciente            VARCHAR(14)   NOT NULL,
  ID_Consulta             INT UNSIGNED  NOT NULL,
  CRP_Psicologo           VARCHAR(20)   NOT NULL,
  CONSTRAINT PK_Registro_Clinico PRIMARY KEY (ID_RC),
  CONSTRAINT UQ_RC_Consulta UNIQUE (ID_Consulta),
  CONSTRAINT FK_RC_Paciente  FOREIGN KEY (CPF_Paciente)  REFERENCES Paciente (CPF)          ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT FK_RC_Consulta  FOREIGN KEY (ID_Consulta)   REFERENCES Consulta (ID_Consulta)  ON DELETE RESTRICT,
  CONSTRAINT FK_RC_Psicologo FOREIGN KEY (CRP_Psicologo) REFERENCES Psicologo (CRP)         ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT CHK_RC_Datas CHECK (DataUltMod >= DataCriacao),
  CONSTRAINT CHK_RC_Tags CHECK (Tags IS NULL OR JSON_TYPE(Tags) = 'ARRAY')
) ENGINE=InnoDB COMMENT='Sigiloso: acesso exclusivo da psicóloga (ver seção 9 — perfis de acesso)';

CREATE TABLE IF NOT EXISTS Metas (
  ID_Meta              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  Status               VARCHAR(20)   NOT NULL DEFAULT 'Ativa',
  DataInicio           DATE          NOT NULL,
  DataFim              DATE          NULL,
  Descricao            TEXT          NOT NULL,
  Objetivos            VARCHAR(150)  NULL,
  Categoria            VARCHAR(50)   NULL,
  Prazo                VARCHAR(10)   NOT NULL DEFAULT 'Curto',
  ProgressoPercentual  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  CPF_Paciente         VARCHAR(14)   NOT NULL,
  CRP_Psicologo        VARCHAR(20)   NOT NULL,
  CONSTRAINT PK_Metas PRIMARY KEY (ID_Meta),
  CONSTRAINT FK_Metas_Paciente  FOREIGN KEY (CPF_Paciente)  REFERENCES Paciente (CPF)  ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT FK_Metas_Psicologo FOREIGN KEY (CRP_Psicologo) REFERENCES Psicologo (CRP) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT CHK_Datas_Meta   CHECK (DataFim IS NULL OR DataFim >= DataInicio),
  CONSTRAINT CHK_Status_Meta  CHECK (Status IN ('Ativa','Concluida','Cancelada')),
  CONSTRAINT CHK_Prazo_Meta   CHECK (Prazo IN ('Curto','Médio','Longo')),
  CONSTRAINT CHK_Progresso    CHECK (ProgressoPercentual BETWEEN 0 AND 100),
  INDEX IX_Metas_Paciente (CPF_Paciente, Status)
) ENGINE=InnoDB COMMENT='ProgressoPercentual é mantido pelos triggers do checklist';

CREATE TABLE IF NOT EXISTS Meta_Checklist_Item (
  ID_Item        INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  ID_Meta        INT UNSIGNED  NOT NULL,
  Ordem          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  Descricao      VARCHAR(255)  NOT NULL,
  Concluido      BOOLEAN       NOT NULL DEFAULT FALSE,
  DataConclusao  DATETIME      NULL,
  CONSTRAINT PK_Meta_Checklist_Item PRIMARY KEY (ID_Item),
  CONSTRAINT FK_Item_Meta FOREIGN KEY (ID_Meta) REFERENCES Metas (ID_Meta) ON DELETE CASCADE,
  CONSTRAINT CHK_Item_Conclusao CHECK (Concluido = TRUE OR DataConclusao IS NULL),
  INDEX IX_Item_Meta (ID_Meta, Ordem)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Documentos (
  ID_Doc          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  Tipo            VARCHAR(50)   NOT NULL,
  Origem          VARCHAR(40)   NOT NULL,
  Conteudo        TEXT          NULL COMMENT 'Descrição/metadados; o binário fica no Google Drive',
  NomeArquivo     VARCHAR(255)  NOT NULL,
  MimeType        VARCHAR(100)  NULL,
  TamanhoKb       INT UNSIGNED  NOT NULL DEFAULT 0,
  Armazenamento   VARCHAR(30)   NOT NULL DEFAULT 'Google Drive API v3',
  DriveFileId     VARCHAR(128)  NULL,
  DataEnvio       DATE          NOT NULL DEFAULT (CURRENT_DATE),
  CPF_Paciente    VARCHAR(14)   NOT NULL,
  CRP_Psicologo   VARCHAR(20)   NULL,
  ID_Consulta     INT UNSIGNED  NULL,
  CONSTRAINT PK_Documentos PRIMARY KEY (ID_Doc),
  CONSTRAINT FK_Documentos_Paciente  FOREIGN KEY (CPF_Paciente)  REFERENCES Paciente (CPF)         ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT FK_Documentos_Psicologo FOREIGN KEY (CRP_Psicologo) REFERENCES Psicologo (CRP)        ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT FK_Documentos_Consulta  FOREIGN KEY (ID_Consulta)   REFERENCES Consulta (ID_Consulta) ON DELETE SET NULL,
  CONSTRAINT CHK_Origem_Documento CHECK (Origem IN ('Paciente','Psicóloga','Sistema')),
  CONSTRAINT CHK_Tipo_Documento   CHECK (Tipo IN ('Administrativo','Avaliações','Relatórios','Testes','Tratamento','Laudos e Atestados')),
  CONSTRAINT CHK_Armazenamento    CHECK (Armazenamento IN ('Google Drive API v3','Local Fallback')),
  CONSTRAINT CHK_Drive_Id         CHECK (Armazenamento = 'Local Fallback' OR DriveFileId IS NOT NULL),
  CONSTRAINT CHK_Tamanho          CHECK (TamanhoKb <= 25600),
  INDEX IX_Documentos_Paciente (CPF_Paciente, DataEnvio)
) ENGINE=InnoDB COMMENT='Local Fallback = arquivo aguardando sincronização com o Drive (risco R01)';

CREATE TABLE IF NOT EXISTS Laudos_Atestados (
  ID_LA         INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  Tipo          VARCHAR(20)   NOT NULL,
  Titulo        VARCHAR(150)  NOT NULL,
  Conteudo      TEXT          NOT NULL,
  DataEmissao   DATE          NOT NULL DEFAULT (CURRENT_DATE),
  ID_Consulta   INT UNSIGNED  NOT NULL,
  CONSTRAINT PK_Laudos_Atestados PRIMARY KEY (ID_LA),
  CONSTRAINT FK_Laudo_Consulta FOREIGN KEY (ID_Consulta) REFERENCES Consulta (ID_Consulta) ON DELETE RESTRICT,
  CONSTRAINT CHK_Tipo_Laudo CHECK (Tipo IN ('Laudo','Atestado'))
) ENGINE=InnoDB;

-- =========================================================================
-- 4. COMUNICAÇÃO, TESTES E AUDITORIA
-- =========================================================================

CREATE TABLE IF NOT EXISTS Mensagem (
  ID_Mensagem   INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  DataHora      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Texto         VARCHAR(500)  NOT NULL,
  Remetente     VARCHAR(20)   NOT NULL COMMENT 'CPF do paciente ou CRP da psicóloga',
  Destinatario  VARCHAR(20)   NOT NULL COMMENT 'CPF do paciente ou CRP da psicóloga',
  Lida          BOOLEAN       NOT NULL DEFAULT FALSE,
  CONSTRAINT PK_Mensagem PRIMARY KEY (ID_Mensagem),
  CONSTRAINT CHK_Mensagem_Texto CHECK (CHAR_LENGTH(TRIM(Texto)) > 0),
  CONSTRAINT CHK_Mensagem_Participantes CHECK (Remetente <> Destinatario),
  INDEX IX_Mensagem_Conversa (Remetente, Destinatario, DataHora),
  INDEX IX_Mensagem_Nao_Lidas (Destinatario, Lida)
) ENGINE=InnoDB COMMENT='Participantes validados por TRG_Valida_Mensagem (FK polimórfica CPF/CRP)';

CREATE TABLE IF NOT EXISTS Notificacao (
  ID_Notificacao  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  DestinatarioId  VARCHAR(20)   NOT NULL,
  Titulo          VARCHAR(120)  NOT NULL,
  Mensagem        VARCHAR(500)  NOT NULL,
  Tipo            VARCHAR(30)   NOT NULL DEFAULT 'sistema',
  DataHora        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  Lida            BOOLEAN       NOT NULL DEFAULT FALSE,
  CONSTRAINT PK_Notificacao PRIMARY KEY (ID_Notificacao),
  CONSTRAINT CHK_Tipo_Notificacao CHECK (Tipo IN ('cadastro_pendente','cadastro_aprovado','consulta_proxima','meta_ativa','solicitacao_pendente','consulta_confirmada','solicitacao_recusada','contraproposta_horario','proposta_aceita','teste_pendente','mensagem','documento','sistema','confirmacao_pendente','confirmacao_atrasada','presenca_confirmada','agenda_bloqueada')),
  INDEX IX_Notificacao_Destino (DestinatarioId, Lida, DataHora)
) ENGINE=InnoDB COMMENT='Fila de envio para o Firebase Cloud Messaging';

CREATE TABLE IF NOT EXISTS Teste_Psicologico (
  Codigo        VARCHAR(20)   NOT NULL,
  Sigla         VARCHAR(20)   NOT NULL,
  Nome          VARCHAR(120)  NOT NULL,
  NumItens      TINYINT UNSIGNED NOT NULL,
  PontuacaoMax  SMALLINT UNSIGNED NOT NULL,
  MaiorMelhor   BOOLEAN       NOT NULL DEFAULT FALSE,
  Observacao    VARCHAR(255)  NULL,
  CONSTRAINT PK_Teste_Psicologico PRIMARY KEY (Codigo)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Teste_Faixa (
  Codigo         VARCHAR(20)   NOT NULL,
  PontosMin      SMALLINT UNSIGNED NOT NULL,
  PontosMax      SMALLINT UNSIGNED NOT NULL,
  Classificacao  VARCHAR(40)   NOT NULL,
  CONSTRAINT PK_Teste_Faixa PRIMARY KEY (Codigo, PontosMin),
  CONSTRAINT FK_Faixa_Teste FOREIGN KEY (Codigo) REFERENCES Teste_Psicologico (Codigo) ON DELETE CASCADE,
  CONSTRAINT CHK_Faixa CHECK (PontosMax >= PontosMin)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS Aplicacao_Teste (
  ID_Aplicacao    INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  CodigoTeste     VARCHAR(20)   NOT NULL,
  CPF_Paciente    VARCHAR(14)   NOT NULL,
  CRP_Psicologo   VARCHAR(20)   NOT NULL,
  Status          VARCHAR(12)   NOT NULL DEFAULT 'Pendente',
  DataAtribuicao  DATE          NOT NULL DEFAULT (CURRENT_DATE),
  DataResposta    DATE          NULL,
  Respostas       JSON          NULL COMMENT 'Array com a pontuação de cada item, ex.: [2,1,3,0]',
  Pontuacao       SMALLINT UNSIGNED NULL,
  Classificacao   VARCHAR(40)   NULL,
  CONSTRAINT PK_Aplicacao_Teste PRIMARY KEY (ID_Aplicacao),
  CONSTRAINT FK_Aplicacao_Teste      FOREIGN KEY (CodigoTeste)   REFERENCES Teste_Psicologico (Codigo),
  CONSTRAINT FK_Aplicacao_Paciente   FOREIGN KEY (CPF_Paciente)  REFERENCES Paciente (CPF)  ON UPDATE CASCADE,
  CONSTRAINT FK_Aplicacao_Psicologo  FOREIGN KEY (CRP_Psicologo) REFERENCES Psicologo (CRP) ON UPDATE CASCADE,
  CONSTRAINT CHK_Status_Aplicacao CHECK (Status IN ('Pendente','Respondido')),
  CONSTRAINT CHK_Aplicacao_Resposta CHECK ((Status = 'Pendente' AND Respostas IS NULL) OR (Status = 'Respondido' AND Respostas IS NOT NULL AND DataResposta IS NOT NULL)),
  INDEX IX_Aplicacao_Paciente (CPF_Paciente, CodigoTeste, DataResposta)
) ENGINE=InnoDB COMMENT='Pontuacao e Classificacao calculadas pelos triggers';

CREATE TABLE IF NOT EXISTS Auditoria (
  ID_Auditoria  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  DataHora      DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  Acao          VARCHAR(60)   NOT NULL,
  UsuarioId     VARCHAR(20)   NOT NULL,
  UsuarioTipo   VARCHAR(12)   NOT NULL,
  Detalhes      VARCHAR(500)  NULL,
  Sucesso       BOOLEAN       NOT NULL DEFAULT TRUE,
  CONSTRAINT PK_Auditoria PRIMARY KEY (ID_Auditoria),
  CONSTRAINT CHK_Auditoria_Tipo CHECK (UsuarioTipo IN ('psicologo','paciente','sistema')),
  INDEX IX_Auditoria_Usuario (UsuarioId, DataHora)
) ENGINE=InnoDB COMMENT='Trilha de auditoria (LGPD, art. 37)';

-- =========================================================================
-- 4.1 PRONTUÁRIO POR SESSÃO — anexos de texto e histórico da sessão
-- =========================================================================

-- Arquivos de texto (.txt, .doc, .docx, .pdf) vinculados a uma sessão (consulta).
-- Nunca são apagados fisicamente (guarda do prontuário): remoção lógica via Removido.
CREATE TABLE IF NOT EXISTS Registro_Clinico_Anexo (
  ID_Anexo        INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  ID_Consulta     INT UNSIGNED      NOT NULL,
  CPF_Paciente    VARCHAR(14)       NOT NULL COMMENT 'Preenchido a partir da consulta pelo trigger',
  CRP_Psicologo   VARCHAR(20)       NOT NULL COMMENT 'Profissional que enviou o arquivo',
  NomeArquivo     VARCHAR(255)      NOT NULL,
  Extensao        VARCHAR(5)        NOT NULL,
  MimeType        VARCHAR(120)      NOT NULL,
  TamanhoBytes    INT UNSIGNED      NOT NULL,
  HashSHA256      CHAR(64)          NOT NULL COMMENT 'Integridade do conteúdo',
  Conteudo        LONGBLOB          NOT NULL,
  Descricao       VARCHAR(255)      NULL,
  Versao          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  Removido        BOOLEAN           NOT NULL DEFAULT FALSE,
  MotivoRemocao   VARCHAR(255)      NULL,
  DataEnvio       DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  DataUltMod      DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT PK_Registro_Clinico_Anexo PRIMARY KEY (ID_Anexo),
  CONSTRAINT FK_Anexo_Consulta  FOREIGN KEY (ID_Consulta)   REFERENCES Consulta (ID_Consulta) ON DELETE RESTRICT,
  CONSTRAINT FK_Anexo_Paciente  FOREIGN KEY (CPF_Paciente)  REFERENCES Paciente (CPF)          ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT FK_Anexo_Psicologo FOREIGN KEY (CRP_Psicologo) REFERENCES Psicologo (CRP)         ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT CHK_Anexo_Extensao CHECK (Extensao IN ('txt','doc','docx','pdf')),
  CONSTRAINT CHK_Anexo_Tamanho  CHECK (TamanhoBytes BETWEEN 1 AND 10485760),
  INDEX IX_Anexo_Sessao (ID_Consulta, Removido, DataEnvio)
) ENGINE=InnoDB COMMENT='Arquivos de texto do prontuário, por sessão (até 10 MB cada)';

-- Linha do tempo de cada sessão (preenchida pelos triggers da seção 6.14)
CREATE TABLE IF NOT EXISTS Sessao_Historico (
  ID_Historico  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ID_Consulta   INT UNSIGNED    NOT NULL,
  DataHora      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  Acao          VARCHAR(30)     NOT NULL,
  UsuarioId     VARCHAR(20)     NOT NULL,
  Detalhes      VARCHAR(500)    NULL,
  CONSTRAINT PK_Sessao_Historico PRIMARY KEY (ID_Historico),
  CONSTRAINT FK_Historico_Consulta FOREIGN KEY (ID_Consulta) REFERENCES Consulta (ID_Consulta) ON DELETE RESTRICT,
  CONSTRAINT CHK_Historico_Acao CHECK (Acao IN ('REGISTRO_CRIADO','REGISTRO_EDITADO','ANEXO_ENVIADO','ANEXO_EDITADO','ANEXO_SUBSTITUIDO','ANEXO_REMOVIDO','ANEXO_RESTAURADO')),
  INDEX IX_Historico_Sessao (ID_Consulta, DataHora)
) ENGINE=InnoDB;

-- =========================================================================
-- 4.2 ATUALIZAÇÃO DE BANCOS CRIADOS POR VERSÕES ANTERIORES
--     Em instalação nova nada acontece aqui (as tabelas acima já estão completas).
--     Em banco antigo: acrescenta colunas/restrições que faltam e ajusta os dados
--     afetados, sem apagar nem sobrescrever registros.
-- =========================================================================

-- Rotinas, triggers e evento são recriados logo abaixo (não guardam dados)
DROP EVENT IF EXISTS EVT_Confirmacao_Presenca;
DROP TRIGGER IF EXISTS TRG_Verifica_Data_Consulta;
DROP TRIGGER IF EXISTS TRG_Evita_Choque_Horario;
DROP TRIGGER IF EXISTS TRG_Limite_Alteracao_Agenda;
DROP TRIGGER IF EXISTS TRG_Evita_Choque_Horario_Update;
DROP TRIGGER IF EXISTS TRG_Atualiza_Modificacao_RC;
DROP TRIGGER IF EXISTS TRG_Valida_Registro_Clinico;
DROP TRIGGER IF EXISTS TRG_Checklist_Insert;
DROP TRIGGER IF EXISTS TRG_Checklist_Data_Conclusao;
DROP TRIGGER IF EXISTS TRG_Checklist_Update;
DROP TRIGGER IF EXISTS TRG_Checklist_Delete;
DROP TRIGGER IF EXISTS TRG_Laudo_Consulta_Realizada;
DROP TRIGGER IF EXISTS TRG_Valida_Mensagem;
DROP TRIGGER IF EXISTS TRG_Corrige_Teste_Insert;
DROP TRIGGER IF EXISTS TRG_Corrige_Teste_Update;
DROP TRIGGER IF EXISTS TRG_Paciente_Cadastro;
DROP TRIGGER IF EXISTS TRG_Paciente_Aprovacao;
DROP TRIGGER IF EXISTS TRG_Psicologo_Aprovacao;
DROP TRIGGER IF EXISTS TRG_Consulta_Paciente_Ativo;
DROP TRIGGER IF EXISTS TRG_Anexo_Valida;
DROP TRIGGER IF EXISTS TRG_Anexo_Versao;
DROP TRIGGER IF EXISTS TRG_Anexo_Sem_Exclusao;
DROP TRIGGER IF EXISTS TRG_Anexo_Historico_Insert;
DROP TRIGGER IF EXISTS TRG_Anexo_Historico_Update;
DROP TRIGGER IF EXISTS TRG_RC_Historico_Insert;
DROP TRIGGER IF EXISTS TRG_RC_Historico_Update;
DROP TRIGGER IF EXISTS TRG_RC_Sem_Exclusao;
DROP TRIGGER IF EXISTS TRG_Bloqueio_Agenda;
DROP TRIGGER IF EXISTS TRG_Antecedencia_Agendamento;
DROP TRIGGER IF EXISTS TRG_Consulta_Confirmacao_Insert;
DROP TRIGGER IF EXISTS TRG_Bloqueio_Agenda_Update;
DROP TRIGGER IF EXISTS TRG_Consulta_Confirmacao_Update;
DROP TRIGGER IF EXISTS TRG_Bloqueio_Valida_Insert;
DROP TRIGGER IF EXISTS TRG_Bloqueio_Valida_Update;
DROP TRIGGER IF EXISTS TRG_Bloqueio_Auditoria_Insert;
DROP TRIGGER IF EXISTS TRG_Bloqueio_Auditoria_Delete;
DROP FUNCTION IF EXISTS fn_conflitos_agenda;
DROP FUNCTION IF EXISTS fn_bloqueio_agenda;
DROP FUNCTION IF EXISTS fn_msg_bloqueio;
DROP PROCEDURE IF EXISTS sp_valida_horario_consulta;
DROP PROCEDURE IF EXISTS sp_recalcula_progresso_meta;
DROP PROCEDURE IF EXISTS sp_aprovar_cadastro_paciente;
DROP PROCEDURE IF EXISTS sp_recusar_cadastro_paciente;
DROP PROCEDURE IF EXISTS sp_processar_confirmacoes;

DELIMITER $$
DROP PROCEDURE IF EXISTS prisma_atualizar_estrutura$$
CREATE PROCEDURE prisma_atualizar_estrutura()
BEGIN
  DECLARE v_psi_auth, v_pac_auth, v_conf, v_x BOOLEAN DEFAULT FALSE;

  -- Autenticação e aprovação de cadastro -------------------------------------
  CALL prisma_add_coluna('Psicologo', 'Status', "VARCHAR(20) NOT NULL DEFAULT 'ATIVO'", v_psi_auth);
  CALL prisma_add_coluna('Psicologo', 'IsAdmin', 'BOOLEAN NOT NULL DEFAULT FALSE', v_x);
  CALL prisma_add_coluna('Psicologo', 'SenhaHash', "VARCHAR(255) NOT NULL DEFAULT '!'", v_x);
  CALL prisma_add_coluna('Psicologo', 'Data_Solicitacao', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', v_x);
  CALL prisma_add_coluna('Psicologo', 'Data_Aprovacao', 'DATETIME NULL', v_x);
  CALL prisma_add_coluna('Psicologo', 'CRP_Psicologo_Aprovador', 'VARCHAR(20) NULL', v_x);
  CALL prisma_add_coluna('Psicologo', 'MotivoRejeicao', 'VARCHAR(255) NULL', v_x);
  CALL prisma_add_coluna('Psicologo', 'UltimoLogin', 'DATETIME NULL', v_x);
  IF v_psi_auth THEN
    -- Profissionais que já existiam: administradores ativos; senha a definir ('!' bloqueia o login)
    UPDATE Psicologo SET IsAdmin = TRUE, Data_Aprovacao = NOW();
    CALL prisma_ddl('ALTER TABLE Psicologo ALTER COLUMN SenhaHash DROP DEFAULT');
  END IF;
  CALL prisma_add_restricao('Psicologo', 'CHK_Status_Psicologo', "CHECK (Status IN ('PENDENTE_APROVACAO','ATIVO','REJEITADO','INATIVO'))");
  CALL prisma_add_restricao('Psicologo', 'UQ_Psicologo_CPF', 'UNIQUE (CPF)');
  CALL prisma_add_restricao('Psicologo', 'FK_Psicologo_Aprovador', 'FOREIGN KEY (CRP_Psicologo_Aprovador) REFERENCES Psicologo (CRP) ON DELETE SET NULL');

  CALL prisma_add_coluna('Paciente', 'Status', "VARCHAR(20) NOT NULL DEFAULT 'PENDENTE_APROVACAO'", v_pac_auth);
  CALL prisma_add_coluna('Paciente', 'Data_Solicitacao', 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', v_x);
  CALL prisma_add_coluna('Paciente', 'Data_Aprovacao', 'DATETIME NULL', v_x);
  CALL prisma_add_coluna('Paciente', 'CRP_Psicologo_Aprovador', "VARCHAR(20) NULL COMMENT 'Psicólogo que aprovou (ou recusou) o cadastro'", v_x);
  CALL prisma_add_coluna('Paciente', 'MotivoRejeicao', 'VARCHAR(255) NULL', v_x);
  CALL prisma_add_coluna('Paciente', 'SenhaHash', "VARCHAR(255) NOT NULL DEFAULT '!'", v_x);
  CALL prisma_add_coluna('Paciente', 'UltimoLogin', 'DATETIME NULL', v_x);
  IF v_pac_auth THEN
    -- Pacientes que já estavam em atendimento continuam com acesso (aprovados pelo administrador)
    UPDATE Paciente
       SET Status = 'ATIVO', Data_Aprovacao = NOW(),
           CRP_Psicologo_Aprovador = (SELECT CRP FROM Psicologo WHERE IsAdmin ORDER BY CRP LIMIT 1);
    CALL prisma_ddl('ALTER TABLE Paciente ALTER COLUMN SenhaHash DROP DEFAULT');
  END IF;
  CALL prisma_add_restricao('Paciente', 'CHK_Status_Paciente', "CHECK (Status IN ('PENDENTE_APROVACAO','ATIVO','REJEITADO','INATIVO'))");
  CALL prisma_add_restricao('Paciente', 'FK_Paciente_Psicologo_Aprovador', 'FOREIGN KEY (CRP_Psicologo_Aprovador) REFERENCES Psicologo (CRP) ON DELETE SET NULL');
  CALL prisma_add_indice('Paciente', 'IX_Paciente_Status', 'Status, Data_Solicitacao');

  -- Agenda: prazos de 48 h / 36 h e confirmação de presença -------------------
  CALL prisma_add_coluna('Psicologo', 'AntecedenciaAgendamentoHoras', "INT NOT NULL DEFAULT 48 COMMENT 'Paciente só agenda a partir de NOW() + X horas'", v_x);
  CALL prisma_add_coluna('Psicologo', 'AntecedenciaReagendamentoHoras', "INT NOT NULL DEFAULT 48 COMMENT 'Paciente só reagenda se faltarem MAIS de X horas'", v_x);
  CALL prisma_add_coluna('Psicologo', 'PrazoConfirmacaoHoras', "INT NOT NULL DEFAULT 36 COMMENT 'Presença confirmada até X horas antes'", v_x);
  CALL prisma_add_coluna('Psicologo', 'LembreteConfirmacaoHoras', "INT NOT NULL DEFAULT 24 COMMENT 'Lembrete enviado X horas antes do prazo de confirmação'", v_x);
  CALL prisma_add_restricao('Psicologo', 'CHK_AntecedenciaAgendamento', 'CHECK (AntecedenciaAgendamentoHoras BETWEEN 0 AND 336)');
  CALL prisma_add_restricao('Psicologo', 'CHK_AntecedenciaReagendamento', 'CHECK (AntecedenciaReagendamentoHoras BETWEEN 0 AND 336)');
  CALL prisma_add_restricao('Psicologo', 'CHK_PrazoConfirmacao', 'CHECK (PrazoConfirmacaoHoras BETWEEN 1 AND 168)');
  CALL prisma_add_restricao('Psicologo', 'CHK_LembreteConfirmacao', 'CHECK (LembreteConfirmacaoHoras BETWEEN 1 AND 168)');

  CALL prisma_add_coluna('Consulta', 'StatusConfirmacao', "VARCHAR(25) NULL COMMENT 'AGUARDANDO | CONFIRMADA | PENDENTE_CONFIRMACAO (somente consultas Agendadas)'", v_conf);
  CALL prisma_add_coluna('Consulta', 'ConfirmadaEm', 'DATETIME NULL', v_x);
  CALL prisma_add_coluna('Consulta', 'ConfirmadaPor', 'VARCHAR(12) NULL', v_x);
  CALL prisma_add_coluna('Consulta', 'ConfirmacaoTardia', 'BOOLEAN NOT NULL DEFAULT FALSE', v_x);
  CALL prisma_add_coluna('Consulta', 'LembreteConfirmacaoEm', 'DATETIME NULL', v_x);
  CALL prisma_add_coluna('Consulta', 'AlertaConfirmacaoEm', 'DATETIME NULL', v_x);
  IF v_conf THEN
    UPDATE Consulta SET StatusConfirmacao = CASE Status WHEN 'Agendada' THEN 'AGUARDANDO' WHEN 'Realizada' THEN 'CONFIRMADA' END
     WHERE Status IN ('Agendada','Realizada');
  END IF;
  CALL prisma_add_restricao('Consulta', 'CHK_Status_Confirmacao', "CHECK (StatusConfirmacao IS NULL OR StatusConfirmacao IN ('AGUARDANDO','CONFIRMADA','PENDENTE_CONFIRMACAO'))");
  CALL prisma_add_restricao('Consulta', 'CHK_Confirmada_Por', "CHECK (ConfirmadaPor IS NULL OR ConfirmadaPor IN ('Paciente','Psicóloga'))");
  CALL prisma_add_indice('Consulta', 'IX_Consulta_Confirmacao', 'Status, StatusConfirmacao, DataHora');

  -- Notificações: tipos novos de cada versão -----------------------------------
  CALL prisma_trocar_check('Notificacao', 'CHK_Tipo_Notificacao', "CHECK (Tipo IN ('cadastro_pendente','cadastro_aprovado','consulta_proxima','meta_ativa','solicitacao_pendente','consulta_confirmada','solicitacao_recusada','contraproposta_horario','proposta_aceita','teste_pendente','mensagem','documento','sistema','confirmacao_pendente','confirmacao_atrasada','presenca_confirmada','agenda_bloqueada'))");

  -- Chat: nenhuma mensagem com horário no futuro (ordem cronológica)
  UPDATE Mensagem SET DataHora = NOW() WHERE DataHora > NOW();

  -- Prontuário por sessão: histórico inicial quando a tabela acabou de ser criada
  IF @prisma_havia_sessao_historico = 0 THEN
    INSERT INTO Sessao_Historico (ID_Consulta, DataHora, Acao, UsuarioId, Detalhes)
    SELECT ID_Consulta, TIMESTAMP(DataCriacao), 'REGISTRO_CRIADO', CRP_Psicologo, CONCAT('Anotação clínica da sessão ', IFNULL(NumeroSessao, ''), ' criada')
    FROM Registro_Clinico;
  END IF;
END$$
DELIMITER ;

CALL prisma_atualizar_estrutura();
DROP PROCEDURE prisma_atualizar_estrutura;

-- =========================================================================
-- 5. FUNÇÕES E PROCEDIMENTOS DE APOIO
-- =========================================================================
DELIMITER $$

-- Quantidade de consultas ativas que conflitam com [p_inicio, p_inicio + p_duracao]
-- considerando o intervalo mínimo de 20 minutos entre atendimentos.
-- Horários sugeridos em contrapropostas pendentes também ficam reservados.
CREATE FUNCTION fn_conflitos_agenda(
  p_crp VARCHAR(20), p_inicio DATETIME, p_duracao_min INT, p_ignorar_id INT UNSIGNED
) RETURNS INT
READS SQL DATA
BEGIN
  DECLARE v_total INT DEFAULT 0;
  DECLARE v_fim DATETIME DEFAULT p_inicio + INTERVAL p_duracao_min MINUTE;

  SELECT COUNT(*) INTO v_total
  FROM Consulta c
  WHERE c.CRP_Psicologo = p_crp
    AND c.Status NOT IN ('Cancelada','Recusada')
    AND (p_ignorar_id IS NULL OR c.ID_Consulta <> p_ignorar_id)
    AND (
         (p_inicio < c.DataHoraFim + INTERVAL 20 MINUTE AND v_fim + INTERVAL 20 MINUTE > c.DataHora)
      OR (c.Status = 'Aguardando_Paciente' AND c.DataHoraSugerida IS NOT NULL
          AND p_inicio < c.DataHoraSugerida + INTERVAL (c.DuracaoMin + 20) MINUTE
          AND v_fim + INTERVAL 20 MINUTE > c.DataHoraSugerida)
    );
  RETURN v_total;
END$$

-- ID do primeiro bloqueio da agenda que toca o intervalo [p_inicio, p_fim) — NULL se livre.
CREATE FUNCTION fn_bloqueio_agenda(p_crp VARCHAR(20), p_inicio DATETIME, p_fim DATETIME)
RETURNS INT
READS SQL DATA
BEGIN
  DECLARE v_id INT DEFAULT NULL;
  SELECT ID_Bloqueio INTO v_id
  FROM BloqueioAgenda
  WHERE CRP_Psicologo = p_crp AND Data_Inicio < p_fim AND Data_Fim > p_inicio
  ORDER BY Data_Inicio
  LIMIT 1;
  RETURN v_id;
END$$

-- Mensagem de bloqueio conforme o perfil informado pela API (@prisma_usuario_tipo)
CREATE FUNCTION fn_msg_bloqueio() RETURNS VARCHAR(128)
NO SQL
BEGIN
  RETURN IF(COALESCE(@prisma_usuario_tipo, 'psicologo') = 'paciente',
            'Data indisponível: a agenda da psicóloga está bloqueada neste período. Escolha outra data.',
            'Horário dentro de um bloqueio da agenda (BloqueioAgenda). Edite ou remova o bloqueio para usar este horário.');
END$$

-- Valida um horário de consulta (data futura + bloqueios da agenda + ausência de choque).
CREATE PROCEDURE sp_valida_horario_consulta(
  IN p_crp VARCHAR(20), IN p_inicio DATETIME, IN p_duracao VARCHAR(20), IN p_ignorar_id INT UNSIGNED
)
BEGIN
  DECLARE v_msg VARCHAR(255);
  DECLARE v_min INT DEFAULT CAST(SUBSTRING_INDEX(p_duracao, ' ', 1) AS UNSIGNED);
  IF p_inicio < NOW() THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Não é possível agendar uma consulta em data passada.';
  END IF;

  IF fn_bloqueio_agenda(p_crp, p_inicio, p_inicio + INTERVAL v_min MINUTE) IS NOT NULL THEN
    SET v_msg = fn_msg_bloqueio();
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;

  IF EXISTS (SELECT 1 FROM Consulta
             WHERE CRP_Psicologo = p_crp AND DataHora = p_inicio
               AND Status NOT IN ('Cancelada','Recusada')
               AND (p_ignorar_id IS NULL OR ID_Consulta <> p_ignorar_id)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'O psicólogo já possui consulta ativa neste horário.';
  END IF;

  IF fn_conflitos_agenda(p_crp, p_inicio, v_min, p_ignorar_id) > 0 THEN
    SET v_msg = 'Conflito de agenda: é necessário um intervalo mínimo de 20 minutos entre consultas.';
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;
END$$

-- Recalcula o percentual de progresso e o status automático da meta.
CREATE PROCEDURE sp_recalcula_progresso_meta(IN p_id_meta INT UNSIGNED)
BEGIN
  DECLARE v_total INT DEFAULT 0;
  DECLARE v_feitos INT DEFAULT 0;
  DECLARE v_pct INT DEFAULT 0;

  SELECT COUNT(*), COALESCE(SUM(Concluido), 0) INTO v_total, v_feitos
  FROM Meta_Checklist_Item WHERE ID_Meta = p_id_meta;

  SET v_pct = IF(v_total = 0, 0, ROUND(v_feitos * 100 / v_total));

  UPDATE Metas
     SET ProgressoPercentual = v_pct,
         Status = CASE WHEN Status = 'Cancelada' THEN 'Cancelada'
                       WHEN v_pct = 100 THEN 'Concluida'
                       ELSE 'Ativa' END
   WHERE ID_Meta = p_id_meta;
END$$

-- Aprovação / recusa pelo psicólogo (usadas pela API)
CREATE PROCEDURE sp_aprovar_cadastro_paciente(IN p_cpf VARCHAR(14), IN p_crp VARCHAR(20))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM Paciente WHERE CPF = p_cpf AND Status = 'PENDENTE_APROVACAO') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Este cadastro não está aguardando aprovação.';
  END IF;
  UPDATE Paciente SET Status = 'ATIVO', CRP_Psicologo_Aprovador = p_crp WHERE CPF = p_cpf;
  INSERT INTO Notificacao (DestinatarioId, Titulo, Mensagem, Tipo)
  VALUES (p_cpf, 'Cadastro aprovado', 'Bem-vindo(a) ao PRISMA! Seu cadastro foi aprovado.', 'cadastro_aprovado');
END$$

CREATE PROCEDURE sp_recusar_cadastro_paciente(IN p_cpf VARCHAR(14), IN p_crp VARCHAR(20), IN p_motivo VARCHAR(255))
BEGIN
  IF NOT EXISTS (SELECT 1 FROM Paciente WHERE CPF = p_cpf AND Status = 'PENDENTE_APROVACAO') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Este cadastro não está aguardando aprovação.';
  END IF;
  UPDATE Paciente SET Status = 'REJEITADO', CRP_Psicologo_Aprovador = p_crp, MotivoRejeicao = NULLIF(TRIM(p_motivo), '') WHERE CPF = p_cpf;
END$$


-- Confirmação de presença (regra das 36 h) — executada pelo EVT_Confirmacao_Presenca
--   1) janela do lembrete (PrazoConfirmacao + LembreteConfirmacao horas antes) → notifica o paciente uma vez;
--   2) prazo vencido sem confirmação → StatusConfirmacao = 'PENDENTE_CONFIRMACAO' e alerta a psicóloga.
CREATE PROCEDURE sp_processar_confirmacoes()
BEGIN
  DECLARE v_agora DATETIME DEFAULT NOW();
  DECLARE v_lembretes INT DEFAULT 0;
  DECLARE v_alertas INT DEFAULT 0;

  START TRANSACTION;

  -- 1) Lembretes
  DROP TEMPORARY TABLE IF EXISTS tmp_lembrete;
  CREATE TEMPORARY TABLE tmp_lembrete ENGINE=MEMORY AS
  SELECT c.ID_Consulta, c.CPF_Paciente, c.DataHora, c.DataHora - INTERVAL ps.PrazoConfirmacaoHoras HOUR AS Prazo, ps.PrazoConfirmacaoHoras AS Horas
  FROM Consulta c JOIN Psicologo ps ON ps.CRP = c.CRP_Psicologo
  WHERE c.Status = 'Agendada' AND c.StatusConfirmacao = 'AGUARDANDO' AND c.LembreteConfirmacaoEm IS NULL
    AND v_agora >= c.DataHora - INTERVAL (ps.PrazoConfirmacaoHoras + ps.LembreteConfirmacaoHoras) HOUR
    AND v_agora <  c.DataHora - INTERVAL ps.PrazoConfirmacaoHoras HOUR;

  INSERT INTO Notificacao (DestinatarioId, Titulo, Mensagem, Tipo)
  SELECT CPF_Paciente, 'Confirme sua presença',
         CONCAT('Sua consulta de ', DATE_FORMAT(DataHora, '%d/%m/%Y às %H:%i'), ' precisa ser confirmada até ',
                DATE_FORMAT(Prazo, '%d/%m/%Y às %H:%i'), ' (', Horas, ' h antes). Confirme na Agenda.'),
         'confirmacao_pendente'
  FROM tmp_lembrete;
  UPDATE Consulta c JOIN tmp_lembrete t ON t.ID_Consulta = c.ID_Consulta SET c.LembreteConfirmacaoEm = v_agora;
  SET v_lembretes = ROW_COUNT();

  -- 2) Prazo vencido → PENDENTE_CONFIRMACAO
  DROP TEMPORARY TABLE IF EXISTS tmp_alerta;
  CREATE TEMPORARY TABLE tmp_alerta ENGINE=MEMORY AS
  SELECT c.ID_Consulta, c.CPF_Paciente, c.CRP_Psicologo, c.DataHora, p.Nome AS Paciente, ps.PrazoConfirmacaoHoras AS Horas
  FROM Consulta c JOIN Psicologo ps ON ps.CRP = c.CRP_Psicologo JOIN Paciente p ON p.CPF = c.CPF_Paciente
  WHERE c.Status = 'Agendada' AND c.StatusConfirmacao = 'AGUARDANDO'
    AND c.DataHora > v_agora
    AND v_agora >= c.DataHora - INTERVAL ps.PrazoConfirmacaoHoras HOUR;

  INSERT INTO Notificacao (DestinatarioId, Titulo, Mensagem, Tipo)
  SELECT CRP_Psicologo, 'Presença não confirmada',
         CONCAT(Paciente, ' não confirmou a consulta de ', DATE_FORMAT(DataHora, '%d/%m/%Y às %H:%i'), ' no prazo de ', Horas, ' h. Confirme por contato ou libere a vaga.'),
         'confirmacao_atrasada'
  FROM tmp_alerta;
  -- (tabela temporária não pode ser lida duas vezes na mesma instrução: um INSERT por destinatário)
  INSERT INTO Notificacao (DestinatarioId, Titulo, Mensagem, Tipo)
  SELECT CPF_Paciente, 'Prazo de confirmação encerrado',
         CONCAT('Sua consulta de ', DATE_FORMAT(DataHora, '%d/%m/%Y às %H:%i'), ' não foi confirmada até ', Horas, ' h antes. Confirme agora na Agenda ou fale com a psicóloga.'),
         'confirmacao_atrasada'
  FROM tmp_alerta;
  UPDATE Consulta c JOIN tmp_alerta t ON t.ID_Consulta = c.ID_Consulta
     SET c.StatusConfirmacao = 'PENDENTE_CONFIRMACAO', c.AlertaConfirmacaoEm = v_agora,
         c.LembreteConfirmacaoEm = COALESCE(c.LembreteConfirmacaoEm, v_agora);
  SET v_alertas = ROW_COUNT();

  IF v_lembretes + v_alertas > 0 THEN
    INSERT INTO Auditoria (Acao, UsuarioId, UsuarioTipo, Detalhes)
    VALUES ('PROCESSAR_CONFIRMACOES', 'sistema', 'sistema', CONCAT(v_lembretes, ' lembrete(s); ', v_alertas, ' consulta(s) → PENDENTE_CONFIRMACAO'));
  END IF;
  COMMIT;

  DROP TEMPORARY TABLE IF EXISTS tmp_lembrete;
  DROP TEMPORARY TABLE IF EXISTS tmp_alerta;
END$$

DELIMITER ;

-- =========================================================================
-- 6. TRIGGERS — REGRAS DE NEGÓCIO
-- =========================================================================
DELIMITER $$

-- 6.1 Agenda: não permite agendar em data passada
--     (registros históricos com status Realizada/Faltou/Cancelada/Recusada são aceitos)
CREATE TRIGGER TRG_Verifica_Data_Consulta
BEFORE INSERT ON Consulta
FOR EACH ROW
BEGIN
  IF NEW.Status IN ('Pendente','Agendada','Aguardando_Paciente') AND NEW.DataHora < NOW() THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Não é possível agendar uma consulta em data passada.';
  END IF;
END$$

-- 6.2 Agenda: evita choque de horário (duração + intervalo mínimo de 20 min)
CREATE TRIGGER TRG_Evita_Choque_Horario
BEFORE INSERT ON Consulta
FOR EACH ROW
FOLLOWS TRG_Verifica_Data_Consulta
BEGIN
  IF NEW.Status IN ('Pendente','Agendada','Aguardando_Paciente') THEN
    IF EXISTS (SELECT 1 FROM Consulta
               WHERE CRP_Psicologo = NEW.CRP_Psicologo AND DataHora = NEW.DataHora
                 AND Status NOT IN ('Cancelada','Recusada')) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'O psicólogo já possui consulta ativa neste horário.';
    END IF;
    IF fn_conflitos_agenda(NEW.CRP_Psicologo, NEW.DataHora,
                           CAST(SUBSTRING_INDEX(NEW.Duracao, ' ', 1) AS UNSIGNED), NULL) > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Conflito de agenda: é necessário um intervalo mínimo de 20 minutos entre consultas.';
    END IF;
  END IF;
END$$

-- 6.3 Agenda: prazos do PACIENTE ao alterar uma consulta (a API informa o perfil em @prisma_usuario_tipo)
--     • Reagendar (mudar DataHora de consulta Pendente/Agendada): só com MAIS de AntecedenciaReagendamentoHoras
--       (padrão 48 h) para o horário atual, e o novo horário respeita NOW() + AntecedenciaAgendamentoHoras.
--     • Cancelar consulta confirmada: antecedência mínima de LimiteAlteracaoHoras (padrão 24 h).
CREATE TRIGGER TRG_Limite_Alteracao_Agenda
BEFORE UPDATE ON Consulta
FOR EACH ROW
BEGIN
  DECLARE v_cancel INT;
  DECLARE v_reag INT;
  DECLARE v_agend INT;
  DECLARE v_msg VARCHAR(255);
  IF COALESCE(@prisma_usuario_tipo, 'psicologo') = 'paciente' THEN
    SELECT LimiteAlteracaoHoras, AntecedenciaReagendamentoHoras, AntecedenciaAgendamentoHoras
      INTO v_cancel, v_reag, v_agend
      FROM Psicologo WHERE CRP = OLD.CRP_Psicologo;

    IF NEW.DataHora <> OLD.DataHora AND OLD.Status IN ('Pendente','Agendada') THEN
      IF TIMESTAMPDIFF(MINUTE, NOW(), OLD.DataHora) <= v_reag * 60 THEN
        SET v_msg = CONCAT('Reagendamentos só podem ser realizados com pelo menos ', v_reag, ' horas de antecedência. Entre em contato diretamente com a psicóloga.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
      END IF;
      IF NEW.DataHora < NOW() + INTERVAL v_agend HOUR THEN
        SET v_msg = CONCAT('Novos agendamentos exigem pelo menos ', v_agend, ' horas de antecedência.');
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
      END IF;
    END IF;

    IF OLD.Status = 'Agendada' AND NEW.Status = 'Cancelada'
       AND TIMESTAMPDIFF(MINUTE, NOW(), OLD.DataHora) < v_cancel * 60 THEN
      SET v_msg = CONCAT('Cancelamento não permitido: consultas confirmadas exigem antecedência mínima de ', v_cancel, ' horas.');
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;
  END IF;
END$$

-- 6.4 Agenda: revalida data e choque em remarcações, contrapropostas e reativações
CREATE TRIGGER TRG_Evita_Choque_Horario_Update
BEFORE UPDATE ON Consulta
FOR EACH ROW
FOLLOWS TRG_Limite_Alteracao_Agenda
BEGIN
  IF NEW.Status IN ('Pendente','Agendada','Aguardando_Paciente')
     AND (NEW.DataHora <> OLD.DataHora OR NEW.Duracao <> OLD.Duracao OR OLD.Status IN ('Cancelada','Recusada')) THEN
    CALL sp_valida_horario_consulta(NEW.CRP_Psicologo, NEW.DataHora, NEW.Duracao, NEW.ID_Consulta);
  END IF;

  IF NEW.DataHoraSugerida IS NOT NULL AND NOT (NEW.DataHoraSugerida <=> OLD.DataHoraSugerida) THEN
    CALL sp_valida_horario_consulta(NEW.CRP_Psicologo, NEW.DataHoraSugerida, NEW.Duracao, NEW.ID_Consulta);
  END IF;

  -- Comparecimento só pode ser registrado para consultas confirmadas que já começaram
  IF NEW.Status IN ('Realizada','Faltou') AND OLD.Status <> NEW.Status THEN
    IF OLD.Status <> 'Agendada' OR NEW.DataHora > NOW() THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Comparecimento só pode ser registrado para consultas confirmadas que já começaram.';
    END IF;
  END IF;
END$$

-- 6.5 Prontuário: atualiza a data de última modificação
CREATE TRIGGER TRG_Atualiza_Modificacao_RC
BEFORE UPDATE ON Registro_Clinico
FOR EACH ROW
BEGIN
  SET NEW.DataUltMod = CURRENT_DATE;
END$$

-- 6.6 Prontuário: a consulta vinculada deve ser do mesmo paciente; numera a sessão
CREATE TRIGGER TRG_Valida_Registro_Clinico
BEFORE INSERT ON Registro_Clinico
FOR EACH ROW
BEGIN
  DECLARE v_cpf VARCHAR(14);
  SELECT CPF_Paciente INTO v_cpf FROM Consulta WHERE ID_Consulta = NEW.ID_Consulta;
  IF v_cpf IS NULL OR v_cpf <> NEW.CPF_Paciente THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A consulta vinculada não pertence a este paciente.';
  END IF;
  IF NEW.NumeroSessao IS NULL THEN
    SET NEW.NumeroSessao = (SELECT COALESCE(MAX(NumeroSessao), 0) + 1 FROM Registro_Clinico WHERE CPF_Paciente = NEW.CPF_Paciente);
  END IF;
END$$

-- 6.7 Metas: recálculo automático do progresso a cada alteração do checklist
CREATE TRIGGER TRG_Checklist_Insert
AFTER INSERT ON Meta_Checklist_Item
FOR EACH ROW
BEGIN
  CALL sp_recalcula_progresso_meta(NEW.ID_Meta);
END$$

CREATE TRIGGER TRG_Checklist_Data_Conclusao
BEFORE UPDATE ON Meta_Checklist_Item
FOR EACH ROW
BEGIN
  IF NEW.Concluido AND NOT OLD.Concluido THEN SET NEW.DataConclusao = NOW(); END IF;
  IF NOT NEW.Concluido THEN SET NEW.DataConclusao = NULL; END IF;
END$$

CREATE TRIGGER TRG_Checklist_Update
AFTER UPDATE ON Meta_Checklist_Item
FOR EACH ROW
BEGIN
  CALL sp_recalcula_progresso_meta(NEW.ID_Meta);
END$$

CREATE TRIGGER TRG_Checklist_Delete
AFTER DELETE ON Meta_Checklist_Item
FOR EACH ROW
BEGIN
  CALL sp_recalcula_progresso_meta(OLD.ID_Meta);
END$$

-- 6.8 Laudos e atestados: somente para consultas realizadas
CREATE TRIGGER TRG_Laudo_Consulta_Realizada
BEFORE INSERT ON Laudos_Atestados
FOR EACH ROW
BEGIN
  IF (SELECT Status FROM Consulta WHERE ID_Consulta = NEW.ID_Consulta) <> 'Realizada' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Laudos e atestados só podem ser emitidos para consultas realizadas.';
  END IF;
END$$

-- 6.9 Chat: uma ponta é um psicólogo ativo e a outra um paciente com cadastro aprovado
CREATE TRIGGER TRG_Valida_Mensagem
BEFORE INSERT ON Mensagem
FOR EACH ROW
BEGIN
  IF NOT (
       (EXISTS (SELECT 1 FROM Psicologo WHERE CRP = NEW.Remetente AND Status = 'ATIVO') AND EXISTS (SELECT 1 FROM Paciente WHERE CPF = NEW.Destinatario AND Status = 'ATIVO'))
    OR (EXISTS (SELECT 1 FROM Paciente  WHERE CPF = NEW.Remetente AND Status = 'ATIVO') AND EXISTS (SELECT 1 FROM Psicologo WHERE CRP = NEW.Destinatario AND Status = 'ATIVO'))
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Mensagens são trocadas apenas entre psicólogos ativos e pacientes com cadastro aprovado.';
  END IF;
  -- O horário de envio é do servidor: nunca no futuro (garante a ordem cronológica do chat)
  IF NEW.DataHora IS NULL OR NEW.DataHora > NOW() THEN
    SET NEW.DataHora = NOW();
  END IF;
END$$

-- 6.10 Testes: correção automática (soma dos itens + faixa de classificação)
CREATE TRIGGER TRG_Corrige_Teste_Insert
BEFORE INSERT ON Aplicacao_Teste
FOR EACH ROW
BEGIN
  DECLARE v_itens INT;
  IF NEW.Respostas IS NOT NULL THEN
    SELECT NumItens INTO v_itens FROM Teste_Psicologico WHERE Codigo = NEW.CodigoTeste;
    IF JSON_LENGTH(NEW.Respostas) <> v_itens THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Quantidade de respostas diferente do número de itens do teste.';
    END IF;
    SET NEW.Pontuacao = (SELECT SUM(v) FROM JSON_TABLE(NEW.Respostas, '$[*]' COLUMNS (v INT PATH '$')) jt);
    SET NEW.Classificacao = (SELECT Classificacao FROM Teste_Faixa
                              WHERE Codigo = NEW.CodigoTeste AND NEW.Pontuacao BETWEEN PontosMin AND PontosMax LIMIT 1);
    SET NEW.Status = 'Respondido';
    SET NEW.DataResposta = COALESCE(NEW.DataResposta, CURRENT_DATE);
  END IF;
END$$

CREATE TRIGGER TRG_Corrige_Teste_Update
BEFORE UPDATE ON Aplicacao_Teste
FOR EACH ROW
BEGIN
  DECLARE v_itens INT;
  IF OLD.Status = 'Respondido' AND NOT (NEW.Respostas <=> OLD.Respostas) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Este teste já foi respondido.';
  END IF;
  IF NEW.Respostas IS NOT NULL AND OLD.Respostas IS NULL THEN
    SELECT NumItens INTO v_itens FROM Teste_Psicologico WHERE Codigo = NEW.CodigoTeste;
    IF JSON_LENGTH(NEW.Respostas) <> v_itens THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Quantidade de respostas diferente do número de itens do teste.';
    END IF;
    SET NEW.Pontuacao = (SELECT SUM(v) FROM JSON_TABLE(NEW.Respostas, '$[*]' COLUMNS (v INT PATH '$')) jt);
    SET NEW.Classificacao = (SELECT Classificacao FROM Teste_Faixa
                              WHERE Codigo = NEW.CodigoTeste AND NEW.Pontuacao BETWEEN PontosMin AND PontosMax LIMIT 1);
    SET NEW.Status = 'Respondido';
    SET NEW.DataResposta = COALESCE(NEW.DataResposta, CURRENT_DATE);
  END IF;
END$$

-- 6.11 Autenticação: aprovação obrigatória do cadastro do paciente
--      • Todo cadastro novo nasce PENDENTE_APROVACAO (a menos que venha aprovado por um psicólogo ATIVO).
--      • Transições permitidas: PENDENTE → ATIVO | REJEITADO;  ATIVO → INATIVO;  INATIVO | REJEITADO → ATIVO.
--      • Ativar exige CRP_Psicologo_Aprovador de um psicólogo ATIVO; a Data_Aprovacao é registrada automaticamente.
CREATE TRIGGER TRG_Paciente_Cadastro
BEFORE INSERT ON Paciente
FOR EACH ROW
BEGIN
  IF NEW.Status = 'ATIVO' THEN
    IF NEW.CRP_Psicologo_Aprovador IS NULL
       OR NOT EXISTS (SELECT 1 FROM Psicologo WHERE CRP = NEW.CRP_Psicologo_Aprovador AND Status = 'ATIVO') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Paciente só pode ser ativado com a aprovação de um psicólogo ativo.';
    END IF;
    SET NEW.Data_Aprovacao = COALESCE(NEW.Data_Aprovacao, NOW());
  ELSEIF NEW.Status = 'PENDENTE_APROVACAO' THEN
    SET NEW.Data_Aprovacao = NULL, NEW.CRP_Psicologo_Aprovador = NULL;
  END IF;
END$$

CREATE TRIGGER TRG_Paciente_Aprovacao
BEFORE UPDATE ON Paciente
FOR EACH ROW
BEGIN
  IF NEW.Status <> OLD.Status THEN
    IF NOT ( (OLD.Status = 'PENDENTE_APROVACAO' AND NEW.Status IN ('ATIVO','REJEITADO'))
          OR (OLD.Status = 'ATIVO'              AND NEW.Status = 'INATIVO')
          OR (OLD.Status IN ('INATIVO','REJEITADO') AND NEW.Status = 'ATIVO') ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Transição de status de cadastro inválida.';
    END IF;

    IF NEW.Status IN ('ATIVO','REJEITADO') THEN
      IF NEW.CRP_Psicologo_Aprovador IS NULL
         OR NOT EXISTS (SELECT 1 FROM Psicologo WHERE CRP = NEW.CRP_Psicologo_Aprovador AND Status = 'ATIVO') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A aprovação ou recusa do cadastro exige um psicólogo ativo responsável.';
      END IF;
    END IF;

    IF NEW.Status = 'ATIVO' THEN
      SET NEW.Data_Aprovacao = NOW(), NEW.MotivoRejeicao = NULL;
    ELSEIF NEW.Status = 'REJEITADO' THEN
      SET NEW.Data_Aprovacao = NULL;
    END IF;

    INSERT INTO Auditoria (Acao, UsuarioId, UsuarioTipo, Detalhes, Sucesso)
    VALUES (CASE NEW.Status WHEN 'ATIVO' THEN 'APROVAR_CADASTRO_PACIENTE' WHEN 'REJEITADO' THEN 'RECUSAR_CADASTRO_PACIENTE' ELSE 'ALTERAR_STATUS_PACIENTE' END,
            COALESCE(NEW.CRP_Psicologo_Aprovador, 'sistema'),
            IF(NEW.CRP_Psicologo_Aprovador IS NULL, 'sistema', 'psicologo'),
            CONCAT(NEW.Nome, ' (', NEW.CPF, '): ', OLD.Status, ' → ', NEW.Status), TRUE);
  END IF;
END$$

-- 6.12 Autenticação: cadastro de profissional pendente só é validado por um administrador
CREATE TRIGGER TRG_Psicologo_Aprovacao
BEFORE UPDATE ON Psicologo
FOR EACH ROW
BEGIN
  IF OLD.Status = 'PENDENTE_APROVACAO' AND NEW.Status IN ('ATIVO','REJEITADO') THEN
    IF NEW.CRP_Psicologo_Aprovador IS NULL
       OR NOT EXISTS (SELECT 1 FROM Psicologo WHERE CRP = NEW.CRP_Psicologo_Aprovador AND Status = 'ATIVO' AND IsAdmin) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Somente um administrador ativo valida cadastros profissionais.';
    END IF;
    SET NEW.Data_Aprovacao = IF(NEW.Status = 'ATIVO', NOW(), NULL);
  END IF;
END$$

-- 6.13 Agenda e chat: somente pacientes com cadastro ATIVO participam do atendimento
CREATE TRIGGER TRG_Consulta_Paciente_Ativo
BEFORE INSERT ON Consulta
FOR EACH ROW
PRECEDES TRG_Verifica_Data_Consulta
BEGIN
  IF NEW.Status IN ('Pendente','Agendada','Aguardando_Paciente')
     AND NOT EXISTS (SELECT 1 FROM Paciente WHERE CPF = NEW.CPF_Paciente AND Status = 'ATIVO') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Somente pacientes com cadastro aprovado podem agendar consultas.';
  END IF;
END$$

-- 6.14 Prontuário por sessão: validação dos anexos + histórico automático
--      A API informa quem executa a operação com: SET @prisma_usuario_id = '<CRP>';
CREATE TRIGGER TRG_Anexo_Valida
BEFORE INSERT ON Registro_Clinico_Anexo
FOR EACH ROW
BEGIN
  DECLARE v_cpf VARCHAR(14);
  DECLARE v_status VARCHAR(20);
  DECLARE v_data DATETIME;
  SELECT CPF_Paciente, Status, DataHora INTO v_cpf, v_status, v_data FROM Consulta WHERE ID_Consulta = NEW.ID_Consulta;
  IF v_cpf IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Sessão (consulta) não encontrada.';
  END IF;
  IF v_status NOT IN ('Realizada','Agendada') OR DATE(v_data) > CURRENT_DATE THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Anexos só podem ser vinculados a sessões realizadas ou em andamento (até hoje).';
  END IF;
  SET NEW.CPF_Paciente = v_cpf, NEW.Versao = 1, NEW.Removido = FALSE, NEW.MotivoRemocao = NULL;
END$$

CREATE TRIGGER TRG_Anexo_Versao
BEFORE UPDATE ON Registro_Clinico_Anexo
FOR EACH ROW
BEGIN
  IF NEW.ID_Consulta <> OLD.ID_Consulta OR NEW.CPF_Paciente <> OLD.CPF_Paciente OR NEW.Extensao <> OLD.Extensao THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Não é permitido mover o anexo para outra sessão nem alterar sua extensão.';
  END IF;
  IF NEW.HashSHA256 <> OLD.HashSHA256 THEN
    SET NEW.Versao = OLD.Versao + 1;
  END IF;
END$$

CREATE TRIGGER TRG_Anexo_Sem_Exclusao
BEFORE DELETE ON Registro_Clinico_Anexo
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Anexos do prontuário não são excluídos: use a remoção lógica (Removido = TRUE).';
END$$

CREATE TRIGGER TRG_Anexo_Historico_Insert
AFTER INSERT ON Registro_Clinico_Anexo
FOR EACH ROW
BEGIN
  INSERT INTO Sessao_Historico (ID_Consulta, Acao, UsuarioId, Detalhes)
  VALUES (NEW.ID_Consulta, 'ANEXO_ENVIADO', COALESCE(@prisma_usuario_id, NEW.CRP_Psicologo), NEW.NomeArquivo);
END$$

CREATE TRIGGER TRG_Anexo_Historico_Update
AFTER UPDATE ON Registro_Clinico_Anexo
FOR EACH ROW
BEGIN
  DECLARE v_usuario VARCHAR(20) DEFAULT COALESCE(@prisma_usuario_id, NEW.CRP_Psicologo);
  IF NEW.Removido AND NOT OLD.Removido THEN
    INSERT INTO Sessao_Historico (ID_Consulta, Acao, UsuarioId, Detalhes)
    VALUES (NEW.ID_Consulta, 'ANEXO_REMOVIDO', v_usuario, CONCAT(NEW.NomeArquivo, IFNULL(CONCAT(' — ', NEW.MotivoRemocao), '')));
  ELSEIF OLD.Removido AND NOT NEW.Removido THEN
    INSERT INTO Sessao_Historico (ID_Consulta, Acao, UsuarioId, Detalhes) VALUES (NEW.ID_Consulta, 'ANEXO_RESTAURADO', v_usuario, NEW.NomeArquivo);
  ELSEIF NEW.HashSHA256 <> OLD.HashSHA256 THEN
    INSERT INTO Sessao_Historico (ID_Consulta, Acao, UsuarioId, Detalhes)
    VALUES (NEW.ID_Consulta, IF(NEW.Extensao = 'txt', 'ANEXO_EDITADO', 'ANEXO_SUBSTITUIDO'), v_usuario, CONCAT(NEW.NomeArquivo, ' → versão ', NEW.Versao));
  END IF;
END$$

CREATE TRIGGER TRG_RC_Historico_Insert
AFTER INSERT ON Registro_Clinico
FOR EACH ROW
BEGIN
  INSERT INTO Sessao_Historico (ID_Consulta, Acao, UsuarioId, Detalhes)
  VALUES (NEW.ID_Consulta, 'REGISTRO_CRIADO', COALESCE(@prisma_usuario_id, NEW.CRP_Psicologo), CONCAT('Anotação clínica da sessão ', IFNULL(NEW.NumeroSessao, ''), ' criada'));
END$$

CREATE TRIGGER TRG_RC_Historico_Update
AFTER UPDATE ON Registro_Clinico
FOR EACH ROW
BEGIN
  INSERT INTO Sessao_Historico (ID_Consulta, Acao, UsuarioId, Detalhes)
  VALUES (NEW.ID_Consulta, 'REGISTRO_EDITADO', COALESCE(@prisma_usuario_id, NEW.CRP_Psicologo), 'Anotação clínica atualizada');
END$$

CREATE TRIGGER TRG_RC_Sem_Exclusao
BEFORE DELETE ON Registro_Clinico
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Registros clínicos não são excluídos (guarda do prontuário).';
END$$

-- 6.15 Agenda: bloqueios da psicóloga, antecedência de 48 h e confirmação de presença (36 h)

-- Nova consulta não pode tocar um período bloqueado
CREATE TRIGGER TRG_Bloqueio_Agenda
BEFORE INSERT ON Consulta
FOR EACH ROW
FOLLOWS TRG_Evita_Choque_Horario
BEGIN
  DECLARE v_msg VARCHAR(128);
  IF NEW.Status IN ('Pendente','Agendada','Aguardando_Paciente')
     AND fn_bloqueio_agenda(NEW.CRP_Psicologo, NEW.DataHora,
                            NEW.DataHora + INTERVAL CAST(SUBSTRING_INDEX(NEW.Duracao, ' ', 1) AS UNSIGNED) MINUTE) IS NOT NULL THEN
    SET v_msg = fn_msg_bloqueio();
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;
END$$

-- Paciente só agenda com no mínimo AntecedenciaAgendamentoHoras (padrão 48 h)
CREATE TRIGGER TRG_Antecedencia_Agendamento
BEFORE INSERT ON Consulta
FOR EACH ROW
FOLLOWS TRG_Bloqueio_Agenda
BEGIN
  DECLARE v_h INT;
  DECLARE v_msg VARCHAR(128);
  IF COALESCE(@prisma_usuario_tipo, 'psicologo') = 'paciente' AND NEW.Status IN ('Pendente','Agendada','Aguardando_Paciente') THEN
    SELECT AntecedenciaAgendamentoHoras INTO v_h FROM Psicologo WHERE CRP = NEW.CRP_Psicologo;
    IF NEW.DataHora < NOW() + INTERVAL v_h HOUR THEN
      SET v_msg = CONCAT('Novos agendamentos exigem pelo menos ', v_h, ' horas de antecedência.');
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
    END IF;
  END IF;
END$$

-- Situação inicial da confirmação de presença
CREATE TRIGGER TRG_Consulta_Confirmacao_Insert
BEFORE INSERT ON Consulta
FOR EACH ROW
FOLLOWS TRG_Antecedencia_Agendamento
BEGIN
  IF NEW.StatusConfirmacao IS NULL THEN
    SET NEW.StatusConfirmacao = CASE NEW.Status WHEN 'Agendada' THEN 'AGUARDANDO' WHEN 'Realizada' THEN 'CONFIRMADA' ELSE NULL END;
  END IF;
END$$

-- Aceitar uma solicitação que caiu dentro de um bloqueio criado depois dela
CREATE TRIGGER TRG_Bloqueio_Agenda_Update
BEFORE UPDATE ON Consulta
FOR EACH ROW
FOLLOWS TRG_Evita_Choque_Horario_Update
BEGIN
  DECLARE v_msg VARCHAR(128);
  IF NEW.Status = 'Agendada' AND OLD.Status IN ('Pendente','Aguardando_Paciente') AND NEW.DataHora = OLD.DataHora
     AND fn_bloqueio_agenda(NEW.CRP_Psicologo, NEW.DataHora, NEW.DataHoraFim) IS NOT NULL THEN
    SET v_msg = fn_msg_bloqueio();
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;
END$$

-- Ciclo da confirmação: reinicia ao (re)agendar, valida a confirmação e marca se foi após o prazo
CREATE TRIGGER TRG_Consulta_Confirmacao_Update
BEFORE UPDATE ON Consulta
FOR EACH ROW
FOLLOWS TRG_Bloqueio_Agenda_Update
BEGIN
  DECLARE v_prazo INT;
  IF NEW.Status IN ('Cancelada','Recusada','Pendente','Aguardando_Paciente') THEN
    SET NEW.StatusConfirmacao = NULL;
  ELSEIF NEW.Status = 'Agendada' AND (OLD.Status <> 'Agendada' OR NEW.DataHora <> OLD.DataHora)
         AND NOT (NEW.StatusConfirmacao = 'CONFIRMADA' AND NOT (NEW.ConfirmadaEm <=> OLD.ConfirmadaEm)) THEN
    SET NEW.StatusConfirmacao = 'AGUARDANDO', NEW.ConfirmadaEm = NULL, NEW.ConfirmadaPor = NULL,
        NEW.ConfirmacaoTardia = FALSE, NEW.LembreteConfirmacaoEm = NULL, NEW.AlertaConfirmacaoEm = NULL;
  END IF;

  IF NEW.StatusConfirmacao = 'CONFIRMADA' AND NOT (OLD.StatusConfirmacao <=> 'CONFIRMADA') AND NEW.Status = 'Agendada' THEN
    IF NEW.DataHora <= NOW() THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Esta consulta já começou ou já passou.';
    END IF;
    SELECT PrazoConfirmacaoHoras INTO v_prazo FROM Psicologo WHERE CRP = NEW.CRP_Psicologo;
    SET NEW.ConfirmadaEm = COALESCE(NEW.ConfirmadaEm, NOW()),
        NEW.ConfirmadaPor = COALESCE(NEW.ConfirmadaPor, IF(COALESCE(@prisma_usuario_tipo, 'psicologo') = 'paciente', 'Paciente', 'Psicóloga')),
        NEW.ConfirmacaoTardia = (NEW.ConfirmadaEm >= NEW.DataHora - INTERVAL v_prazo HOUR);
  END IF;
END$$

-- Bloqueios: não podem estar no passado nem se sobrepor a outro bloqueio da mesma psicóloga
CREATE TRIGGER TRG_Bloqueio_Valida_Insert
BEFORE INSERT ON BloqueioAgenda
FOR EACH ROW
BEGIN
  IF NEW.Data_Fim <= NOW() THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Não é possível bloquear um período que já passou.';
  END IF;
  IF EXISTS (SELECT 1 FROM BloqueioAgenda WHERE CRP_Psicologo = NEW.CRP_Psicologo
             AND Data_Inicio < NEW.Data_Fim AND Data_Fim > NEW.Data_Inicio) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Já existe um bloqueio neste período. Edite o bloqueio existente.';
  END IF;
END$$

CREATE TRIGGER TRG_Bloqueio_Valida_Update
BEFORE UPDATE ON BloqueioAgenda
FOR EACH ROW
BEGIN
  IF NEW.Data_Fim <= NOW() AND (NEW.Data_Inicio <> OLD.Data_Inicio OR NEW.Data_Fim <> OLD.Data_Fim) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Não é possível bloquear um período que já passou.';
  END IF;
  IF EXISTS (SELECT 1 FROM BloqueioAgenda WHERE CRP_Psicologo = NEW.CRP_Psicologo AND ID_Bloqueio <> OLD.ID_Bloqueio
             AND Data_Inicio < NEW.Data_Fim AND Data_Fim > NEW.Data_Inicio) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Já existe um bloqueio neste período. Edite o bloqueio existente.';
  END IF;
END$$

-- Auditoria dos bloqueios (LGPD / rastreabilidade da agenda)
CREATE TRIGGER TRG_Bloqueio_Auditoria_Insert
AFTER INSERT ON BloqueioAgenda
FOR EACH ROW
BEGIN
  INSERT INTO Auditoria (Acao, UsuarioId, UsuarioTipo, Detalhes)
  VALUES ('BLOQUEAR_AGENDA', COALESCE(@prisma_usuario_id, NEW.CRP_Psicologo), 'psicologo',
          CONCAT('Bloqueio ', NEW.ID_Bloqueio, ': ', DATE_FORMAT(NEW.Data_Inicio, '%d/%m/%Y %H:%i'), ' a ', DATE_FORMAT(NEW.Data_Fim, '%d/%m/%Y %H:%i')));
END$$

CREATE TRIGGER TRG_Bloqueio_Auditoria_Delete
AFTER DELETE ON BloqueioAgenda
FOR EACH ROW
BEGIN
  INSERT INTO Auditoria (Acao, UsuarioId, UsuarioTipo, Detalhes)
  VALUES ('REMOVER_BLOQUEIO', COALESCE(@prisma_usuario_id, OLD.CRP_Psicologo), 'psicologo',
          CONCAT('Bloqueio ', OLD.ID_Bloqueio, ' removido: ', DATE_FORMAT(OLD.Data_Inicio, '%d/%m/%Y %H:%i'), ' a ', DATE_FORMAT(OLD.Data_Fim, '%d/%m/%Y %H:%i')));
END$$

DELIMITER ;

-- =========================================================================
-- 6.16 EVENTO — lembrete e alerta de confirmação de presença (a cada 5 min)
--      Requer o agendador de eventos ligado (padrão no MySQL 8.4):
--        SET GLOBAL event_scheduler = ON;
--      A API também chama sp_processar_confirmacoes() ao listar a agenda.
-- =========================================================================
CREATE EVENT EVT_Confirmacao_Presenca
ON SCHEDULE EVERY 5 MINUTE
COMMENT 'Regra das 36 h: lembrete ao paciente e PENDENTE_CONFIRMACAO para a psicóloga'
DO CALL sp_processar_confirmacoes();

-- =========================================================================
-- 7. VIEWS
-- =========================================================================

CREATE OR REPLACE VIEW vw_agenda AS
SELECT c.ID_Consulta, c.DataHora, c.DataHoraFim, c.Duracao, c.Status, c.Modalidade,
       c.DataHoraSugerida, c.Solicitante, c.Observacoes,
       p.CPF AS CPF_Paciente, p.Nome AS Paciente, ps.Nome AS Psicologa,
       ROUND(TIMESTAMPDIFF(MINUTE, NOW(), c.DataHora) / 60, 1) AS HorasAteConsulta,
       (c.Status = 'Agendada' AND TIMESTAMPDIFF(MINUTE, NOW(), c.DataHora) < ps.LimiteAlteracaoHoras * 60) AS BloqueadaParaPaciente,
       (c.Status IN ('Pendente','Agendada') AND TIMESTAMPDIFF(MINUTE, NOW(), c.DataHora) <= ps.AntecedenciaReagendamentoHoras * 60) AS ReagendamentoBloqueado,
       c.StatusConfirmacao,
       IF(c.Status = 'Agendada', c.DataHora - INTERVAL ps.PrazoConfirmacaoHoras HOUR, NULL) AS PrazoConfirmacao,
       c.ConfirmadaEm, c.ConfirmadaPor, c.ConfirmacaoTardia
FROM Consulta c
JOIN Paciente  p  ON p.CPF  = c.CPF_Paciente
JOIN Psicologo ps ON ps.CRP = c.CRP_Psicologo;

CREATE OR REPLACE VIEW vw_progresso_paciente AS
SELECT p.CPF, p.Nome,
       COUNT(m.ID_Meta)                                   AS TotalMetas,
       SUM(m.Status = 'Ativa')                            AS MetasAtivas,
       SUM(m.Status = 'Concluida')                        AS MetasConcluidas,
       ROUND(AVG(CASE WHEN m.Status <> 'Cancelada' THEN m.ProgressoPercentual END)) AS ProgressoGeral
FROM Paciente p
LEFT JOIN Metas m ON m.CPF_Paciente = p.CPF
GROUP BY p.CPF, p.Nome;

CREATE OR REPLACE VIEW vw_comparecimento AS
SELECT CRP_Psicologo,
       SUM(Status = 'Realizada') AS Realizadas,
       SUM(Status = 'Faltou')    AS Faltas,
       ROUND(100 * SUM(Status = 'Realizada') / NULLIF(SUM(Status IN ('Realizada','Faltou')), 0)) AS TaxaComparecimento
FROM Consulta
GROUP BY CRP_Psicologo;

-- Painel "Solicitações de Cadastro Pendentes"
CREATE OR REPLACE VIEW vw_cadastros_pendentes AS
SELECT 'Paciente' AS TipoConta, CPF AS Identificador, Nome, CPF, Email, Telefone, DataNascimento, NULL AS CRP, Data_Solicitacao
FROM Paciente WHERE Status = 'PENDENTE_APROVACAO'
UNION ALL
SELECT 'Psicólogo', CRP, Nome, CPF, Email, Telefone, NULL, CRP, Data_Solicitacao
FROM Psicologo WHERE Status = 'PENDENTE_APROVACAO';

-- Consulta única usada pelo login (a API compara o hash e verifica o Status)
CREATE OR REPLACE VIEW vw_autenticacao AS
SELECT 'psicologo' AS Tipo, CRP AS Identificador, Nome, LOWER(Email) AS Email, SenhaHash, Status, IsAdmin FROM Psicologo
UNION ALL
SELECT 'paciente', CPF, Nome, LOWER(Email), SenhaHash, Status, FALSE FROM Paciente;

-- Sessões do prontuário (alimenta a sub-navbar): consultas realizadas ou em andamento até hoje
CREATE OR REPLACE VIEW vw_prontuario_sessoes AS
SELECT c.ID_Consulta, c.CPF_Paciente, c.CRP_Psicologo, c.DataHora, c.Duracao, c.Status, c.Modalidade,
       rc.ID_RC, rc.NumeroSessao,
       (SELECT COUNT(*) FROM Registro_Clinico_Anexo a WHERE a.ID_Consulta = c.ID_Consulta AND NOT a.Removido) AS QtdAnexos,
       (DATE(c.DataHora) = CURRENT_DATE) AS Atual
FROM Consulta c
LEFT JOIN Registro_Clinico rc ON rc.ID_Consulta = c.ID_Consulta
WHERE c.Status IN ('Realizada','Agendada') AND DATE(c.DataHora) <= CURRENT_DATE;

-- Conversa do chat em ordem cronológica (a API filtra os dois participantes e ordena ASC)
CREATE OR REPLACE VIEW vw_chat_mensagens AS
SELECT ID_Mensagem, DataHora AS DataEnviado, Texto, Remetente, Destinatario, Lida
FROM Mensagem;

-- Painel da psicóloga: consultas confirmadas e futuras aguardando confirmação de presença
--   Situacao: AGUARDANDO (antes do lembrete) · LEMBRETE (tag amarela) · PENDENTE_CONFIRMACAO (tag vermelha)
CREATE OR REPLACE VIEW vw_confirmacoes_pendentes AS
SELECT c.ID_Consulta, c.DataHora, c.Duracao, c.Modalidade, c.CPF_Paciente, p.Nome AS Paciente, p.Telefone, c.CRP_Psicologo,
       c.DataHora - INTERVAL ps.PrazoConfirmacaoHoras HOUR AS PrazoConfirmacao,
       c.LembreteConfirmacaoEm, c.AlertaConfirmacaoEm,
       CASE
         WHEN NOW() >= c.DataHora - INTERVAL ps.PrazoConfirmacaoHoras HOUR THEN 'PENDENTE_CONFIRMACAO'
         WHEN NOW() >= c.DataHora - INTERVAL (ps.PrazoConfirmacaoHoras + ps.LembreteConfirmacaoHoras) HOUR THEN 'LEMBRETE'
         ELSE 'AGUARDANDO'
       END AS Situacao
FROM Consulta c
JOIN Paciente  p  ON p.CPF  = c.CPF_Paciente
JOIN Psicologo ps ON ps.CRP = c.CRP_Psicologo
WHERE c.Status = 'Agendada' AND c.DataHora > NOW() AND c.StatusConfirmacao <> 'CONFIRMADA';

-- Períodos indisponíveis para o paciente (sem o motivo, que é privado da psicóloga)
CREATE OR REPLACE VIEW vw_agenda_indisponivel AS
SELECT ID_Bloqueio, CRP_Psicologo, Data_Inicio, Data_Fim, DiaInteiro
FROM BloqueioAgenda
WHERE Data_Fim > NOW();

-- Visão do paciente sobre os próprios documentos (sem conteúdo clínico)
CREATE OR REPLACE VIEW vw_documentos_paciente AS
SELECT d.ID_Doc, d.CPF_Paciente, d.Tipo, d.Origem, d.NomeArquivo, d.TamanhoKb, d.DataEnvio, d.Armazenamento
FROM Documentos d;

-- =========================================================================
-- 8. DADOS INICIAIS (fictícios, para demonstração)
--    Carregados SOMENTE quando o banco está vazio (nenhum psicólogo cadastrado).
--    Em um banco com dados reais nada é inserido nem alterado.
-- =========================================================================
DELIMITER $$
DROP PROCEDURE IF EXISTS prisma_carga_inicial$$
CREATE PROCEDURE prisma_carga_inicial()
carga: BEGIN
  IF EXISTS (SELECT 1 FROM Psicologo) THEN
    INSERT INTO Auditoria (Acao, UsuarioId, UsuarioTipo, Detalhes, Sucesso)
    VALUES ('ATUALIZAR_SCHEMA', 'sistema', 'sistema', 'database/schema.sql executado em banco existente: estrutura atualizada, dados preservados', TRUE);
    LEAVE carga;
  END IF;

  -- Senha de demonstração de todas as contas: prisma123
  INSERT INTO Psicologo (CRP, Nome, Especialidade, Abordagem, Email, Telefone, CPF, Consultorio, Bio, LimiteAlteracaoHoras, Status, IsAdmin, SenhaHash, Data_Solicitacao, Data_Aprovacao) VALUES
  ('06/12345', 'Dra. Shelley Christina', 'Neuropsicologia e Psicologia Social', 'Terapia Cognitivo-Comportamental (TCC)',
   'shelley.christina@prisma.com.br', '(43) 99888-7766', '012.345.678-90',
   'Rua XV de Novembro, 120 — Santana do Itararé/PR', 'Psicóloga com 14 anos de experiência em atendimento online e presencial.', 24,
   'ATIVO', TRUE, 'sha256$a1f4c9e2$31ebf4bb457598554c34d0e2b6944aa767d0f77eee5c1ac3c1274238714a2553', NOW() - INTERVAL 180 DAY, NOW() - INTERVAL 180 DAY);

  -- Autocadastro de profissional aguardando validação do administrador
  INSERT INTO Psicologo (CRP, Nome, Especialidade, Abordagem, Email, Telefone, CPF, Status, IsAdmin, SenhaHash, Data_Solicitacao) VALUES
  ('08/54321', 'Dr. Marcos Vieira', 'Psicologia Clínica', 'Psicanálise', 'marcos.vieira@email.com', '(43) 99111-2233', '321.654.987-00',
   'PENDENTE_APROVACAO', FALSE, 'sha256$4ea18293$489ff242ebc4c528a31f5711350dd388a633c0c7146f5602c1bacbb5b9febac7', NOW() - INTERVAL 5 HOUR);

  -- Pacientes em acompanhamento (cadastro aprovado pela psicóloga)
  INSERT INTO Paciente (CPF, Nome, Email, Telefone, DataNascimento, QueixaPrincipal, ConsentimentoLGPD, DataConsentimento, Status, Data_Solicitacao, Data_Aprovacao, CRP_Psicologo_Aprovador, SenhaHash) VALUES
  ('111.222.333-44', 'Ana Carolina Mendes', 'ana.carolina@email.com',     '(43) 98765-4321', '1995-04-12', 'Ansiedade generalizada e estresse ocupacional',          TRUE, NOW() - INTERVAL 120 DAY, 'ATIVO', NOW() - INTERVAL 120 DAY, NOW() - INTERVAL 119 DAY, '06/12345', 'sha256$b7d2e810$57bd9a658228a06b83d929b9d3a14b5313a058abe2dbfd6af6becfdb2ffed01f'),
  ('222.333.444-55', 'Bruno Ferreira',      'bruno.ferreira@email.com',   '(43) 97654-3210', '1989-11-23', 'Episódios depressivos e isolamento social',              TRUE, NOW() - INTERVAL 119 DAY, 'ATIVO', NOW() - INTERVAL 119 DAY, NOW() - INTERVAL 118 DAY, '06/12345', 'sha256$c3a9f147$7ee05ebffcac54da5c96e6dd33ce24f2045c8e6ee325df4a8b9e7d97963199d8'),
  ('333.444.555-66', 'Camila Rodrigues',    'camila.rodrigues@email.com', '(43) 96543-2109', '2001-08-15', 'Insegurança nas tomadas de decisão e baixa autoestima',  TRUE, NOW() - INTERVAL 118 DAY, 'ATIVO', NOW() - INTERVAL 118 DAY, NOW() - INTERVAL 117 DAY, '06/12345', 'sha256$d58e2b06$a834f4f8006667e1997353eff543d9b687f4f039e515611d4c13054c3f52ad70'),
  ('444.555.666-77', 'Diego Souza',         'diego.souza@email.com',      '(43) 95432-1098', '1987-03-30', 'Dificuldades de comunicação conjugal e assertividade',   TRUE, NOW() - INTERVAL 117 DAY, 'ATIVO', NOW() - INTERVAL 117 DAY, NOW() - INTERVAL 116 DAY, '06/12345', 'sha256$e2c71d93$09c88f609fd6038a97176b64ce3de50cd6ba4652363b9fffa85edaddddd30231'),
  ('555.666.777-88', 'Elena Martins',       'elena.martins@email.com',    '(43) 94321-0987', '1992-06-18', 'Transição profissional e sobrecarga emocional',          TRUE, NOW() - INTERVAL 116 DAY, 'ATIVO', NOW() - INTERVAL 116 DAY, NOW() - INTERVAL 115 DAY, '06/12345', 'sha256$f9b3a0c4$06dd57049b74f0edec8489bf231c4beed994b5bc755a5d7364d2a72922df4f3e'),
  ('777.888.999-00', 'Maria Silva',         'maria.silva@email.com',      '(43) 93210-9876', '1994-09-05', 'Regulação emocional e acompanhamento preventivo',        TRUE, NOW() - INTERVAL 115 DAY, 'ATIVO', NOW() - INTERVAL 115 DAY, NOW() - INTERVAL 114 DAY, '06/12345', 'sha256$0a6d4e5f$0ba7470f3e6e5d39e0707ba30c5602a71642122fe732360aa761b68e352d9442');

  -- Solicitações de cadastro (status inicial PENDENTE_APROVACAO)
  INSERT INTO Paciente (CPF, Nome, Email, Telefone, DataNascimento, ConsentimentoLGPD, DataConsentimento, Data_Solicitacao, SenhaHash) VALUES
  ('888.999.000-11', 'Lucas Almeida',  'lucas.almeida@email.com',  '(43) 99876-1122', '1998-02-14', TRUE, NOW() - INTERVAL 26 HOUR, NOW() - INTERVAL 26 HOUR, 'sha256$1b7e5f60$514e590ff249a7698ca3997ceb36b1898963da1b30ebcdbdf7c1090caa89702d'),
  ('999.000.111-22', 'Fernanda Costa', 'fernanda.costa@email.com', '(43) 98555-7788', '1990-12-01', TRUE, NOW() - INTERVAL 3 HOUR,  NOW() - INTERVAL 3 HOUR,  'sha256$2c8f6071$b6488329c8348fc232357546e766ad22da334da9b04fc3a080a637f8a4a9d752'),
  ('000.111.222-33', 'Rafael Nunes',   'rafael.nunes@email.com',   '(43) 97444-3322', '1985-07-22', TRUE, NOW() - INTERVAL 10 DAY,  NOW() - INTERVAL 10 DAY,  'sha256$3d907182$bc0dd60d9b8727b7ea25894a6b6dbe797a6996e3dda22099df82fc3287d289e5');

  -- Cadastro recusado pela psicóloga (passa pelo TRG_Paciente_Aprovacao)
  CALL sp_recusar_cadastro_paciente('000.111.222-33', '06/12345', 'Demanda fora da área de atuação — encaminhado para outro serviço.');

  -- Consultas históricas (datas relativas à execução do script)
  INSERT INTO Consulta (ID_Consulta, DataHora, Duracao, Status, Modalidade, Solicitante, Observacoes, CPF_Paciente, CRP_Psicologo) VALUES
  ( 95, TIMESTAMP(CURRENT_DATE - INTERVAL 28 DAY, '08:00'), '60 min', 'Realizada', 'Presencial', 'Psicóloga', 'Sessão 22 — psicoeducação sobre ansiedade.',       '111.222.333-44', '06/12345'),
  ( 96, TIMESTAMP(CURRENT_DATE - INTERVAL 10 DAY, '14:00'), '90 min', 'Realizada', 'Presencial', 'Paciente',  'Terapia de casal — mapeamento de conflitos.',       '444.555.666-77', '06/12345'),
  ( 97, TIMESTAMP(CURRENT_DATE - INTERVAL  3 DAY, '15:30'), '60 min', 'Faltou',    'Online',     'Paciente',  'Paciente não compareceu e não avisou.',             '555.666.777-88', '06/12345'),
  (101, TIMESTAMP(CURRENT_DATE - INTERVAL  7 DAY, '08:00'), '60 min', 'Realizada', 'Presencial', 'Psicóloga', 'Sessão 24 — reestruturação cognitiva e RPD.',       '111.222.333-44', '06/12345'),
  (102, TIMESTAMP(CURRENT_DATE - INTERVAL 14 DAY, '09:30'), '60 min', 'Realizada', 'Presencial', 'Psicóloga', 'Sessão 8 — ativação comportamental.',               '222.333.444-55', '06/12345'),
  (103, TIMESTAMP(CURRENT_DATE - INTERVAL 21 DAY, '11:00'), '60 min', 'Realizada', 'Online',     'Psicóloga', 'Sessão 12 — inventário de forças.',                 '333.444.555-66', '06/12345');

  -- Consultas futuras (passam pelos triggers de data e choque de horário)
  INSERT INTO Consulta (ID_Consulta, DataHora, Duracao, Status, Modalidade, Solicitante, Observacoes, CPF_Paciente, CRP_Psicologo) VALUES
  (111, TIMESTAMP(DATE_FORMAT(NOW() + INTERVAL  3 HOUR, '%Y-%m-%d %H:00:00')), '60 min', 'Agendada', 'Online',     'Paciente',  'Sessão individual de acompanhamento.',                                    '333.444.555-66', '06/12345'),
  (104, TIMESTAMP(DATE_FORMAT(NOW() + INTERVAL 12 HOUR, '%Y-%m-%d %H:00:00')), '60 min', 'Agendada', 'Online',     'Paciente',  'Dentro de 24 h: paciente não cancela, não reagenda e não confirmou.',     '111.222.333-44', '06/12345'),
  (108, TIMESTAMP(CURRENT_DATE + INTERVAL 2 DAY, '14:00'),                     '60 min', 'Pendente', 'Online',     'Paciente',  'Solicitação para manejo de ansiedade pré-avaliação profissional.',        '111.222.333-44', '06/12345'),
  (105, TIMESTAMP(CURRENT_DATE + INTERVAL 3 DAY, '10:00'),                     '60 min', 'Agendada', 'Presencial', 'Paciente',  'Sessão individual presencial no consultório.',                            '777.888.999-00', '06/12345'),
  (106, TIMESTAMP(CURRENT_DATE + INTERVAL 4 DAY, '14:00'),                     '90 min', 'Agendada', 'Presencial', 'Psicóloga', 'Terapia de casal — alinhamento de acordos.',                              '444.555.666-77', '06/12345'),
  (107, TIMESTAMP(CURRENT_DATE + INTERVAL 5 DAY, '09:00'),                     '30 min', 'Agendada', 'Online',     'Paciente',  'Feedback rápido de evolução.',                                            '555.666.777-88', '06/12345'),
  (113, TIMESTAMP(CURRENT_DATE + INTERVAL 2 DAY, '17:00'),                     '60 min', 'Agendada', 'Online',     'Psicóloga', 'Sessão 9 — revisão da agenda de atividades.',                             '222.333.444-55', '06/12345'),
  (112, TIMESTAMP(CURRENT_DATE + INTERVAL 6 DAY, '10:00'),                     '60 min', 'Pendente', 'Presencial', 'Paciente',  'Retomada do acompanhamento semanal.',                                     '222.333.444-55', '06/12345'),
  (109, TIMESTAMP(CURRENT_DATE + INTERVAL 2 DAY, '09:00'),                     '60 min', 'Pendente', 'Presencial', 'Paciente',  'A psicóloga sugeriu remanejar devido a um congresso.',                    '111.222.333-44', '06/12345'),
  (110, TIMESTAMP(CURRENT_DATE + INTERVAL 3 DAY, '17:00'),                     '60 min', 'Pendente', 'Online',     'Paciente',  'Solicitação não pôde ser atendida.',                                      '222.333.444-55', '06/12345');

  -- Fluxo da agenda aplicado sobre as solicitações (exercita os triggers de UPDATE)
  SET @prisma_usuario_tipo = 'psicologo';
  UPDATE Consulta SET Status = 'Aguardando_Paciente', DataHoraSugerida = TIMESTAMP(CURRENT_DATE + INTERVAL 3 DAY, '15:00') WHERE ID_Consulta = 109;
  UPDATE Consulta SET Status = 'Recusada', MotivoCancelamento = 'Horário indisponível na grade clínica.' WHERE ID_Consulta = 110;
  SET @prisma_usuario_tipo = NULL;
  ALTER TABLE Consulta AUTO_INCREMENT = 201;

  -- Bloqueios da agenda (depois das consultas; nenhum toca uma consulta ativa)
  SET @prisma_usuario_id = '06/12345';
  INSERT INTO BloqueioAgenda (ID_Bloqueio, CRP_Psicologo, Data_Inicio, Data_Fim, DiaInteiro, Motivo) VALUES
  (1, '06/12345', TIMESTAMP(CURRENT_DATE + INTERVAL  7 DAY, '13:00'), TIMESTAMP(CURRENT_DATE + INTERVAL  7 DAY, '18:00'),    FALSE, 'Compromisso pessoal'),
  (2, '06/12345', TIMESTAMP(CURRENT_DATE + INTERVAL  8 DAY, '00:00'), TIMESTAMP(CURRENT_DATE + INTERVAL 10 DAY, '23:59:59'), TRUE,  'Congresso Brasileiro de Psicologia'),
  (3, '06/12345', TIMESTAMP(CURRENT_DATE + INTERVAL 15 DAY, '00:00'), TIMESTAMP(CURRENT_DATE + INTERVAL 15 DAY, '23:59:59'), TRUE,  'Feriado municipal');
  SET @prisma_usuario_id = NULL;
  ALTER TABLE BloqueioAgenda AUTO_INCREMENT = 11;

  -- Confirmação de presença: consulta 111 já confirmada pela paciente (dentro do prazo)
  SET @prisma_usuario_tipo = 'paciente';
  UPDATE Consulta SET StatusConfirmacao = 'CONFIRMADA', ConfirmadaEm = DataHora - INTERVAL 50 HOUR, LembreteConfirmacaoEm = DataHora - INTERVAL 60 HOUR WHERE ID_Consulta = 111;
  SET @prisma_usuario_tipo = NULL;
  -- Lembretes/alertas imediatos (a consulta 104, a ~12 h, fica PENDENTE_CONFIRMACAO)
  CALL sp_processar_confirmacoes();

  INSERT INTO Registro_Clinico (ID_RC, DataCriacao, DataUltMod, NumeroSessao, Conteudo, QueixaPrincipal, IntervencoesRealizadas, ProgressoObservado, TarefasParaCasa, ProximaSessao, Tags, CPF_Paciente, ID_Consulta, CRP_Psicologo) VALUES
  (1, CURRENT_DATE - INTERVAL 7 DAY, CURRENT_DATE - INTERVAL 7 DAY, 24,
   'Sessão focada em reestruturação cognitiva e manejo de ansiedade antecipatória no ambiente profissional.',
   'Paciente relatou semana difícil com episódios de ansiedade na segunda e quarta-feira, associados a reuniões no trabalho.',
   '• Revisão dos registros de pensamentos automáticos\n• Técnica de reestruturação cognitiva: questionamento socrático sobre catastrofização\n• Exercício de respiração diafragmática em sessão',
   'Paciente demonstrou maior capacidade de identificar distorções cognitivas. Relata que a técnica de respiração tem ajudado antes das reuniões.',
   '1. Continuar registro de pensamentos (3x/semana)\n2. Aplicar técnica de respiração nos momentos de gatilho\n3. Leitura: cap. 5 do material sobre ansiedade social',
   'Consulta #104', JSON_ARRAY('ansiedade','tcc'), '111.222.333-44', 101, '06/12345'),
  (2, CURRENT_DATE - INTERVAL 14 DAY, CURRENT_DATE - INTERVAL 14 DAY, 8,
   'Ativação comportamental e desativação de ciclos de ruminação depressiva.',
   'Relatou desânimo matinal e tendência a evitar contatos telefônicos durante o fim de semana.',
   '• Mapeamento de esquemas de inibição emocional\n• Agendamento de atividades prazerosas de baixa exigência',
   'Conseguiu realizar uma caminhada curta no parque, conforme combinado na sessão anterior.',
   '1. Registrar momentos de satisfação (escala 1 a 10) ao menos 1x ao dia',
   'A confirmar', JSON_ARRAY('depressão','ruminação'), '222.333.444-55', 102, '06/12345'),
  (3, CURRENT_DATE - INTERVAL 21 DAY, CURRENT_DATE - INTERVAL 21 DAY, 12,
   'Conclusão do ciclo inicial de fortalecimento de autoestima.',
   'Dúvidas sobre limites nas relações interpessoais familiares.',
   '• Treinamento de assertividade\n• Comunicação não-violenta: role-play de situações familiares',
   'Progresso notável. Completou todas as tarefas acordadas entre as sessões.',
   '1. Praticar resposta assertiva em situação de baixa tensão',
   'Consulta #111', JSON_ARRAY('autoestima','limites'), '333.444.555-66', 103, '06/12345'),
  (4, CURRENT_DATE - INTERVAL 28 DAY, CURRENT_DATE - INTERVAL 28 DAY, 22,
   'Psicoeducação sobre o ciclo da ansiedade.',
   'Sintomas físicos de ansiedade (taquicardia, tensão muscular) antes de apresentações.',
   '• Psicoeducação: modelo cognitivo da ansiedade\n• Introdução ao Registro de Pensamentos Disfuncionais (RPD)',
   'Boa adesão à proposta terapêutica.',
   '1. Preencher o RPD em 2 situações da semana',
   'Consulta #101', JSON_ARRAY('ansiedade','psicoeducação'), '111.222.333-44', 95, '06/12345');

  -- Anexos de texto por sessão (o trigger preenche CPF_Paciente e gera o histórico)
  SET @prisma_usuario_id = '06/12345';
  INSERT INTO Registro_Clinico_Anexo (ID_Consulta, CRP_Psicologo, NomeArquivo, Extensao, MimeType, TamanhoBytes, HashSHA256, Conteudo, Descricao)
  SELECT ID_Consulta, '06/12345', Nome, 'txt', 'text/plain', OCTET_LENGTH(Texto), SHA2(Texto, 256), CONVERT(Texto USING utf8mb4), Descricao
  FROM (
    SELECT 101 AS ID_Consulta, 'Registro de pensamentos - semana 24.txt' AS Nome, 'Tarefa de casa trazida pela paciente' AS Descricao,
           'REGISTRO DE PENSAMENTOS DISFUNCIONAIS (RPD)\n\nSituação: reunião de segunda-feira com a diretoria.\nEmoção: ansiedade (80%).\nPensamento automático: "Vou travar e todos vão perceber."\nPensamento alternativo: "Posso ficar nervosa e ainda assim apresentar bem."\nEmoção após: ansiedade (40%).\n' AS Texto
    UNION ALL
    SELECT 101, 'Plano de exposição gradual.txt', 'Anotação externa da sessão',
           'PLANO DE EXPOSIÇÃO GRADUAL\n\n1. Falar 1 minuto na reunião de equipe (30%)\n2. Apresentar resultado da semana ao coordenador (50%)\n3. Apresentação para a diretoria (80%)\n'
    UNION ALL
    SELECT 102, 'Agenda de atividades prazerosas.txt', NULL,
           'Seg: caminhada 15 min — 6/10\nTer: ligar para o irmão — 7/10\nQui: cozinhar receita nova — 8/10\n'
  ) AS a;
  SET @prisma_usuario_id = NULL;

  INSERT INTO Metas (ID_Meta, Status, DataInicio, DataFim, Descricao, Objetivos, Categoria, Prazo, CPF_Paciente, CRP_Psicologo) VALUES
  (1, 'Ativa', CURRENT_DATE - INTERVAL 30 DAY, CURRENT_DATE + INTERVAL  30 DAY, 'Praticar mindfulness diariamente',          '10 minutos por dia antes de iniciar a jornada de trabalho',     'Bem-estar',         'Curto', '111.222.333-44', '06/12345'),
  (2, 'Ativa', CURRENT_DATE - INTERVAL 30 DAY, CURRENT_DATE + INTERVAL  30 DAY, 'Exercícios de respiração diafragmática',    '3 vezes por semana em pausas programadas',                      'Ansiedade',         'Curto', '111.222.333-44', '06/12345'),
  (3, 'Ativa', CURRENT_DATE - INTERVAL 30 DAY, CURRENT_DATE + INTERVAL  60 DAY, 'Registro de pensamentos (diário de TCC)',   'Anotar situações-gatilho, emoções e pensamentos alternativos',  'Terapia Cognitiva', 'Médio', '111.222.333-44', '06/12345'),
  (4, 'Ativa', CURRENT_DATE - INTERVAL 30 DAY, CURRENT_DATE + INTERVAL 120 DAY, 'Aumentar atividades sociais gradualmente',  '1 atividade social por semana com rede de apoio',              'Plano terapêutico', 'Longo', '111.222.333-44', '06/12345'),
  (5, 'Ativa', CURRENT_DATE - INTERVAL 30 DAY, CURRENT_DATE + INTERVAL  30 DAY, 'Caminhada diária de 20 minutos',            'Ativação física ao ar livre',                                   'Plano terapêutico', 'Curto', '222.333.444-55', '06/12345'),
  (6, 'Ativa', CURRENT_DATE - INTERVAL 30 DAY, CURRENT_DATE + INTERVAL  30 DAY, 'Registro diário de humor',                  'Escala de 1 a 10 ao final do dia',                              'Terapia Cognitiva', 'Médio', '222.333.444-55', '06/12345'),
  (7, 'Ativa', CURRENT_DATE - INTERVAL 30 DAY, CURRENT_DATE + INTERVAL  30 DAY, 'Praticar respostas assertivas',             'Aplicar a técnica em 3 situações do cotidiano',                 'Autoestima',        'Médio', '333.444.555-66', '06/12345'),
  (8, 'Ativa', CURRENT_DATE - INTERVAL 30 DAY, CURRENT_DATE - INTERVAL   2 DAY, 'Diário de autocompaixão',                   'Escrever 3 qualidades pessoais por semana',                     'Autoestima',        'Curto', '333.444.555-66', '06/12345'),
  (9, 'Ativa', CURRENT_DATE - INTERVAL 30 DAY, CURRENT_DATE + INTERVAL  30 DAY, 'Técnica de respiração antes de dormir',     '5 minutos por noite',                                           'Bem-estar',         'Curto', '777.888.999-00', '06/12345');
  ALTER TABLE Metas AUTO_INCREMENT = 21;

  -- Checklist (os triggers calculam ProgressoPercentual e o status de cada meta)
  INSERT INTO Meta_Checklist_Item (ID_Meta, Ordem, Descricao, Concluido) VALUES
  (1, 1, 'Semana 1 — respiração guiada 5 min', TRUE), (1, 2, 'Semana 2 — atenção plena corporal', TRUE),
  (1, 3, 'Semana 3 — meditação matinal 10 min', TRUE), (1, 4, 'Semana 4 — prática autônoma de ancoragem', FALSE),
  (2, 1, 'Prática de terça-feira pós-almoço', TRUE), (2, 2, 'Prática de quinta-feira fim do expediente', TRUE), (2, 3, 'Prática de sábado ao despertar', FALSE),
  (3, 1, 'Identificar gatilhos de segunda-feira', TRUE), (3, 2, 'Reavaliar pensamento catastrófico de quarta', TRUE),
  (3, 3, 'Anotar evidências contra e a favor', TRUE), (3, 4, 'Formular pensamento equilibrado', FALSE),
  (4, 1, 'Café presencial com colega de confiança', TRUE), (4, 2, 'Visita à família no fim de semana', FALSE),
  (5, 1, 'Segunda-feira — 20 min', TRUE), (5, 2, 'Quarta-feira — 20 min', TRUE), (5, 3, 'Sexta-feira — 20 min', FALSE),
  (6, 1, 'Semana 1', TRUE), (6, 2, 'Semana 2', FALSE), (6, 3, 'Semana 3', FALSE), (6, 4, 'Semana 4', FALSE), (6, 5, 'Semana 5', FALSE),
  (7, 1, 'Situação no trabalho', TRUE), (7, 2, 'Situação com a família', TRUE), (7, 3, 'Situação com amigos', TRUE), (7, 4, 'Reflexão escrita sobre as experiências', FALSE),
  (8, 1, 'Semana 1', TRUE), (8, 2, 'Semana 2', TRUE),
  (9, 1, 'Primeira semana', TRUE), (9, 2, 'Segunda semana', FALSE);

  INSERT INTO Documentos (ID_Doc, Tipo, Origem, Conteudo, NomeArquivo, MimeType, TamanhoKb, Armazenamento, DriveFileId, DataEnvio, CPF_Paciente, CRP_Psicologo, ID_Consulta) VALUES
  (1, 'Administrativo', 'Sistema',   'Termo de Consentimento Livre e Esclarecido para atendimento online e presencial.', 'Termo de Consentimento (TCLE).pdf',          'application/pdf',  245, 'Google Drive API v3', 'gdrive_tcle_001',  CURRENT_DATE - INTERVAL 40 DAY, '111.222.333-44', '06/12345', NULL),
  (2, 'Avaliações',     'Psicóloga', 'Avaliação inicial das funções executivas, histórico biopsicossocial e anamnese.', 'Avaliação Inicial Neuropsicológica.pdf',     'application/pdf', 1250, 'Google Drive API v3', 'gdrive_av_002',    CURRENT_DATE - INTERVAL 35 DAY, '222.333.444-55', '06/12345', 102),
  (3, 'Tratamento',     'Psicóloga', 'Plano terapêutico com metas de curto, médio e longo prazo.',                      'Plano Terapêutico Singular.pdf',             'application/pdf',  890, 'Google Drive API v3', 'gdrive_pts_003',   CURRENT_DATE - INTERVAL 28 DAY, '333.444.555-66', '06/12345', 103),
  (4, 'Testes',         'Paciente',  'Respostas preenchidas e digitalizadas pelo paciente.',                             'Inventário de Ansiedade (digitalizado).pdf', 'application/pdf',  320, 'Google Drive API v3', 'gdrive_inv_004',   CURRENT_DATE - INTERVAL 20 DAY, '444.555.666-77', '06/12345', NULL),
  (5, 'Relatórios',     'Psicóloga', 'Relatório clínico consolidado de evolução psicológica do mês.',                    'Relatório de Acompanhamento.pdf',            'application/pdf',  445, 'Google Drive API v3', 'gdrive_rel_005',   CURRENT_DATE - INTERVAL 12 DAY, '555.666.777-88', '06/12345', NULL),
  (6, 'Laudos e Atestados', 'Psicóloga', 'Laudo psicológico referente ao acompanhamento em TCC.',                        'Laudo Psicológico — Ana Carolina.pdf',       'application/pdf',  210, 'Google Drive API v3', 'gdrive_laudo_006', CURRENT_DATE - INTERVAL  7 DAY, '111.222.333-44', '06/12345', 101);
  ALTER TABLE Documentos AUTO_INCREMENT = 21;

  INSERT INTO Laudos_Atestados (ID_LA, Tipo, Titulo, Conteudo, DataEmissao, ID_Consulta) VALUES
  (1, 'Laudo',    'Laudo Psicológico — Acompanhamento TCC',
   'Atesto, para os devidos fins, que a paciente Ana Carolina Mendes encontra-se em acompanhamento psicológico sob abordagem cognitivo-comportamental, apresentando evolução favorável no manejo de sintomas ansiosos.',
   CURRENT_DATE - INTERVAL 7 DAY, 101),
  (2, 'Atestado', 'Atestado de Comparecimento',
   'Declaro, para fins de comprovação, que o paciente Bruno Ferreira compareceu à sessão de atendimento psicológico no período das 09:30 às 10:30.',
   CURRENT_DATE - INTERVAL 14 DAY, 102);
  ALTER TABLE Laudos_Atestados AUTO_INCREMENT = 11;

  INSERT INTO Mensagem (DataHora, Texto, Remetente, Destinatario, Lida) VALUES
  (NOW() - INTERVAL 50 MINUTE, 'Dra. Shelley, bom dia! Posso me consultar na próxima semana?',                          '111.222.333-44', '06/12345', TRUE),
  (NOW() - INTERVAL 45 MINUTE, 'Olá, Ana! Claro, temos horário na terça às 09h ou quinta às 14h. Qual prefere?',       '06/12345', '111.222.333-44', TRUE),
  (NOW() - INTERVAL 42 MINUTE, 'Prefiro terça mesmo. Muito obrigada!',                                                  '111.222.333-44', '06/12345', TRUE),
  (NOW() - INTERVAL 40 MINUTE, 'Perfeito! Envie a solicitação pela Agenda que eu confirmo por lá. Até lá!',              '06/12345', '111.222.333-44', TRUE),
  (NOW() - INTERVAL 36 MINUTE, 'Obrigada pela indicação do material, Dra.!',                                             '111.222.333-44', '06/12345', FALSE),
  (TIMESTAMP(CURRENT_DATE - INTERVAL 1 DAY, '10:05'), 'Vejo você na quinta!',                                                  '222.333.444-55', '06/12345', TRUE),
  (TIMESTAMP(CURRENT_DATE - INTERVAL 1 DAY, '10:30'), 'Posso remarcar para a semana que vem?',                                 '333.444.555-66', '06/12345', FALSE),
  (TIMESTAMP(CURRENT_DATE - INTERVAL 2 DAY, '10:00'), 'Fiz as anotações pedidas na última sessão.',                            '444.555.666-77', '06/12345', TRUE),
  (TIMESTAMP(CURRENT_DATE - INTERVAL 3 DAY, '10:00'), 'Obrigada pela atenção de sempre.',                                      '555.666.777-88', '06/12345', TRUE),
  (TIMESTAMP(CURRENT_DATE - INTERVAL 1 DAY, '10:40'), 'Olá, Maria! Como você está se sentindo hoje?',                          '06/12345', '777.888.999-00', TRUE),
  (TIMESTAMP(CURRENT_DATE - INTERVAL 1 DAY, '10:45'), 'Estou melhor! Consegui fazer os exercícios de respiração que você recomendou.', '777.888.999-00', '06/12345', TRUE),
  (TIMESTAMP(CURRENT_DATE - INTERVAL 1 DAY, '10:50'), 'Excelente progresso! Consegue praticar também antes de dormir?',         '06/12345', '777.888.999-00', TRUE);

  INSERT INTO Notificacao (DestinatarioId, Titulo, Mensagem, Tipo) VALUES
  ('06/12345',       'Nova solicitação de cadastro',      'Fernanda Costa se cadastrou e aguarda sua aprovação para acessar a plataforma.', 'cadastro_pendente'),
  ('06/12345',       'Nova solicitação de cadastro',      'Lucas Almeida se cadastrou e aguarda sua aprovação para acessar a plataforma.',  'sistema'),
  ('111.222.333-44', 'Consulta próxima',                  'Lembrete: sua sessão com a Dra. Shelley Christina acontece nas próximas horas.', 'consulta_proxima'),
  ('111.222.333-44', 'Meta terapêutica',                  'A meta "Praticar mindfulness diariamente" aguarda sua atualização hoje.',        'meta_ativa'),
  ('111.222.333-44', 'Nova proposta de horário',          'A Dra. Shelley sugeriu um novo horário para sua consulta. Confirme na Agenda.',  'contraproposta_horario'),
  ('06/12345',       'Nova solicitação de agendamento',   'Ana Carolina Mendes solicitou uma consulta. Aguardando sua confirmação.',        'solicitacao_pendente'),
  ('06/12345',       'Nova solicitação de agendamento',   'Bruno Ferreira solicitou uma consulta presencial.',                              'solicitacao_pendente'),
  ('111.222.333-44', 'Teste psicológico pendente',        'Você recebeu o questionário PHQ-9 para responder antes da próxima sessão.',      'teste_pendente');

  -- Instrumentos (GAD-7 e PHQ-9: domínio público; Check-in: instrumento interno)
  INSERT INTO Teste_Psicologico (Codigo, Sigla, Nome, NumItens, PontuacaoMax, MaiorMelhor, Observacao) VALUES
  ('GAD7',     'GAD-7',    'Escala de Ansiedade Generalizada',   7, 21, FALSE, 'Rastreio de ansiedade — Spitzer et al., 2006 (domínio público)'),
  ('PHQ9',     'PHQ-9',    'Questionário de Saúde do Paciente',  9, 27, FALSE, 'Rastreio de depressão — Kroenke et al., 2001 (domínio público); item 9 exige avaliação de risco'),
  ('BEMESTAR', 'Check-in', 'Check-in de Bem-estar Semanal',      6, 18, TRUE,  'Instrumento interno do PRISMA, não validado');

  INSERT INTO Teste_Faixa (Codigo, PontosMin, PontosMax, Classificacao) VALUES
  ('GAD7', 0, 4, 'Mínima'), ('GAD7', 5, 9, 'Leve'), ('GAD7', 10, 14, 'Moderada'), ('GAD7', 15, 21, 'Grave'),
  ('PHQ9', 0, 4, 'Mínima'), ('PHQ9', 5, 9, 'Leve'), ('PHQ9', 10, 14, 'Moderada'), ('PHQ9', 15, 19, 'Moderadamente grave'), ('PHQ9', 20, 27, 'Grave'),
  ('BEMESTAR', 0, 6, 'Baixo'), ('BEMESTAR', 7, 12, 'Moderado'), ('BEMESTAR', 13, 18, 'Bom');

  -- Aplicações (Pontuacao/Classificacao calculadas pelo TRG_Corrige_Teste_Insert)
  INSERT INTO Aplicacao_Teste (CodigoTeste, CPF_Paciente, CRP_Psicologo, DataAtribuicao, DataResposta, Respostas) VALUES
  ('GAD7',     '111.222.333-44', '06/12345', CURRENT_DATE - INTERVAL 60 DAY, CURRENT_DATE - INTERVAL 58 DAY, JSON_ARRAY(3,2,3,2,2,2,2)),
  ('GAD7',     '111.222.333-44', '06/12345', CURRENT_DATE - INTERVAL 32 DAY, CURRENT_DATE - INTERVAL 30 DAY, JSON_ARRAY(2,2,2,2,1,2,2)),
  ('GAD7',     '111.222.333-44', '06/12345', CURRENT_DATE - INTERVAL  9 DAY, CURRENT_DATE - INTERVAL  8 DAY, JSON_ARRAY(2,1,2,1,1,2,1)),
  ('PHQ9',     '111.222.333-44', '06/12345', CURRENT_DATE - INTERVAL  1 DAY, NULL,                           NULL),
  ('PHQ9',     '222.333.444-55', '06/12345', CURRENT_DATE - INTERVAL 45 DAY, CURRENT_DATE - INTERVAL 44 DAY, JSON_ARRAY(2,2,2,3,1,2,2,2,1)),
  ('PHQ9',     '222.333.444-55', '06/12345', CURRENT_DATE - INTERVAL 15 DAY, CURRENT_DATE - INTERVAL 14 DAY, JSON_ARRAY(2,2,1,2,1,2,2,2,0)),
  ('BEMESTAR', '333.444.555-66', '06/12345', CURRENT_DATE - INTERVAL  6 DAY, CURRENT_DATE - INTERVAL  5 DAY, JSON_ARRAY(3,3,2,3,2,3));

  INSERT INTO Auditoria (Acao, UsuarioId, UsuarioTipo, Detalhes, Sucesso) VALUES
  ('CARGA_INICIAL', 'sistema', 'sistema', 'Banco criado a partir de database/schema.sql', TRUE);
END$$
DELIMITER ;

CALL prisma_carga_inicial();
DROP PROCEDURE prisma_carga_inicial;

-- =========================================================================
-- 9. PERFIS DE ACESSO (RBAC no banco) — opcional
--    Requer privilégio para criar roles. O perfil de paciente NÃO tem acesso
--    à tabela Registro_Clinico (sigilo — Código de Ética do Psicólogo e LGPD).
-- =========================================================================
CREATE ROLE IF NOT EXISTS 'prisma_psicologa', 'prisma_paciente';

GRANT SELECT, INSERT, UPDATE ON prisma_db.* TO 'prisma_psicologa';
GRANT DELETE ON prisma_db.Meta_Checklist_Item TO 'prisma_psicologa';
GRANT DELETE ON prisma_db.Documentos TO 'prisma_psicologa';
GRANT EXECUTE ON prisma_db.* TO 'prisma_psicologa';

GRANT SELECT ON prisma_db.vw_agenda              TO 'prisma_paciente';
GRANT SELECT ON prisma_db.vw_progresso_paciente  TO 'prisma_paciente';
GRANT SELECT ON prisma_db.vw_documentos_paciente TO 'prisma_paciente';
GRANT SELECT ON prisma_db.vw_agenda_indisponivel TO 'prisma_paciente';
GRANT DELETE ON prisma_db.BloqueioAgenda TO 'prisma_psicologa';
GRANT SELECT, INSERT, UPDATE ON prisma_db.Consulta           TO 'prisma_paciente';
GRANT SELECT, UPDATE         ON prisma_db.Meta_Checklist_Item TO 'prisma_paciente';
GRANT SELECT                 ON prisma_db.Metas               TO 'prisma_paciente';
GRANT SELECT, INSERT         ON prisma_db.Mensagem            TO 'prisma_paciente';
GRANT SELECT, UPDATE         ON prisma_db.Notificacao         TO 'prisma_paciente';
GRANT SELECT, UPDATE         ON prisma_db.Aplicacao_Teste     TO 'prisma_paciente';
GRANT INSERT                 ON prisma_db.Documentos          TO 'prisma_paciente';
-- (sem GRANT em Registro_Clinico, Registro_Clinico_Anexo, Sessao_Historico, Auditoria, Laudos_Atestados, Paciente e Psicologo para o paciente:
--  dados cadastrais e SenhaHash são acessados somente pela API)

-- Rotinas auxiliares de atualização (não fazem parte do sistema)
DROP PROCEDURE IF EXISTS prisma_ddl;
DROP PROCEDURE IF EXISTS prisma_add_coluna;
DROP PROCEDURE IF EXISTS prisma_add_restricao;
DROP PROCEDURE IF EXISTS prisma_trocar_check;
DROP PROCEDURE IF EXISTS prisma_add_indice;

-- =========================================================================
-- 10. CONSULTAS DE VERIFICAÇÃO (descomente para testar as regras)
-- =========================================================================
-- SELECT * FROM vw_agenda ORDER BY DataHora;
-- SELECT * FROM vw_progresso_paciente;
-- SELECT ID_Meta, Descricao, ProgressoPercentual, Status FROM Metas;
-- SELECT CodigoTeste, CPF_Paciente, Pontuacao, Classificacao FROM Aplicacao_Teste;
--
-- Choque de horário (deve falhar: consulta 105 ocupa 10:00–11:00):
-- INSERT INTO Consulta (DataHora, Duracao, Status, CPF_Paciente, CRP_Psicologo)
--   VALUES (TIMESTAMP(CURRENT_DATE + INTERVAL 3 DAY, '11:10'), '60 min', 'Pendente', '222.333.444-55', '06/12345');
--
-- Login: paciente pendente não está liberado (a API só autentica Status = 'ATIVO'):
-- SELECT Tipo, Nome, Status FROM vw_autenticacao WHERE Email = 'lucas.almeida@email.com';
-- Painel de aprovação:
-- SELECT * FROM vw_cadastros_pendentes ORDER BY Data_Solicitacao;
-- CALL sp_aprovar_cadastro_paciente('888.999.000-11', '06/12345');
-- Paciente pendente não agenda (deve falhar):
-- INSERT INTO Consulta (DataHora, Status, CPF_Paciente, CRP_Psicologo) VALUES (NOW() + INTERVAL 5 DAY, 'Pendente', '999.000.111-22', '06/12345');
--
-- Trava de 24 h (deve falhar: consulta 104 começa em ~12 h):
-- SET @prisma_usuario_tipo = 'paciente';
-- UPDATE Consulta SET Status = 'Cancelada' WHERE ID_Consulta = 104;
--
-- Bloqueio de agenda (deve falhar: o dia +9 está no congresso):
-- INSERT INTO Consulta (DataHora, Status, CPF_Paciente, CRP_Psicologo) VALUES (TIMESTAMP(CURRENT_DATE + INTERVAL 9 DAY, '10:00'), 'Pendente', '111.222.333-44', '06/12345');
-- Antecedência de 48 h para o paciente (deve falhar):
-- SET @prisma_usuario_tipo = 'paciente';
-- INSERT INTO Consulta (DataHora, Status, CPF_Paciente, CRP_Psicologo) VALUES (NOW() + INTERVAL 30 HOUR, 'Pendente', '111.222.333-44', '06/12345');
-- Reagendamento com menos de 48 h (deve falhar com a mensagem "Reagendamentos só podem ser realizados…"):
-- UPDATE Consulta SET DataHora = TIMESTAMP(CURRENT_DATE + INTERVAL 20 DAY, '10:00'), Status = 'Pendente' WHERE ID_Consulta = 104;
-- Confirmação de presença pelo paciente / painel da psicóloga:
-- UPDATE Consulta SET StatusConfirmacao = 'CONFIRMADA' WHERE ID_Consulta = 105;
-- SELECT * FROM vw_confirmacoes_pendentes ORDER BY DataHora;
