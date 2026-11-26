import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Prisma's datasource is MySQL (prisma/schema.prisma).
 *
 * The previous implementation launched SQLite PRAGMA statements against
 * MySQL on every process startup. Those statements are not supported by
 * MySQL and produced misleading initialization warnings.
 *
 * Database connection and schema errors must not be swallowed: Prisma
 * will report them when the first query runs, and the API error handler
 * will log the complete exception with its diagnostic reference.
 */
function createClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.LOG_QUERIES === '1' ? ['query', 'error'] : ['error'],
  })
}

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
