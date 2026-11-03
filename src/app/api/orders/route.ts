export async function POST() {
  return Response.json(
    { error: "Marketplace checkout is unavailable; use the customer's existing Venmo flow." },
    { status: 410 },
  );
}
