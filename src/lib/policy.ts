import { db, balance } from "@/lib/db";

export interface SpendPolicy {
  autopilot_cents: number;
  monthly_cents: number;
}

export function getPolicy(agentId: string): SpendPolicy {
  const row = db()
    .prepare("SELECT spend_policy FROM agents WHERE id = ?")
    .get(agentId) as { spend_policy: string } | undefined;
  if (!row) throw new Error(`agent not found: ${agentId}`);
  return JSON.parse(row.spend_policy) as SpendPolicy;
}

export type SpendDecision =
  | { action: "autopilot" }
  | { action: "needs_approval"; reason: string }
  | { action: "blocked"; reason: string };

export function decideSpend(agentId: string, amountCents: number): SpendDecision {
  const policy = getPolicy(agentId);
  const bal = balance(agentId);

  if (amountCents > bal) {
    return { action: "blocked", reason: `Insufficient wallet balance: $${(bal / 100).toFixed(2)} available, $${(amountCents / 100).toFixed(2)} requested.` };
  }
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const row = db()
    .prepare(`
      SELECT COALESCE(ABS(SUM(cents)),0) AS spent
      FROM wallet_entries
      WHERE agent_id = ? AND cents < 0 AND created_at >= ?
    `)
    .get(agentId, Math.floor(monthStart.getTime() / 1000)) as { spent: number };
  if (row.spent + amountCents > policy.monthly_cents) {
    return {
      action: "blocked",
      reason: `Monthly allowance cap reached: $${(row.spent / 100).toFixed(2)} of $${(policy.monthly_cents / 100).toFixed(2)} spent this month.`,
    };
  }
  if (amountCents > policy.autopilot_cents) {
    return { action: "needs_approval", reason: `Purchase of $${(amountCents / 100).toFixed(2)} exceeds the $${(policy.autopilot_cents / 100).toFixed(2)} autopilot limit.` };
  }
  return { action: "autopilot" };
}
