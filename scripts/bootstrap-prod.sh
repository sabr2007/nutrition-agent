#!/usr/bin/env bash
# One-command production bootstrap for «Рядом».
#
#   ./scripts/bootstrap-prod.sh you@example.com
#
# What it does (idempotent — safe to re-run):
#   1. finds or creates the Supabase project (free plan: max 2 active projects per owner!)
#   2. links it and applies all migrations from supabase/migrations
#   3. auth: disables public sign-up, min password length 12, site URL = APP_URL
#   4. stores APP_URL + CRON_SECRET in Supabase Vault (pg_cron → /api/cron/tick every 5 min)
#   5. creates the owner account via the Admin API with a generated password (printed ONCE)
#   6. writes Supabase URL/keys + CRON_SECRET into Vercel env (production + preview)
#   7. triggers a production redeploy
#
# Requirements: supabase CLI (logged in), vercel CLI (logged in, project linked), node, pnpm.
set -euo pipefail

OWNER_EMAIL="${1:-}"
if [[ -z "$OWNER_EMAIL" ]]; then
  echo "usage: $0 <owner-email>" >&2
  exit 1
fi
NAME="${SUPABASE_PROJECT_NAME:-ryadom-nutrition}"
ORG_ID="${SUPABASE_ORG_ID:-}"   # auto-detected when the token sees exactly one organization
REGION="${SUPABASE_REGION:-eu-central-1}"
APP_URL="${APP_URL:-https://ryadom-coach.vercel.app}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/supabase/.temp"
mkdir -p "$STATE" && chmod 700 "$STATE"
cd "$ROOT"

# --- Supabase Management API token (env, or the CLI's keychain entry on macOS) ---------
TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
if [[ -z "$TOKEN" ]] && command -v security >/dev/null; then
  TOKEN="$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null || true)"
  if [[ "$TOKEN" == go-keyring-base64:* ]]; then TOKEN="$(printf '%s' "${TOKEN#go-keyring-base64:}" | base64 -d)"; fi
fi
if [[ -z "$TOKEN" ]]; then
  echo "Нужен токен Supabase: export SUPABASE_ACCESS_TOKEN=... (https://supabase.com/dashboard/account/tokens)" >&2
  exit 1
fi
api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
py() { python3 -c "$1"; }

# --- 1. project ------------------------------------------------------------------------
REF="$(api https://api.supabase.com/v1/projects | py "import sys,json; print(next((p['id'] for p in json.load(sys.stdin) if p.get('name')=='$NAME'),''))")"
if [[ -z "$REF" ]]; then
  if [[ -z "$ORG_ID" ]]; then
    ORG_ID="$(api https://api.supabase.com/v1/organizations | py "import sys,json; o=json.load(sys.stdin); print(o[0]['id'] if isinstance(o, list) and len(o)==1 else '')")"
    [[ -n "$ORG_ID" ]] || { echo "Не удалось выбрать организацию Supabase: export SUPABASE_ORG_ID=..." >&2; exit 1; }
  fi
  echo "→ создаю проект $NAME в $REGION…"
  DB_PASSWORD="$(openssl rand -base64 36 | tr -d '/+=' | cut -c1-32)"
  RESP="$(api -X POST https://api.supabase.com/v1/projects -d "{\"name\":\"$NAME\",\"organization_id\":\"$ORG_ID\",\"region\":\"$REGION\",\"db_pass\":\"$DB_PASSWORD\"}")"
  REF="$(printf '%s' "$RESP" | py "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || true)"
  if [[ -z "$REF" ]]; then
    echo "Не удалось создать проект. Ответ Supabase:" >&2
    printf '%s\n' "$RESP" | head -c 600 >&2; echo >&2
    echo "Если это лимит бесплатного плана (2 активных проекта) — поставь один проект на паузу или включи Pro и запусти скрипт снова." >&2
    exit 1
  fi
  printf '%s' "$DB_PASSWORD" > "$STATE/db-password" && chmod 600 "$STATE/db-password"
else
  echo "→ проект найден: $REF"
fi
DB_PASSWORD="${SUPABASE_DB_PASSWORD:-$(cat "$STATE/db-password" 2>/dev/null || true)}"

echo -n "→ жду, пока проект поднимется"
for _ in $(seq 1 90); do
  STATUS="$(api "https://api.supabase.com/v1/projects/$REF" | py "import sys,json; print(json.load(sys.stdin).get('status',''))")"
  [[ "$STATUS" == "ACTIVE_HEALTHY" ]] && break
  echo -n "."; sleep 5
done
echo " $STATUS"
[[ "$STATUS" == "ACTIVE_HEALTHY" ]] || { echo "Проект не поднялся (status=$STATUS)" >&2; exit 1; }
SUPABASE_URL="https://$REF.supabase.co"

# --- 2. migrations -----------------------------------------------------------------------
if [[ -z "$DB_PASSWORD" ]]; then
  echo "Нужен пароль БД существующего проекта: export SUPABASE_DB_PASSWORD=..." >&2
  exit 1
fi
supabase link --project-ref "$REF" -p "$DB_PASSWORD" >/dev/null
supabase db push --linked -p "$DB_PASSWORD" --include-all --yes

