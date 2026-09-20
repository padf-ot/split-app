import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { splitStates } from "../../../db/schema";
import { getChatGPTUser } from "../../chatgpt-auth";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ data: null, sync: false });
  try {
    const [row] = await getDb().select().from(splitStates).where(eq(splitStates.userId, user.userId)).limit(1);
    return Response.json({ data: row ? JSON.parse(row.data) : null, sync: true });
  } catch {
    return Response.json({ data: null, sync: false }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Sign in required" }, { status: 401 });
  try {
    const payload = await request.json() as { data?: unknown };
    const serialized = JSON.stringify(payload.data);
    if (!serialized || serialized.length > 500_000) return Response.json({ error: "Invalid state" }, { status: 400 });
    await getDb().insert(splitStates).values({ userId: user.userId, data: serialized, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: splitStates.userId, set: { data: serialized, updatedAt: Date.now() } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "Sync unavailable" }, { status: 503 });
  }
}
