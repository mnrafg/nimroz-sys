#!/bin/bash

set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/z/my-project}"
BUILD_DIR="${BUILD_DIR:?BUILD_DIR is required}"
SOURCE_DB_DIR="$PROJECT_DIR/db"
SOURCE_DB_PATH="$SOURCE_DB_DIR/custom.db"
TARGET_DB_DIR="$BUILD_DIR/db"
TARGET_DB_PATH="$TARGET_DB_DIR/custom.db"

mkdir -p "$TARGET_DB_DIR"

# MySQL state belongs to the configured database, never to a bundled SQLite
# snapshot. ADMS configuration is copied separately with the private server.
CONFIGURED_DATABASE_URL="${DATABASE_URL:-}"
if { [ -f "$PROJECT_DIR/prisma/schema.prisma" ] && grep -Eq '^[[:space:]]*provider[[:space:]]*=[[:space:]]*"mysql"' "$PROJECT_DIR/prisma/schema.prisma"; } ||
    [ "${CONFIGURED_DATABASE_URL%%:*}" = "mysql" ]; then
    printf '%s\n' mysql > "$BUILD_DIR/database-provider"
    echo "MySQL database state is managed outside the release package."
    exit 0
fi

if [ -f "$SOURCE_DB_PATH" ]; then
    echo "🗄️  复制 Preview 数据库到构建产物..."
    cp -a "$SOURCE_DB_DIR/." "$TARGET_DB_DIR/"
else
    echo "ℹ️  未找到 Preview 数据库 db/custom.db，将初始化空的生产数据库"
fi

echo "🗄️  同步构建产物中的数据库结构..."
(
    cd "$PROJECT_DIR"
    DATABASE_URL="file:$TARGET_DB_PATH" bun run db:push
)

if [ ! -f "$TARGET_DB_PATH" ]; then
    echo "❌ 数据库初始化命令执行成功，但未生成 $TARGET_DB_PATH"
    exit 1
fi

echo "✅ 构建产物数据库已准备完成"
ls -lah "$TARGET_DB_DIR"