# --- 3. auth settings ------------------------------------------------------------------------
api -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" -d "{
  \"disable_signup\": true,
  \"site_url\": \"$APP_URL\",
  \"uri_allow_list\": \"$APP_URL/**\",
  \"password_min_length\": 12,
  \"external_email_enabled\": true,
  \"mailer_autoconfirm\": false,
  \"security_update_password_require_reauthentication\": false
}" >/dev/null
SIGNUP_OFF="$(api "https://api.supabase.com/v1/projects/$REF/config/auth" | py "import sys,json; print(json.load(sys.stdin).get('disable_signup'))")"
if [[ "$SIGNUP_OFF" != "True" ]]; then
  echo "Не удалось закрыть регистрацию (disable_signup=$SIGNUP_OFF). Закрой вручную: Dashboard → Authentication → Sign In / Providers → Allow new users to sign up = off" >&2
  exit 1
fi
echo "→ auth: регистрация закрыта (проверено)"

# --- 4. keys -------------------------------------------------------------------------------------
KEYS="$(api "https://api.supabase.com/v1/projects/$REF/api-keys?reveal=true")"
PUBLISHABLE="$(printf '%s' "$KEYS" | py "import sys,json; k=json.load(sys.stdin); print(next((x['api_key'] for x in k if x.get('type')=='publishable'), next((x['api_key'] for x in k if x.get('name')=='anon'),'')))")"
SECRET="$(printf '%s' "$KEYS" | py "import sys,json; k=json.load(sys.stdin); print(next((x['api_key'] for x in k if x.get('type')=='secret'), next((x['api_key'] for x in k if x.get('name')=='service_role'),'')))")"
[[ -n "$PUBLISHABLE" && -n "$SECRET" ]] || { echo "Не удалось получить API-ключи" >&2; exit 1; }

# --- 5. vault secrets for pg_cron (fresh shared secret, also written to Vercel) -------------------
CRON_SECRET="$(openssl rand -hex 32)"
SQL="do \$\$ begin
  if exists (select 1 from vault.secrets where name='app_url') then perform vault.update_secret((select id from vault.secrets where name='app_url'), '$APP_URL');
  else perform vault.create_secret('$APP_URL', 'app_url'); end if;
  if exists (select 1 from vault.secrets where name='cron_secret') then perform vault.update_secret((select id from vault.secrets where name='cron_secret'), '$CRON_SECRET');
  else perform vault.create_secret('$CRON_SECRET', 'cron_secret'); end if;
end \$\$;"
BODY="$(SQL="$SQL" python3 -c 'import json,os; print(json.dumps({"query": os.environ["SQL"]}))')"
api -X POST "https://api.supabase.com/v1/projects/$REF/database/query" -d "$BODY" >/dev/null && echo "→ vault: app_url + cron_secret"

# --- 6. owner account (password printed once, never stored) -----------------------------------------
echo "→ создаю аккаунт владельца"
NEXT_PUBLIC_SUPABASE_URL="$SUPABASE_URL" SUPABASE_SECRET_KEY="$SECRET" \
  TSX_TSCONFIG_PATH=tsconfig.scripts.json node --import tsx scripts/create-user.ts --email "$OWNER_EMAIL"

# --- 7. Vercel env + redeploy ---------------------------------------------------------------------------
setenv() {
  for envn in production preview; do
    printf '%s' "$2" | vercel env add "$1" "$envn" --force >/dev/null 2>&1 || { echo "vercel env add $1 $envn failed" >&2; exit 1; }
  done
}
setenv NEXT_PUBLIC_SUPABASE_URL "$SUPABASE_URL"
setenv NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY "$PUBLISHABLE"
setenv SUPABASE_SECRET_KEY "$SECRET"
setenv CRON_SECRET "$CRON_SECRET"
echo "→ Vercel env обновлён"

# --- 8. CI migrations (GitHub Actions job `migrate`) ------------------------------------------------
if command -v gh >/dev/null; then
  printf '%s' "$REF" | gh secret set SUPABASE_PROJECT_REF >/dev/null && printf '%s' "$DB_PASSWORD" | gh secret set SUPABASE_DB_PASSWORD >/dev/null && echo "→ GitHub secrets: SUPABASE_PROJECT_REF, SUPABASE_DB_PASSWORD"
  # The access token is NOT copied from your CLI keychain: create a dedicated one and pass it explicitly.
  if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" && "${SET_CI_TOKEN:-}" == "1" ]]; then
    printf '%s' "$SUPABASE_ACCESS_TOKEN" | gh secret set SUPABASE_ACCESS_TOKEN >/dev/null && echo "→ GitHub secret: SUPABASE_ACCESS_TOKEN"
  else
    echo "  (для автоприменения миграций из CI: SET_CI_TOKEN=1 SUPABASE_ACCESS_TOKEN=<новый токен> ./scripts/bootstrap-prod.sh ...)"
  fi
fi

echo "→ деплою прод…"
vercel deploy --prod --yes >/dev/null && echo "✓ готово: $APP_URL"
echo "Проверка cron через 5 минут: select * from cron.job_run_details order by start_time desc limit 5;"
