export async function GET() {
  return Response.json(
    { error: "Agent wallet balances are not part of this Venmo-first companion." },
    { status: 410 },
  );
}
