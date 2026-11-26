#!/bin/bash

set -euo pipefail
unset DATABASE_URL

SCRIPT_DIR="$(cd "$(dirname "$0")/../.zscripts" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAKE_BIN="$TEST_ROOT/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/bun" <<'EOF'
#!/bin/bash
set -euo pipefail

if [ "$#" -ne 2 ] || [ "$1" != "run" ] || [ "$2" != "db:push" ]; then
    echo "unexpected bun invocation: $*" >&2
    exit 1
fi

case "${DATABASE_URL:-}" in
    file:*) db_path="${DATABASE_URL#file:}" ;;
    *)
        echo "DATABASE_URL must be an absolute SQLite file URL" >&2
        exit 1
        ;;
esac

case "$db_path" in
    /*) ;;
    *)
        echo "database path must be absolute: $db_path" >&2
        exit 1
        ;;
esac

mkdir -p "$(dirname "$db_path")"
if [ ! -f "$db_path" ]; then
    printf 'initialized\n' >"$db_path"
fi
printf '%s\n' "$DATABASE_URL" >>"${DB_PUSH_CALLS:?}"
EOF
chmod +x "$FAKE_BIN/bun"

export PATH="$FAKE_BIN:$PATH"
export DB_PUSH_CALLS="$TEST_ROOT/db-push-calls"

# 没有 Preview 数据库时，应只在部署产物中初始化空库，不修改项目目录。
EMPTY_PROJECT="$TEST_ROOT/empty-project"
EMPTY_BUILD="$TEST_ROOT/empty-build"
mkdir -p "$EMPTY_PROJECT"

PROJECT_DIR="$EMPTY_PROJECT" BUILD_DIR="$EMPTY_BUILD" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"

test -f "$EMPTY_BUILD/db/custom.db"
test "$(cat "$EMPTY_BUILD/db/custom.db")" = "initialized"
test ! -e "$EMPTY_PROJECT/db/custom.db"

# 有 Preview 数据库时，应保留数据和同目录文件，再对产物执行 schema 同步。
EXISTING_PROJECT="$TEST_ROOT/existing-project"
EXISTING_BUILD="$TEST_ROOT/existing-build"
mkdir -p "$EXISTING_PROJECT/db"
printf 'preview-data\n' >"$EXISTING_PROJECT/db/custom.db"
printf 'sidecar\n' >"$EXISTING_PROJECT/db/README.txt"

PROJECT_DIR="$EXISTING_PROJECT" BUILD_DIR="$EXISTING_BUILD" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"

test "$(cat "$EXISTING_BUILD/db/custom.db")" = "preview-data"
test "$(cat "$EXISTING_BUILD/db/README.txt")" = "sidecar"
test "$(wc -l <"$DB_PUSH_CALLS" | tr -d ' ')" = "2"
grep -Fx "file:$EMPTY_BUILD/db/custom.db" "$DB_PUSH_CALLS"
grep -Fx "file:$EXISTING_BUILD/db/custom.db" "$DB_PUSH_CALLS"

# A MySQL schema must never be pushed against an embedded SQLite snapshot.
MYSQL_PROJECT="$TEST_ROOT/mysql-project"
MYSQL_BUILD="$TEST_ROOT/mysql-build"
mkdir -p "$MYSQL_PROJECT/prisma" "$MYSQL_PROJECT/db"
printf 'datasource db {\n  provider = "mysql"\n}\n' >"$MYSQL_PROJECT/prisma/schema.prisma"
printf 'legacy-snapshot\n' >"$MYSQL_PROJECT/db/custom.db"
PROJECT_DIR="$MYSQL_PROJECT" BUILD_DIR="$MYSQL_BUILD" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"
test "$(cat "$MYSQL_BUILD/database-provider")" = "mysql"
test ! -f "$MYSQL_BUILD/db/custom.db"
test "$(cat "$MYSQL_PROJECT/db/custom.db")" = "legacy-snapshot"
test "$(wc -l <"$DB_PUSH_CALLS" | tr -d ' ')" = "2"

MYSQL_ENV_BUILD="$TEST_ROOT/mysql-env-build"
PROJECT_DIR="$EMPTY_PROJECT" BUILD_DIR="$MYSQL_ENV_BUILD" DATABASE_URL="mysql://example.invalid/test" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"
test "$(cat "$MYSQL_ENV_BUILD/database-provider")" = "mysql"
test ! -f "$MYSQL_ENV_BUILD/db/custom.db"
test "$(wc -l <"$DB_PUSH_CALLS" | tr -d ' ')" = "2"

echo "database runtime build tests passed"
