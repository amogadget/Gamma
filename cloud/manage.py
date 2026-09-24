"""Gamma Cloud account server CLI — run from ``cloud/``.

  python manage.py setup                         create cloud.db + the signing key
  python manage.py migrate [--status]            upgrade cloud.db (the server does at startup)
  python manage.py backup                        snapshot cloud.db under data/backups/
  python manage.py list-accounts [q]
  python manage.py create-account <email> <username> [--password P] [--plan free] [--admin] [--verified]
  python manage.py set-password <username> <password>
  python manage.py set-admin <username> [--off]
  python manage.py set-plan <username> <free|plus|pro>
  python manage.py verify <username>               mark the e-mail confirmed
  python manage.py delete-account <username>
  python manage.py purge-deleted [--days 30]
  python manage.py invite [--uses 1] [--plan free] [--note ...]
  python manage.py invites
  python manage.py create-client <name> <share-host|container> <redirect_uri>... [--server-id ID]
  python manage.py clients
  python manage.py delete-client <client_id>
  python manage.py rotate-key
"""

import argparse
import getpass
import sys
from contextlib import closing

from gammacloud import accounts, config, db, oidc
from gammacloud.accounts import Problem, make_invite


def _account(conn, username: str):
    account = accounts.by_username(conn, username)
    if not account:
        sys.exit(f"no account with username {username!r}")
    return account


def cmd_setup(args):
    db.ensure_current()
    with closing(db.connect()) as conn:
        kid, _ = oidc.ensure_signing_key(conn)
        conn.commit()
    print(f"cloud.db ready at {config.DB_PATH} (schema v{db.SCHEMA_VERSION}, signing key {kid})")


def cmd_migrate(args):
    version = db.data_version()
    if args.status:
        print(f"cloud.db: {'absent' if version is None else 'v' + str(version)}; code: v{db.SCHEMA_VERSION}")
        return
    done = db.ensure_current()
    print("up to date" if not done else "ran: " + ", ".join(done))


def cmd_backup(args):
    print(db.snapshot("manual"))


def cmd_list(args):
    with closing(db.connect()) as conn:
        like = f"%{(args.q or '').lower()}%"
        rows = conn.execute("SELECT * FROM accounts WHERE username LIKE ? OR email LIKE ? ORDER BY created_at",
                            (like, like)).fetchall()
    for r in rows:
        flags = " ".join(f for f, on in (("admin", r["is_admin"]), ("unverified", not r["email_verified_at"]),
                                         ("deleted", r["deleted_at"])) if on)
        print(f"{r['username']:<20} {r['email']:<32} {r['plan']:<5} {r['created_at'][:10]} {flags}")


def cmd_create(args):
    password = args.password or getpass.getpass("password: ")
    with closing(db.connect()) as conn:
        try:
            account = accounts.create(conn, email=accounts.norm_email(args.email), username=accounts.norm_username(args.username),
                                      password=accounts.check_password(password), plan=args.plan,
                                      verified=args.verified, actor="cli")
            if args.admin:
                accounts.set_admin(conn, account["id"], True, "cli")
        except Problem as e:
            sys.exit(e.detail)
        conn.commit()
    print(f"created {account['username']} ({account['id']})")


def cmd_set_password(args):
    with closing(db.connect()) as conn:
        account = _account(conn, args.username)
        try:
            accounts.set_password(conn, account["id"], accounts.check_password(args.password), actor="cli")
        except Problem as e:
            sys.exit(e.detail)
        conn.commit()
    print("password set; every session and device signed out")


def cmd_set_admin(args):
    with closing(db.connect()) as conn:
        account = _account(conn, args.username)
        accounts.set_admin(conn, account["id"], not args.off, "cli")
        conn.commit()
    print(f"{args.username}: admin {'off' if args.off else 'on'}")


def cmd_set_plan(args):
    with closing(db.connect()) as conn:
        account = _account(conn, args.username)
        try:
            accounts.set_plan(conn, account["id"], args.plan, "cli")
        except Problem as e:
            sys.exit(e.detail)
        conn.commit()
    print(f"{args.username}: {args.plan}")


def cmd_verify(args):
    with closing(db.connect()) as conn:
        account = _account(conn, args.username)
        accounts.mark_verified(conn, account["id"])
        conn.commit()
    print(f"{args.username}: verified")


def cmd_delete(args):
    with closing(db.connect()) as conn:
        account = _account(conn, args.username)
        accounts.delete(conn, account["id"], actor="cli")
        conn.commit()
    print(f"{args.username}: deleted (purged after the grace period by purge-deleted)")


