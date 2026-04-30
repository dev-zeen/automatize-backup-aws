# db-backup

Serviço leve para backup automatizado de bancos PostgreSQL no Amazon S3 (ou qualquer storage compatível com S3). Roda como container Docker, executa `pg_dump` em stream, comprime com gzip e faz upload diretamente para o bucket — sem salvar nada em disco. Remove automaticamente backups antigos conforme a política de retenção configurada.

## Como funciona

1. Na inicialização valida todas as variáveis de ambiente obrigatórias.
2. Agenda o backup via cron conforme `BACKUP_SCHEDULE`.
3. No horário agendado: executa `pg_dump`, comprime em gzip e sobe para S3 como `<S3_PREFIX>/<timestamp>.sql.gz`.
4. Após o upload, lista objetos no bucket e deleta os que ultrapassaram `RETENTION_DAYS`.

## Pré-requisitos

- Docker
- Bucket S3 criado (ou bucket compatível: MinIO, Cloudflare R2, etc.)
- Credenciais AWS com permissões `s3:PutObject`, `s3:ListBucket` e `s3:DeleteObject` no bucket

## Configuração

Copie `.env.example` para `.env` e preencha os valores:

```bash
cp .env.example .env
```

| Variável               | Obrigatória | Padrão       | Descrição                                                         |
|------------------------|-------------|--------------|-------------------------------------------------------------------|
| `DATABASE_URL`         | Sim         | —            | Connection string do Postgres (`postgres://user:pass@host/db`)    |
| `S3_BUCKET`            | Sim         | —            | Nome do bucket S3                                                 |
| `S3_REGION`            | Sim         | —            | Região AWS (ex: `us-east-1`)                                      |
| `S3_ACCESS_KEY_ID`     | Sim         | —            | Access key ID da AWS                                              |
| `S3_SECRET_ACCESS_KEY` | Sim         | —            | Secret access key da AWS                                          |
| `S3_ENDPOINT`          | Não         | —            | Endpoint customizado para serviços S3-compatíveis (MinIO, R2...)  |
| `BACKUP_SCHEDULE`      | Não         | `0 2 * * *`  | Expressão cron para o agendamento (padrão: diariamente às 2h UTC) |
| `RETENTION_DAYS`       | Não         | `7`          | Quantos dias manter os backups no bucket                          |
| `S3_PREFIX`            | Não         | `db-backups` | Prefixo (pasta) dentro do bucket onde os arquivos serão salvos    |
| `RUN_ON_START`         | Não         | `false`      | Se `true`, executa um backup imediatamente ao subir o container   |

## Uso

### Docker Compose

```yaml
services:
  db-backup:
    build: .
    env_file: .env
    restart: unless-stopped
```

```bash
docker compose up -d
```

### Docker puro

```bash
docker build -t db-backup .

docker run -d \
  --name db-backup \
  --env-file .env \
  --restart unless-stopped \
  db-backup
```

### Backup imediato na subida

Adicione `RUN_ON_START=true` no `.env` (ou passe via `-e`) para forçar um backup assim que o container iniciar, sem aguardar o próximo horário agendado.

## Formato dos arquivos no bucket

```text
<S3_PREFIX>/<YYYY-MM-DDTHH-MM-SS>.sql.gz
```

Exemplo: `db-backups/2026-04-30T02-00-00.sql.gz`

## Restaurando um backup

```bash
# Baixe o arquivo do S3
aws s3 cp s3://<bucket>/db-backups/<arquivo>.sql.gz backup.sql.gz

# Descomprima e restaure
gunzip -c backup.sql.gz | psql <DATABASE_URL>
```

## Licença

[MIT](LICENSE)
