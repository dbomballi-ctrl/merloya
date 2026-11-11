# Local Supabase migration validation

This repository has a legacy hosted schema whose original bootstrap migrations are not
tracked in Git. Do not run the Merlo Ya 2.0 migrations against production merely to
validate them.

## Automated validation

The GitHub Actions workflow `.github/workflows/supabase-local.yml` starts an isolated
Supabase stack, creates a minimal test-only representation of the legacy
`profiles`, `products`, and `sales` tables, applies every migration in filename
order, and checks key schema and privilege invariants.

The fixture in `supabase/tests/fixtures/legacy_schema.sql` is strictly for disposable
local CI databases. It is not a production migration and must never be deployed to the
hosted project.

## Run locally

Requirements: Docker and the Supabase CLI.

```sh
supabase start -x studio,edge-runtime,logflare,vector,imgproxy,inbucket
```

Install a PostgreSQL client, then run:

```sh
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -v ON_ERROR_STOP=1 -f supabase/tests/fixtures/legacy_schema.sql

for migration in supabase/migrations/*.sql; do
  psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
    -v ON_ERROR_STOP=1 -f "$migration"
done

psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -v ON_ERROR_STOP=1 -f supabase/tests/assertions.sql
```

Stop the disposable stack when finished with `supabase stop`.

No hosted Supabase project, service-role key, production data, paid branch, or Vercel
deployment is required for this validation.