def cmd_purge(args):
    with closing(db.connect()) as conn:
        n = accounts.purge_deleted(conn, args.days)
        conn.commit()
    print(f"purged {n}")


def cmd_invite(args):
    with closing(db.connect()) as conn:
        row = make_invite(conn, uses=args.uses, plan=args.plan, note=args.note or "", created_by="cli")
        conn.commit()
    print(row["code"])


def cmd_invites(args):
    with closing(db.connect()) as conn:
        for r in conn.execute("SELECT * FROM invites ORDER BY created_at").fetchall():
            print(f"{r['code']:<14} uses_left={r['uses_left']:<4} plan={r['plan']:<5} {r['note']}")


def cmd_create_client(args):
    with closing(db.connect()) as conn:
        try:
            client_id, secret = oidc.create_client(conn, name=args.name, kind=args.kind, redirect_uris=args.redirect_uri,
                                                   server_id=args.server_id or "", actor="cli")
        except Problem as e:
            sys.exit(e.detail)
        conn.commit()
    print(f"client_id={client_id}\nclient_secret={secret}\n(the secret is shown once)")


def cmd_clients(args):
    with closing(db.connect()) as conn:
        for r in conn.execute("SELECT * FROM oauth_clients ORDER BY created_at").fetchall():
            print(f"{r['client_id']:<22} {r['kind']:<10} {r['name']:<24} {r['redirect_uris']}")


def cmd_delete_client(args):
    with closing(db.connect()) as conn:
        if not oidc.delete_client(conn, args.client_id, actor="cli"):
            sys.exit("no such client")
        conn.commit()
    print("deleted")


def cmd_rotate_key(args):
    with closing(db.connect()) as conn:
        kid, _ = oidc.rotate_key(conn)
        conn.commit()
    print(f"new signing key {kid}; the previous one stays published for {config.RETIRED_KEY_GRACE // 86400} days")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup").set_defaults(fn=cmd_setup)
    m = sub.add_parser("migrate"); m.add_argument("--status", action="store_true"); m.set_defaults(fn=cmd_migrate)
    sub.add_parser("backup").set_defaults(fn=cmd_backup)
    l = sub.add_parser("list-accounts"); l.add_argument("q", nargs="?"); l.set_defaults(fn=cmd_list)
    c = sub.add_parser("create-account"); c.add_argument("email"); c.add_argument("username")
    c.add_argument("--password"); c.add_argument("--plan", default="free", choices=config.PLANS)
    c.add_argument("--admin", action="store_true"); c.add_argument("--verified", action="store_true"); c.set_defaults(fn=cmd_create)
    s = sub.add_parser("set-password"); s.add_argument("username"); s.add_argument("password"); s.set_defaults(fn=cmd_set_password)
    a = sub.add_parser("set-admin"); a.add_argument("username"); a.add_argument("--off", action="store_true"); a.set_defaults(fn=cmd_set_admin)
    pl = sub.add_parser("set-plan"); pl.add_argument("username"); pl.add_argument("plan", choices=config.PLANS); pl.set_defaults(fn=cmd_set_plan)
    v = sub.add_parser("verify"); v.add_argument("username"); v.set_defaults(fn=cmd_verify)
    d = sub.add_parser("delete-account"); d.add_argument("username"); d.set_defaults(fn=cmd_delete)
    pu = sub.add_parser("purge-deleted"); pu.add_argument("--days", type=int, default=30); pu.set_defaults(fn=cmd_purge)
    i = sub.add_parser("invite"); i.add_argument("--uses", type=int, default=1); i.add_argument("--plan", default="free", choices=config.PLANS)
    i.add_argument("--note"); i.set_defaults(fn=cmd_invite)
    sub.add_parser("invites").set_defaults(fn=cmd_invites)
    cc = sub.add_parser("create-client"); cc.add_argument("name"); cc.add_argument("kind", choices=("share-host", "container"))
    cc.add_argument("redirect_uri", nargs="+"); cc.add_argument("--server-id"); cc.set_defaults(fn=cmd_create_client)
    sub.add_parser("clients").set_defaults(fn=cmd_clients)
    dc = sub.add_parser("delete-client"); dc.add_argument("client_id"); dc.set_defaults(fn=cmd_delete_client)
    sub.add_parser("rotate-key").set_defaults(fn=cmd_rotate_key)
    args = p.parse_args(argv)
    if args.cmd not in ("migrate", "setup"):
        version = db.data_version()
        if version is not None and version < db.SCHEMA_VERSION:
            sys.exit(f"cloud.db is at v{version}, code is v{db.SCHEMA_VERSION}: run `python manage.py migrate` first")
    args.fn(args)


if __name__ == "__main__":
    main()
