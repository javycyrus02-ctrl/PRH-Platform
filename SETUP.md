# Supabase Wallet Setup

The Supabase project is the source of truth for sign-in, GHS balances, and deposit/withdrawal requests. New accounts start with a GHS 0.00 balance. Requests remain pending until an allowlisted admin approves or rejects them.

## Configure the project

1. Create a Supabase project and open its SQL Editor.
2. Run [`supabase/schema.sql`](supabase/schema.sql).
3. In Supabase project settings, enable Email authentication. Configure the site URL and allowed redirect URLs for the URL where you will host this app. Email confirmation can remain enabled.
4. Put the project URL and the public anon/publishable key in [`supabase-config.js`](supabase-config.js). Never put a `service_role` key in this file or in browser code.
5. Host this folder on an HTTP(S) origin and open `index.html`. Supabase Auth is not intended to be deployed from `file://`.

## Add the administrator

1. Create your own account through the wallet page and confirm its email if confirmation is enabled.
2. In Supabase Authentication, find that user and copy the user UUID.
3. In the SQL Editor, run the following with your UUID:

```sql
insert into public.wallet_admins (user_id)
values ('YOUR_AUTH_USER_UUID')
on conflict (user_id) do nothing;
```

The admin page is [`admin.html`](admin.html). It checks the signed-in user's allowlist membership through Supabase; hiding the page link is not the security boundary. Row-level security and the database review function enforce access.

## Request flow

Users submit a GHS amount and optional note. The request is visible to the user and allowlisted admins. Approval credits a deposit or deducts a withdrawal in the virtual GHS ledger; rejection leaves the balance unchanged. Withdrawal requests are checked against available balance, including other pending withdrawals. Admins should independently verify any deposit evidence before approving it.

This setup changes virtual balances only; it does not initiate bank or mobile-money payments. The browser uses only the public anon key, while balance writes are restricted to the database functions in the schema.
