export async function POST() {
  return Response.json(
    { error: "Agent chat is unavailable in this Venmo-first market companion." },
    { status: 410 },
  );
}
