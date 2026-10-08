-- Usuario y esquema PROPIOS del prospector dentro del proyecto de Supabase de
-- Finanzas. El usuario prospector_app solo puede trabajar en el esquema
-- "prospector": no tiene permisos sobre las tablas de Finanzas (esquema public).
--
-- No lo corras a mano con este marcador: usa `node scripts/preparar-supabase.mjs`,
-- que genera la contraseña y deja este SQL listo en .env.supabase.sql (ignorado
-- por git). Luego pégalo en Supabase → SQL Editor y ejecútalo una vez.
-- Es idempotente: volver a correrlo solo cambia la contraseña.

-- 1) Usuario de la app (sin superpoderes).
do $$
begin
  if not exists (select from pg_roles where rolname = 'prospector_app') then
    create role prospector_app login password '__PASSWORD__'
      nosuperuser nocreatedb nocreaterole noinherit;
  else
    alter role prospector_app login password '__PASSWORD__';
  end if;
end
$$;

-- 2) Esquema propio: el usuario puede crear y usar SUS tablas ahí.
create schema if not exists prospector;
grant usage, create on schema prospector to prospector_app;

-- 3) Por defecto todo lo hace en su esquema, sin tocar public.
alter role prospector_app set search_path = prospector;

-- 4) Límites para no afectar a Finanzas.
alter role prospector_app connection limit 20;
alter role prospector_app set statement_timeout = '30s';

-- 5) Por si acaso: ningún permiso sobre tablas y secuencias de Finanzas.
revoke all on all tables in schema public from prospector_app;
revoke all on all sequences in schema public from prospector_app;

-- Comprobación: debe decir "prospector" y false.
select rolname,
       (select setconfig from pg_db_role_setting s where s.setrole = r.oid limit 1) as config,
       has_table_privilege('prospector_app', (select format('%I.%I', schemaname, tablename)
         from pg_tables where schemaname = 'public' limit 1), 'SELECT') as ve_tablas_de_finanzas
from pg_roles r
where rolname = 'prospector_app';
