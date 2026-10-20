import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";

const url = process.env.DATABASE_URL;
const tables = ["events", "ops_allowlist", "ops_codes", "tickets"];

describe.skipIf(!url)("ops table lockdown", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());

  it("enables row security on every ops table", async () => {
    expect(
      await sql`select relname, relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relname in ${sql(tables)} order by relname`,
    ).toEqual(tables.map((relname) => ({ relname, relrowsecurity: true })));
  });

  it.each(["anon", "authenticated"])("denies %s access but keeps server CRUD working", async (role) => {
    const rollback = new Error("rollback");
    await expect(
      sql.begin(async (tx) => {
        const server = `eyes_s4_server_${crypto.randomUUID().replaceAll("-", "")}`;
        await tx.unsafe(`create role ${server} nosuperuser bypassrls`);
        await tx.unsafe(`grant usage on schema public to ${server}`);
        await tx.unsafe(`grant all on ${tables.join(", ")} to ${server}`);
        await tx.unsafe(`grant usage, select on all sequences in schema public to ${server}`);
        await tx.unsafe(
          `do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`,
        );
        await tx.unsafe(`grant usage on schema public to ${role}`);
        await tx.unsafe(`grant all on ${tables.join(", ")} to public, ${role}`);
        await tx.unsafe(
          readFileSync(new URL("../migrations/041_database_lockdown.sql", import.meta.url), "utf8"),
        );
        const [agent] = await tx`insert into agents (name, api_key_hash)
          values ('lockdown', ${crypto.randomUUID()}) returning id`;
        const [worker] = await tx`insert into workers (phone, name)
          values ('+15555550199', 'lockdown') returning id`;
        const [task] = await tx`insert into tasks
          (agent_id, question, task_type, place_label, lat, lng, bounty_cents, fee_cents, deadline_at)
          values (${agent?.id}, 'Open?', 'is_open', 'Shop', 0, 0, 300, 50, now()) returning id`;
        const rows = [
          { kind: "lockdown", summary: "proof" },
          { kind: "email", value: "lockdown@example.test", added_by: "proof" },
          { identifier: "lockdown@example.test", code_hash: "proof", expires_at: new Date() },
          { worker_id: worker?.id, task_id: task?.id, message: "proof" },
        ];
        const fields = ["summary", "added_by", "code_hash", "message"];
        for (const [i, table] of tables.entries()) {
          const field = fields[i] as string;
          const row = rows[i] as (typeof rows)[number];
          await tx.unsafe(`set local role ${server}`);
          expect(await tx`insert into ${tx(table)} ${tx(row)} returning ${tx(field)}`).toEqual([
            { [field]: "proof" },
          ]);
          expect(await tx`select ${tx(field)} from ${tx(table)} where ${tx(field)} = 'proof'`).toEqual([
            { [field]: "proof" },
          ]);
          expect(
            await tx`update ${tx(table)} set ${tx(field)} = 'changed'
              where ${tx(field)} = 'proof' returning ${tx(field)}`,
          ).toEqual([{ [field]: "changed" }]);
          expect(
            await tx`delete from ${tx(table)} where ${tx(field)} = 'changed' returning ${tx(field)}`,
          ).toEqual([{ [field]: "changed" }]);
          await tx`insert into ${tx(table)} ${tx(row)}`;
          await tx.unsafe("reset role");
          for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
            expect(await tx`select has_table_privilege(${role}, ${table}, ${privilege}) as allowed`).toEqual([
              { allowed: false },
            ]);
          }
          await tx.unsafe(`set local role ${role}`);
          for (const query of [
            `select * from ${table}`,
            `update ${table} set ${field} = 'blocked'`,
            `delete from ${table}`,
          ]) {
            await expect(tx.savepoint((sp) => sp.unsafe(query))).rejects.toMatchObject({
              code: "42501",
            });
          }
          await expect(tx.savepoint((sp) => sp`insert into ${sp(table)} ${sp(row)}`)).rejects.toMatchObject({
            code: "42501",
          });
          await tx.unsafe("reset role");
          await tx.unsafe(`grant all on ${table} to ${role}`);
          await tx.unsafe(`grant usage, select on all sequences in schema public to ${role}`);
          await tx.unsafe(`set local role ${role}`);
          expect(await tx.unsafe(`select * from ${table}`)).toEqual([]);
          expect(await tx.unsafe(`update ${table} set ${field} = 'blocked' returning *`)).toEqual([]);
          expect(await tx.unsafe(`delete from ${table} returning *`)).toEqual([]);
          await expect(tx.savepoint((sp) => sp`insert into ${sp(table)} ${sp(row)}`)).rejects.toThrow(
            /row-level security/,
          );
          await tx.unsafe("reset role");
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("rejects a device registration waiting behind a fraud ban", async () => {
    const [worker] = await sql`insert into workers (phone, name, opted_in)
      values ('+15555550200', 'ban race', true) returning id`;
    const gate = await sql.reserve();
    let registering: Promise<unknown> | undefined;
    try {
      await gate`begin`;
      await gate`select id from workers where id = ${worker?.id} for update`;
      registering =
        sql`select * from eyes_add_worker_device(${worker?.id}, '00000000-0000000000000004', null, null)`.then(
          (rows) => rows,
        );
      await expect
        .poll(async () => {
          const [row] = await sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
            and query like '%eyes_add_worker_device(%'`;
          return row?.waiting;
        })
        .toBe(1);
      await gate`update workers set banned = true, opted_in = false where id = ${worker?.id}`;
      await gate`commit`;
      expect(await registering).toEqual([]);
      expect(await sql`select udid from worker_devices where worker_id = ${worker?.id}`).toEqual([]);
    } finally {
      await gate`rollback`;
      gate.release();
      if (registering) await registering;
    }
  });
});
