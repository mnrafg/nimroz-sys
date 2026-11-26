import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { getAuthSecret } from "@/lib/secret";

const SECRET = new TextEncoder().encode(getAuthSecret());

export const SESSION_COOKIE = "aogc_session";

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}

export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export async function createSessionToken(userId: number): Promise<string> {
  return new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(SECRET);
}

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: string;
  roleDari: string;
  checkpointId: number | null;
  checkpointName: string | null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    // Algorithm pinned (V16 fix) — a verify call must never accept tokens
    // signed with anything other than the exactly-configured HS256.
    const { payload } = await jwtVerify(token, SECRET, { algorithms: ["HS256"] });
    const uid = Number(payload.uid);
    if (!uid) return null;
    const user = await db.user.findUnique({
      where: { id: uid },
      include: { role: true, checkpoint: true },
    });
    if (!user || !user.isActive) return null;
    // Session revocation (V16 fix): tokens issued BEFORE the most recent
    // password change are no longer valid, so changing a password (e.g.
    // after suspected theft or admin reset) immediately kills old sessions.
    // 1s grace: JWT iat has second precision while passwordChangedAt has
    // milliseconds — without the grace, a token minted in the same second
    // as the change would be wrongly rejected.
    if (
      user.passwordChangedAt &&
      typeof payload.iat === "number" &&
      payload.iat * 1000 < user.passwordChangedAt.getTime() - 1000
    ) {
      return null;
    }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role.name,
      roleDari: user.role.nameDari,
      checkpointId: user.checkpointId,
      checkpointName: user.checkpoint?.name ?? null,
    };
  } catch {
    return null;
  }
}

export async function logAudit(
  userId: number | null,
  action: string,
  recordType: string,
  recordId: number | null,
  oldValues?: unknown,
  newValues?: unknown
): Promise<void> {
  await db.auditLog.create({
    data: {
      userId,
      action,
      recordType,
      recordId,
      oldValues: oldValues === undefined ? null : JSON.stringify(oldValues),
      newValues: newValues === undefined ? null : JSON.stringify(newValues),
    },
  });
}
